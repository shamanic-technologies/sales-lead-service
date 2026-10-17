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
 *
 * REGISTRY facts are copied BESIDE the events, into `crm_registry_facts` (CRM-REGISTRY-FACTS-1017): crm-service
 * v0.72.0 states on the same feed who a person IS (`connection_tag`: personal or professional to the brand;
 * `organization_link`: the company they speak for; `relation`: in which capacity they deal with the brand), not
 * something they DID. Every reader of `crm_facts` reads a
 * row as an event about the person (an act toward us, a direct conversation, "known to the CRM"), so a registry
 * fact there would have made ~19k group-only people "direct" and everyone "acted toward us". A withdrawal of a
 * registry fact follows it. Same verbatim copy, same transaction, same cursor; only the table differs.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { crmFacts, crmFeedCursors, crmRegistryFacts } from "../db/schema.js";
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
  /** The contact point it happened on (`contactPointOf`). */
  contactPoint: string | null;
}

/**
 * The contact point a fact happened on (PERSON-RELATIONS-1017): crm-service's `contactPoint` (its `presenceStableKey`,
 * byte-equal to a relation's `contactPoints[].id`). A fact crm served before it named one: `<source>:<sourceContactId>`,
 * the same key for every source whose contact id IS its stable id; none = null (the fact belongs to no relation).
 */
export function contactPointOf(raw: Record<string, unknown>, source: string, sourceContactId: string | null): string | null {
  const stated = raw.contactPoint;
  if (typeof stated === "string" && stated.length > 0) return stated;
  return sourceContactId ? `${source}:${sourceContactId}` : null;
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
    contactPoint: contactPointOf(r, str(r, "source", where), nullableStr(r, "sourceContactId", where)),
  };
}

/** Fact types that say who a person IS (crm-service's registry), never something that happened. */
/** `relation` (CRM-RELATION-REGISTRY-1017): one person's capacity toward the brand (personal / professional at a company). */
export const CRM_REGISTRY_FACT_TYPES: ReadonlySet<string> = new Set(["connection_tag", "organization_link", "relation"]);

/**
 * Which facts of a page are registry facts: a registry type, or a `withdrawn` of a registry fact (one in this
 * page, or one already copied: `knownRegistryIds`). Pure; the page order is crm's, so a withdrawal never precedes
 * the fact it withdraws.
 */
export function registryFactIds(facts: readonly CrmFact[], knownRegistryIds: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const f of facts) {
    if (CRM_REGISTRY_FACT_TYPES.has(f.type)) ids.add(f.factId);
    else if (f.type === "withdrawn" && f.withdrawnOf !== null && (ids.has(f.withdrawnOf) || knownRegistryIds.has(f.withdrawnOf))) {
      ids.add(f.factId);
    }
  }
  return ids;
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
    // A withdrawal whose target is not in this page: ask the registry copy (only then, one indexed read).
    const pageIds = new Set(facts.map((f) => f.factId));
    const outsideTargets = facts
      .filter((f) => f.type === "withdrawn" && f.withdrawnOf !== null && !pageIds.has(f.withdrawnOf))
      .map((f) => f.withdrawnOf as string);
    const known = new Set<string>();
    if (outsideTargets.length > 0) {
      const found = (await tx.execute(sql`
        SELECT fact_id FROM crm_registry_facts WHERE fact_id = ANY(${sql.param(outsideTargets)}::text[])
      `)) as unknown as Array<{ fact_id: string }>;
      for (const r of found) known.add(r.fact_id);
    }
    const registry = registryFactIds(facts, known);
    const toRow = (f: CrmFact, i: number) => ({
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
      contactPoint: f.contactPoint,
      raw: page.facts[i] as Record<string, unknown>,
    });
    const indexed = facts.map((f, i) => ({ f, i }));
    const events = indexed.filter(({ f }) => !registry.has(f.factId));
    const registryRows = indexed.filter(({ f }) => registry.has(f.factId));
    if (events.length > 0) {
      const rows = await tx
        .insert(crmFacts)
        .values(events.map(({ f, i }) => toRow(f, i)))
        .onConflictDoNothing({ target: crmFacts.factId })
        .returning({ factId: crmFacts.factId });
      inserted += rows.length;
    }
    if (registryRows.length > 0) {
      const rows = await tx
        .insert(crmRegistryFacts)
        .values(registryRows.map(({ f, i }) => toRow(f, i)))
        .onConflictDoNothing({ target: crmRegistryFacts.factId })
        .returning({ factId: crmRegistryFacts.factId });
      inserted += rows.length;
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

/**
 * One walk of the whole feed from the start that fills `contact_point` on facts copied before crm-service served it
 * (PERSON-RELATIONS-1017, crm-service v0.75.1): crm reads it from its own record, so old facts carry it. Its own
 * cursor; finished once it reached the end (`caught_up_at`), never run again. Writes only `contact_point`.
 */
export const CONTACT_POINT_REWALK_FEED = "people_facts_contact_points" as const;

export async function rewalkContactPoints(maxPages: number = CRM_FACTS_MAX_PAGES_PER_TICK): Promise<{ pages: number; updated: number; done: boolean }> {
  const state = await db
    .select({ cursor: crmFeedCursors.cursor, caughtUpAt: crmFeedCursors.caughtUpAt })
    .from(crmFeedCursors)
    .where(sql`${crmFeedCursors.feed} = ${CONTACT_POINT_REWALK_FEED}`);
  if (state[0]?.caughtUpAt) return { pages: 0, updated: 0, done: true };
  let cursor = state[0]?.cursor ?? null;
  let pages = 0;
  let updated = 0;
  while (pages < maxPages) {
    const page = await fetchCrmFactsPage(cursor, CRM_FACTS_PAGE_SIZE);
    pages++;
    const points = page.facts
      .map((f) => f as Record<string, unknown>)
      .filter((f) => typeof f.factId === "string" && typeof f.contactPoint === "string" && f.contactPoint.length > 0)
      .map((f) => ({ id: f.factId as string, cp: f.contactPoint as string }));
    await db.transaction(async (tx) => {
      if (points.length > 0) {
        const rows = (await tx.execute(sql`
          UPDATE crm_facts f SET contact_point = v.cp
          FROM jsonb_to_recordset(${JSON.stringify(points)}::jsonb) AS v(id text, cp text)
          WHERE f.fact_id = v.id AND f.contact_point IS DISTINCT FROM v.cp
          RETURNING 1
        `)) as unknown as unknown[];
        updated += rows.length;
      }
      if (page.nextCursor !== null) {
        const caughtUp = page.hasMore ? {} : { caughtUpAt: new Date() };
        await tx
          .insert(crmFeedCursors)
          .values({ feed: CONTACT_POINT_REWALK_FEED, cursor: page.nextCursor, ...caughtUp })
          .onConflictDoUpdate({ target: crmFeedCursors.feed, set: { cursor: page.nextCursor, updatedAt: new Date(), ...caughtUp } });
      }
    });
    if (!page.hasMore) return { pages, updated, done: true };
    if (page.nextCursor === null || page.nextCursor === cursor) throw new Error("[lead-service] contact point re-walk: the feed did not move its cursor");
    cursor = page.nextCursor;
  }
  return { pages, updated, done: false };
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
    const w = await rewalkContactPoints();
    if (w.pages > 0) console.log(`[lead-service] crm fact contact points re-walk: pages=${w.pages} updated=${w.updated} done=${w.done}`);
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
