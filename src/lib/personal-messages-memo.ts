/**
 * Every personal-channel message of a brand, per lead, KEPT between reads and brought up to date from
 * what moved since (DASH-SPEED-1110-LEAD-R3).
 *
 * Why. `readPersonalMessages` re-reads the brand's whole message copy on every "who is waiting on us"
 * read: 94.5k WhatsApp/LinkedIn facts on the largest brand, 1.2-1.6 s warm, 32 s under load. Two
 * rewrites of the statement were slower; the lever is not re-reading what did not move.
 *
 * Exact, never a time-to-live. Each read first asks what moved since the kept answer was taken:
 *  - crm facts of the BRAND that arrived after it (`seq`, the producer's feed order, copied in order by
 *    one writer; the brand's own max `seq`, never the table's: read through the post-boot index
 *    `idx_crm_facts_brand_seq`, with an overlap of `SEQ_OVERLAP` deduped by fact id): a new message is
 *    matched to the brand's leads by its own addresses; a WITHDRAWAL rebuilds the whole answer (rare);
 *  - leads of the org whose rows, contact methods or serves changed (`lead_read_changes` kind 'lead',
 *    written in the writer's transaction; `txid >=` the snapshot xmin taken before the kept read, so a
 *    late commit is read again, never skipped): their messages are matched again from their addresses.
 * Anything this cannot see (a brand transfer moving facts between orgs) is caught by the full re-read
 * every `FULL_REREAD_MS`. Same rows as the full statement (`tests/integration/personal-messages-memo-sql.test.ts`).
 *
 * In-process (per HTTP thread), at most `MAX_BRANDS` brands, least recently read out first.
 */
import { sql } from "../db/index.js";
import {
  PERSONAL_MESSAGES_SOURCE,
  readPersonalMessages,
  readPersonalMessagesOfFacts,
  readPersonalMessagesOfLeads,
  type PersonalMessage,
} from "./personal-messages.js";

const SEQ_OVERLAP = 5_000;
const FULL_REREAD_MS = 10 * 60_000;
const MAX_BRANDS = 32;

interface Kept {
  rows: Map<string, PersonalMessage>;
  /** Highest crm fact `seq` OF THE BRAND committed when the kept answer was last brought up to date. */
  seq: number;
  /** Snapshot xmin taken before it: lead changes from transactions at or after it are read again. */
  xmin: string;
  /** Fact ids already looked at inside the overlap window, with their seq. */
  seen: Map<string, number>;
  fullAt: number;
}

const kept = new Map<string, Kept>();

const keyOf = (m: PersonalMessage) => `${m.factId}:${m.leadId}`;

function sorted(rows: Iterable<PersonalMessage>): PersonalMessage[] {
  return [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.factId.localeCompare(b.factId));
}

/** Test-only. */
export function clearPersonalMessagesMemo(): void {
  kept.clear();
}

async function positions(orgId: string, brandId: string): Promise<{ xmin: string; seq: number }> {
  const rows = (await sql`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin,
           COALESCE((SELECT max(seq) FROM crm_facts WHERE org_id = ${orgId} AND brand_id = ${brandId}), 0)::text AS seq
  `) as unknown as Array<{ xmin: string; seq: string }>;
  return { xmin: rows[0].xmin, seq: Number(rows[0].seq) };
}

function remember(key: string, entry: Kept): void {
  kept.delete(key);
  kept.set(key, entry);
  while (kept.size > MAX_BRANDS) kept.delete(kept.keys().next().value as string);
}

/** Reads of one brand bring the kept answer up to date one after the other (never two updates interleaved). */
const inFlight = new Map<string, Promise<unknown>>();

/** Same answer as `readPersonalMessages(orgId, brandId)`, from what is kept plus what moved. */
export function readPersonalMessagesKept(orgId: string, brandId: string): Promise<PersonalMessage[]> {
  const key = `${orgId}:${brandId}`;
  const prior = inFlight.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => bringUpToDate(key, orgId, brandId));
  inFlight.set(key, next);
  void next.finally(() => {
    if (inFlight.get(key) === next) inFlight.delete(key);
  }).catch(() => undefined);
  return next;
}

async function bringUpToDate(key: string, orgId: string, brandId: string): Promise<PersonalMessage[]> {
  // Positions are taken BEFORE anything is read: whatever commits from here on is read next time.
  const at = await positions(orgId, brandId);
  const entry = kept.get(key);
  if (!entry || Date.now() - entry.fullAt > FULL_REREAD_MS) return full(key, orgId, brandId, at);

  const floor = entry.seq - SEQ_OVERLAP;
  const arrived = (await sql`
    SELECT fact_id, type, seq::text AS seq FROM crm_facts
    WHERE seq > ${floor} AND org_id = ${orgId} AND brand_id = ${brandId}
      AND (type = 'withdrawn'
           OR (source = ${PERSONAL_MESSAGES_SOURCE} AND type IN ('message_in', 'message_out')))
  `) as unknown as Array<{ fact_id: string; type: string; seq: string }>;
  const fresh = arrived.filter((f) => !entry.seen.has(f.fact_id));
  if (fresh.some((f) => f.type === "withdrawn")) return full(key, orgId, brandId, at);

  const changed = (await sql`
    SELECT DISTINCT lead_id::text AS lead_id FROM lead_read_changes
    WHERE org_id = ${orgId} AND kind = 'lead' AND lead_id IS NOT NULL AND txid >= ${entry.xmin}::xid8
  `) as unknown as Array<{ lead_id: string }>;
  const changedLeads = new Set(changed.map((r) => r.lead_id));

  const [ofFacts, ofLeads] = await Promise.all([
    readPersonalMessagesOfFacts(orgId, brandId, fresh.map((f) => f.fact_id)),
    readPersonalMessagesOfLeads(orgId, brandId, [...changedLeads]),
  ]);
  for (const [k, m] of entry.rows) if (changedLeads.has(m.leadId)) entry.rows.delete(k);
  for (const m of [...ofFacts, ...ofLeads]) entry.rows.set(keyOf(m), m);

  for (const f of arrived) entry.seen.set(f.fact_id, Number(f.seq));
  const nextSeq = Math.max(entry.seq, at.seq);
  for (const [id, seq] of entry.seen) if (seq <= nextSeq - SEQ_OVERLAP) entry.seen.delete(id);
  entry.seq = nextSeq;
  entry.xmin = at.xmin;
  remember(key, entry);
  return sorted(entry.rows.values());
}

async function full(key: string, orgId: string, brandId: string, at: { xmin: string; seq: number }): Promise<PersonalMessage[]> {
  const rows = await readPersonalMessages(orgId, brandId);
  const seenRows = (await sql`
    SELECT fact_id, seq::text AS seq FROM crm_facts
    WHERE seq > ${at.seq - SEQ_OVERLAP} AND org_id = ${orgId} AND brand_id = ${brandId}
  `) as unknown as Array<{ fact_id: string; seq: string }>;
  // A fact of the overlap window committed after `at` is NOT marked seen: the next read matches it.
  const seen = new Map(seenRows.filter((r) => Number(r.seq) <= at.seq).map((r) => [r.fact_id, Number(r.seq)]));
  remember(key, {
    rows: new Map(rows.map((m) => [keyOf(m), m])),
    seq: at.seq,
    xmin: at.xmin,
    seen,
    fullAt: Date.now(),
  });
  return rows;
}
