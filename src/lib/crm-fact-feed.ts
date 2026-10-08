/**
 * The bronze copy of crm-service's people fact feed (crm-service#61).
 *
 * crm-service says WHAT HAPPENED in the customer's own accounts (their CRM, mailbox, Stripe,
 * PostHog): one dated, untagged fact per thing, in a total order (`seq`). This service says what it
 * MEANS. This module only COPIES: every fact lands in `crm_facts` verbatim (`raw`), append-only, and
 * nothing here tags, maps or reads a fact's meaning. A correction is a new fact (`withdrawn`,
 * `person_merged`, `person_split`), never an update of an old one.
 *
 * The pull walks `GET /internal/people/facts?since=<cursor>` page by page. Each page and the cursor
 * after it are written in ONE transaction, so a crash replays a page at worst, and `fact_id` makes
 * a replay a no-op. A page holding a fact that is not a fact (a field missing or of the wrong kind)
 * fails the whole page LOUD and the cursor does not move: skipping it would lose a fact for good.
 *
 * Disconnecting a source on the crm side stops new facts and withdraws nothing (owner 2026-10-08);
 * what was already copied here keeps counting.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { crmFacts, crmFeedCursors } from "../db/schema.js";
import { fetchCrmFactsPage, type CrmFactsPage } from "./crm-client.js";

/** The one feed this service follows. A cursor row per feed, so a second feed is a second row. */
export const PEOPLE_FACTS_FEED = "people_facts" as const;

/** How often the pull asks for new facts. Cheap when there are none: one empty page. */
export const CRM_FACT_FEED_INTERVAL_MS = 2 * 60_000;
const FIRST_PULL_DELAY_MS = 45_000;

/** Facts asked per page, and pages per tick (a first backfill spans several ticks). */
export const CRM_FACTS_PAGE_SIZE = 500;
export const CRM_FACTS_MAX_PAGES_PER_TICK = 200;

/** One fact, as crm-service emits it. */
export interface CrmFact {
  factId: string;
  seq: string;
  orgId: string;
  brandId: string;
  personKey: string;
  sourceContactId: string | null;
  /** crm-service's own contact row id (the key CRM pairings are frozen on), null when none. */
  crmContactId: string | null;
  fullName: string | null;
  emails: string[];
  phones: string[];
  type: string;
  occurredAt: string | null;
  dateBasis: string;
  source: string;
  sourceRef: string;
  payload: Record<string, unknown>;
  withdrawnOf: string | null;
}

export class CrmFactParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmFactParseError";
  }
}

function str(raw: Record<string, unknown>, key: string, where: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new CrmFactParseError(`${where}: \`${key}\` must be a non-empty string`);
  }
  return v;
}

function nullableStr(raw: Record<string, unknown>, key: string, where: string): string | null {
  const v = raw[key];
  if (v === null) return null;
  if (typeof v !== "string") throw new CrmFactParseError(`${where}: \`${key}\` must be a string or null`);
  return v;
}

function strArray(raw: Record<string, unknown>, key: string, where: string): string[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new CrmFactParseError(`${where}: \`${key}\` must be an array of strings`);
  }
  return v as string[];
}

/**
 * Read one fact off the wire. Every field the contract names is required with its kind; nothing is
 * defaulted. The fact TYPE is not checked against a list: naming facts is crm-service's, and a type
 * this service does not read yet is still a fact worth keeping.
 */
export function parseCrmFact(raw: unknown): CrmFact {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CrmFactParseError("a fact must be an object");
  }
  const r = raw as Record<string, unknown>;
  const factId = str(r, "factId", "fact");
  const where = `fact ${factId}`;
  const seq = str(r, "seq", where);
  if (!/^\d+$/.test(seq)) throw new CrmFactParseError(`${where}: \`seq\` must be a decimal integer`);
  const occurredAt = nullableStr(r, "occurredAt", where);
  if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) {
    throw new CrmFactParseError(`${where}: \`occurredAt\` is not a date`);
  }
  if (!("sourceContactId" in r)) throw new CrmFactParseError(`${where}: \`sourceContactId\` is missing`);
  if (!("fullName" in r)) throw new CrmFactParseError(`${where}: \`fullName\` is missing`);
  if (!("crmContactId" in r)) throw new CrmFactParseError(`${where}: \`crmContactId\` is missing`);
  const payload = r.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new CrmFactParseError(`${where}: \`payload\` must be an object`);
  }
  const type = str(r, "type", where);
  const withdrawnOf = r.withdrawnOf === undefined ? null : nullableStr(r, "withdrawnOf", where);
  if (type === "withdrawn" && withdrawnOf === null) {
    throw new CrmFactParseError(`${where}: a \`withdrawn\` fact must name \`withdrawnOf\``);
  }
  return {
    factId,
    seq,
    orgId: str(r, "orgId", where),
    brandId: str(r, "brandId", where),
    personKey: str(r, "personKey", where),
    sourceContactId: nullableStr(r, "sourceContactId", where),
    crmContactId: nullableStr(r, "crmContactId", where),
    fullName: nullableStr(r, "fullName", where),
    emails: strArray(r, "emails", where),
    phones: strArray(r, "phones", where),
    type,
    occurredAt,
    dateBasis: str(r, "dateBasis", where),
    source: str(r, "source", where),
    sourceRef: str(r, "sourceRef", where),
    payload: payload as Record<string, unknown>,
    withdrawnOf,
  };
}

/** Where the pull stopped, or null before the first fact was ever copied (the backfill). */
export async function loadFeedCursor(feed: string = PEOPLE_FACTS_FEED): Promise<string | null> {
  const rows = await db.select({ cursor: crmFeedCursors.cursor }).from(crmFeedCursors).where(sql`${crmFeedCursors.feed} = ${feed}`);
  return rows[0]?.cursor ?? null;
}

/**
 * Copy one page and move the cursor past it, in one transaction. Parsing happens BEFORE anything is
 * written, so a page with one unreadable fact writes nothing and leaves the cursor where it was.
 * Returns how many facts were new (a replayed page copies none).
 */
export async function ingestFactsPage(
  page: CrmFactsPage,
  feed: string = PEOPLE_FACTS_FEED,
): Promise<number> {
  const facts = page.facts.map(parseCrmFact);
  return db.transaction(async (tx) => {
    let inserted = 0;
    if (facts.length > 0) {
      const rows = await tx
        .insert(crmFacts)
        .values(
          facts.map((f, i) => ({
            factId: f.factId,
            seq: BigInt(f.seq),
            orgId: f.orgId,
            brandId: f.brandId,
            personKey: f.personKey,
            sourceContactId: f.sourceContactId,
            crmContactId: f.crmContactId,
            fullName: f.fullName,
            emails: f.emails,
            phones: f.phones,
            type: f.type,
            occurredAt: f.occurredAt === null ? null : new Date(f.occurredAt),
            dateBasis: f.dateBasis,
            source: f.source,
            sourceRef: f.sourceRef,
            payload: f.payload,
            withdrawnOf: f.withdrawnOf,
            raw: page.facts[i] as Record<string, unknown>,
          })),
        )
        .onConflictDoNothing({ target: crmFacts.factId })
        .returning({ factId: crmFacts.factId });
      inserted = rows.length;
    }
    if (page.nextCursor !== null) {
      // Reaching the end of the feed is what makes the copy whole; a page short of it keeps any
      // earlier `caught_up_at` (routine pulls only ever ADD facts to a whole copy).
      const caughtUp = page.hasMore ? {} : { caughtUpAt: new Date() };
      await tx
        .insert(crmFeedCursors)
        .values({ feed, cursor: page.nextCursor, ...caughtUp })
        .onConflictDoUpdate({
          target: crmFeedCursors.feed,
          set: { cursor: page.nextCursor, updatedAt: new Date(), ...caughtUp },
        });
    }
    return inserted;
  });
}

export interface CrmFactPullResult {
  pages: number;
  received: number;
  inserted: number;
  /** True when the tick stopped on its page budget with more waiting (the next tick continues). */
  budgetReached: boolean;
}

/** Walk the feed from where it stopped until crm-service says there is nothing more. */
export async function pullCrmFacts(
  maxPages: number = CRM_FACTS_MAX_PAGES_PER_TICK,
): Promise<CrmFactPullResult> {
  const result: CrmFactPullResult = { pages: 0, received: 0, inserted: 0, budgetReached: false };
  let cursor = await loadFeedCursor();
  for (;;) {
    if (result.pages >= maxPages) {
      result.budgetReached = true;
      return result;
    }
    const page = await fetchCrmFactsPage(cursor, CRM_FACTS_PAGE_SIZE);
    result.pages += 1;
    result.received += page.facts.length;
    result.inserted += await ingestFactsPage(page);
    if (!page.hasMore) return result;
    if (page.nextCursor === null || page.nextCursor === cursor) {
      throw new Error(
        `[lead-service] crm fact feed said hasMore but did not move its cursor (${cursor ?? "start"}): ` +
          "refusing to loop on the same page",
      );
    }
    cursor = page.nextCursor;
  }
}

let pulling = false;

export async function tickCrmFactFeed(): Promise<void> {
  if (pulling) return;
  pulling = true;
  try {
    const r = await pullCrmFacts();
    if (r.received > 0 || r.budgetReached) {
      console.log(
        `[lead-service] crm fact feed: pages=${r.pages} received=${r.received} inserted=${r.inserted}` +
          (r.budgetReached ? " (page budget reached, continuing next tick)" : ""),
      );
    }
  } finally {
    pulling = false;
  }
}

export function startCrmFactFeedWorker(): void {
  const tick = () => {
    tickCrmFactFeed().catch((error) =>
      console.error("[lead-service] crm fact feed pull failed, cursor unchanged:", error),
    );
  };
  setTimeout(tick, FIRST_PULL_DELAY_MS).unref();
  setInterval(tick, CRM_FACT_FEED_INTERVAL_MS).unref();
}
