/**
 * The bronze copy of instantly-service's outreach fact feed (`GET /internal/outreach-facts`,
 * instantly-service#1022): every email we sent, every open, click, bounce, unsubscribe and reply
 * with its verdict, in a total order (`seq`).
 *
 * This module only COPIES, exactly like the crm fact feed (crm-fact-feed.ts): every fact lands in
 * `outreach_facts` verbatim (`raw`), append-only, and a correction is a new fact naming the one it
 * supersedes. A page and the cursor after it are written in ONE transaction, so a crash replays a
 * page at worst and `seq` makes the replay a no-op. A fact missing a field the contract names fails
 * the whole page LOUD and the cursor stays: skipping it would lose a fact for good. What a fact
 * MEANS is decided in timeline-facts.ts / timeline-labels.ts.
 */
import { INSTANTLY_SERVICE_API_KEY, INSTANTLY_SERVICE_URL } from "../config.js";
import { sql } from "../db/index.js";
import { fetchWithRetry } from "./fetch-retry.js";

export const OUTREACH_FACTS_FEED = "outreach_facts" as const;
export const OUTREACH_FACT_FEED_INTERVAL_MS = 2 * 60_000;
const FIRST_PULL_DELAY_MS = 30_000;
export const OUTREACH_FACTS_PAGE_SIZE = 1000;
export const OUTREACH_FACTS_MAX_PAGES_PER_TICK = 400;

export interface OutreachFactsPage {
  facts: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** The fields every read keys on, lifted off one raw fact. */
export interface OutreachFact {
  seq: string;
  subjectKey: string;
  supersedesSeq: string | null;
  type: string;
  occurredAt: string | null;
  leadEmail: string;
  orgId: string;
  campaignId: string | null;
  brandIds: string[];
}

export class OutreachFactParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachFactParseError";
  }
}

function str(r: Record<string, unknown>, key: string, where: string): string {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) throw new OutreachFactParseError(`${where}: \`${key}\` must be a non-empty string`);
  return v;
}

function nullableStr(r: Record<string, unknown>, key: string, where: string): string | null {
  if (!(key in r)) throw new OutreachFactParseError(`${where}: \`${key}\` is missing`);
  const v = r[key];
  if (v === null) return null;
  if (typeof v !== "string") throw new OutreachFactParseError(`${where}: \`${key}\` must be a string or null`);
  return v;
}

/** Read one fact off the wire. The type is not checked against a list: naming facts is the producer's. */
export function parseOutreachFact(raw: unknown): OutreachFact {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new OutreachFactParseError("a fact must be an object");
  const r = raw as Record<string, unknown>;
  const seq = str(r, "seq", "fact");
  if (!/^\d+$/.test(seq)) throw new OutreachFactParseError(`fact: \`seq\` must be a decimal integer`);
  const where = `fact ${seq}`;
  const supersedesSeq = nullableStr(r, "supersedesSeq", where);
  if (supersedesSeq !== null && !/^\d+$/.test(supersedesSeq)) throw new OutreachFactParseError(`${where}: \`supersedesSeq\` must be digits`);
  const occurredAt = nullableStr(r, "occurredAt", where);
  if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) throw new OutreachFactParseError(`${where}: \`occurredAt\` is not a date`);
  const brandIds = r.brandIds;
  if (!Array.isArray(brandIds) || brandIds.some((b) => typeof b !== "string")) {
    throw new OutreachFactParseError(`${where}: \`brandIds\` must be an array of strings`);
  }
  return {
    seq,
    subjectKey: str(r, "subjectKey", where),
    supersedesSeq,
    type: str(r, "type", where),
    occurredAt,
    leadEmail: str(r, "leadEmail", where).toLowerCase(),
    orgId: str(r, "orgId", where),
    campaignId: nullableStr(r, "campaignId", where),
    brandIds: brandIds as string[],
  };
}

export async function fetchOutreachFactsPage(cursor: string | null, limit: number): Promise<OutreachFactsPage> {
  const path = `/internal/outreach-facts?limit=${limit}` + (cursor === null ? "" : `&since=${encodeURIComponent(cursor)}`);
  let response: Response;
  try {
    response = await fetchWithRetry(`${INSTANTLY_SERVICE_URL}${path}`, {
      method: "GET",
      headers: { "X-API-Key": INSTANTLY_SERVICE_API_KEY },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`[outreach-fact-feed] instantly-service unreachable for ${path}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`[outreach-fact-feed] instantly-service ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
  const body = (await response.json()) as { facts?: unknown; nextCursor?: unknown; hasMore?: unknown };
  if (!Array.isArray(body.facts)) throw new Error(`[outreach-fact-feed] ${path} answered with no facts array`);
  if (typeof body.hasMore !== "boolean") throw new Error(`[outreach-fact-feed] ${path} answered with no hasMore`);
  if (body.nextCursor !== null && typeof body.nextCursor !== "string") {
    throw new Error(`[outreach-fact-feed] ${path} answered with an unreadable nextCursor`);
  }
  return { facts: body.facts, nextCursor: body.nextCursor, hasMore: body.hasMore };
}

export async function loadOutreachFeedState(): Promise<{ cursor: string | null; caughtUp: boolean }> {
  const rows = (await sql`
    SELECT cursor, caught_up_at FROM crm_feed_cursors WHERE feed = ${OUTREACH_FACTS_FEED}
  `) as unknown as Array<{ cursor: string; caught_up_at: Date | string | null }>;
  return { cursor: rows[0]?.cursor ?? null, caughtUp: rows[0]?.caught_up_at != null };
}

/** Copy one page and move the cursor past it, in one transaction. Returns how many facts were new. */
export async function ingestOutreachFactsPage(page: OutreachFactsPage): Promise<number> {
  const facts = page.facts.map(parseOutreachFact);
  const rows = facts.map((f, i) => ({
    seq: f.seq,
    subject_key: f.subjectKey,
    supersedes_seq: f.supersedesSeq,
    type: f.type,
    occurred_at: f.occurredAt,
    lead_email: f.leadEmail,
    org_id: f.orgId,
    campaign_id: f.campaignId,
    brand_ids: f.brandIds,
    raw: page.facts[i],
  }));
  return sql.begin(async (txn) => {
    // postgres.js types a transaction without its call signature; it is the same tagged template.
    const tx = txn as unknown as typeof sql;
    let inserted = 0;
    if (rows.length > 0) {
      const result = await tx`
        INSERT INTO outreach_facts (seq, subject_key, supersedes_seq, type, occurred_at, lead_email,
          org_id, campaign_id, brand_ids, raw)
        SELECT x.seq::bigint, x.subject_key, x.supersedes_seq::bigint, x.type, x.occurred_at::timestamptz,
          x.lead_email, x.org_id, x.campaign_id,
          ARRAY(SELECT jsonb_array_elements_text(x.brand_ids)), x.raw
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(seq text, subject_key text,
          supersedes_seq text, type text, occurred_at text, lead_email text, org_id text,
          campaign_id text, brand_ids jsonb, raw jsonb)
        ON CONFLICT (seq) DO NOTHING
      `;
      inserted = result.count;
    }
    if (page.nextCursor !== null) {
      // Reaching the end of the feed is what makes the copy whole; the timeline refuses to read a
      // copy that never got there (it would read a brand's sends as absent).
      await tx`
        INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at)
        VALUES (${OUTREACH_FACTS_FEED}, ${page.nextCursor}, ${page.hasMore ? null : new Date().toISOString()}::timestamptz)
        ON CONFLICT (feed) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now(),
          caught_up_at = COALESCE(EXCLUDED.caught_up_at, crm_feed_cursors.caught_up_at)
      `;
    }
    return inserted;
  });
}

export async function pullOutreachFacts(
  maxPages: number = OUTREACH_FACTS_MAX_PAGES_PER_TICK,
): Promise<{ pages: number; received: number; inserted: number; budgetReached: boolean }> {
  const result = { pages: 0, received: 0, inserted: 0, budgetReached: false };
  let { cursor } = await loadOutreachFeedState();
  for (;;) {
    if (result.pages >= maxPages) {
      result.budgetReached = true;
      return result;
    }
    const page = await fetchOutreachFactsPage(cursor, OUTREACH_FACTS_PAGE_SIZE);
    result.pages += 1;
    result.received += page.facts.length;
    result.inserted += await ingestOutreachFactsPage(page);
    if (!page.hasMore) return result;
    if (page.nextCursor === null || page.nextCursor === cursor) {
      throw new Error(`[outreach-fact-feed] feed said hasMore but did not move its cursor (${cursor ?? "start"})`);
    }
    cursor = page.nextCursor;
  }
}

let pulling = false;

export async function tickOutreachFactFeed(): Promise<void> {
  if (pulling) return;
  pulling = true;
  try {
    const r = await pullOutreachFacts();
    if (r.received > 0 || r.budgetReached) {
      console.log(
        `[lead-service] outreach fact feed: pages=${r.pages} received=${r.received} inserted=${r.inserted}` +
          (r.budgetReached ? " (page budget reached, continuing next tick)" : ""),
      );
    }
  } finally {
    pulling = false;
  }
}

export function startOutreachFactFeedWorker(): void {
  const tick = () => {
    tickOutreachFactFeed().catch((error) =>
      console.error("[lead-service] outreach fact feed pull failed, cursor unchanged:", error),
    );
  };
  setTimeout(tick, FIRST_PULL_DELAY_MS).unref();
  setInterval(tick, OUTREACH_FACT_FEED_INTERVAL_MS).unref();
}
