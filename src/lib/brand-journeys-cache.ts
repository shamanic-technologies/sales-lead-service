import { sql } from "../db/index.js";

/**
 * The last answer of `GET /internal/brands/:id/timeline-journeys` per (org, brand, offers), kept PER LEAD and brought
 * up to date from what moved (BOX-DB-LOAD-1027-LEAD-2, DASH-SPEED-1110-LEAD-R4).
 *
 * The read is one aggregate over the brand's whole timeline (1-3 s, 142k buffers on the largest brand) and its consumer
 * asks the largest brands about twice a minute. Every write to an input of the read (`lead_timeline_facts`,
 * `outreach_facts`, `followup_actions`, `lead_campaign_run_repoints`, and the `leads_campaigns` rows its sends join)
 * notes the org in `journey_input_changes` inside the writer's transaction, with the LEAD it moves (or the outreach
 * subject, resolved at read time to the lead of the timeline row it feeds; migration 0144; neither = the whole org).
 * An answer remembers the snapshot xmin taken BEFORE it was read; a change of its org with `txid >= xmin` moved it (the
 * read model's catch-up rule: a transaction still open at that read has a txid at or above that xmin, so a late commit
 * is never missed). The held journeys of exactly those leads are re-read by the same statement narrowed to them
 * (`streamBrandJourneys(..., leadIds)`; a journey is one lead's, so theirs come out byte for byte as the whole read
 * would) and the body is re-assembled in the statement's order (lead id, then offer, nulls first: each lead's
 * journeys as the statement returns them, leads in uuid text order, which `en_US` sorts as bytes: checked on prod).
 * The campaign offers are part of the key, asked of campaign-service on every request.
 */

export interface LeadJourneys {
  /** The lead's journeys as the stream writes them, comma-joined. */
  json: string;
  count: number;
  facts: number;
}

interface Entry {
  orgId: string;
  brandId: string;
  xmin: string;
  readAt: number;
  leads: Map<string, LeadJourneys>;
  /** Lead ids in body order, null = to sort again. */
  order: string[] | null;
  /** The assembled body, null = to assemble again. */
  body: string | null;
  /** Moves whenever the body does: names the gzipped bytes kept for it (gzip-body-cache.ts). */
  version: number;
  chars: number;
}

export interface HeldJourneys {
  body: string;
  /** A key naming exactly this body: a new body gets a new key. */
  bodyKey: string;
}

let versions = 0;

/**
 * Reads of ONE key run one after the other (ten identical reads at once used to re-read the brand ten times): the
 * first brings the answer up to date, the next ones find it held. Per key, so other brands never wait.
 */
const queues = new Map<string, Promise<unknown>>();
export async function withJourneysKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(fn);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}

/** An answer older than this is re-read whole whatever the log says (the change log is pruned after a day). */
export const JOURNEYS_CACHE_MAX_AGE_MS = 60 * 60_000;
/** More moved leads than this: one whole read beats the narrowed one. */
export const JOURNEYS_MAX_MOVED_LEADS = 2_000;
/** Total characters held (the largest brand's answer is ~20M characters). */
const MAX_CHARS = Math.max(0, Number(process.env.JOURNEYS_CACHE_MAX_CHARS) || 120_000_000);

const entries = new Map<string, Entry>();
let heldChars = 0;

/** Test seam. */
export function resetJourneysCache(): void {
  entries.clear();
  heldChars = 0;
}

/** The cache key: org, brand and the campaign -> offer map the read was given (sorted, so its order never matters). */
export function journeysCacheKey(orgId: string, brandId: string, offers: ReadonlyMap<string, string | null>): string {
  const pairs = [...offers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([orgId, brandId, pairs]);
}

/** The snapshot xmin to remember with an answer: taken BEFORE the answer is read. */
export async function journeysSnapshotXmin(): Promise<string> {
  const rows = await sql<Array<{ xmin: string }>>`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`;
  return rows[0].xmin;
}

function drop(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  entries.delete(key);
  heldChars -= e.chars;
}

/** PURE: the body the stream writes, from each lead's journeys in body order. */
export function assembleJourneysBody(brandId: string, order: readonly string[], leads: ReadonlyMap<string, LeadJourneys>): string {
  const parts: string[] = [];
  let count = 0;
  let facts = 0;
  for (const id of order) {
    const l = leads.get(id)!;
    parts.push(l.json);
    count += l.count;
    facts += l.facts;
  }
  return `{"brandId":${JSON.stringify(brandId)},"journeys":[${parts.join(",")}],"count":${count},"factCount":${facts}}`;
}

/** What moved for the org since `xmin`: null = nothing, "all" = the whole answer, else the leads. */
export async function journeysMovedSince(orgId: string, brandId: string, xmin: string): Promise<null | "all" | Set<string>> {
  const rows = await sql<Array<{ lead_id: string | null; subject_key: string | null }>>`
    SELECT DISTINCT lead_id::text AS lead_id, subject_key FROM journey_input_changes
    WHERE org_id = ${orgId} AND txid >= ${xmin}::xid8
  `;
  if (rows.length === 0) return null;
  const leads = new Set<string>();
  const subjects: string[] = [];
  for (const r of rows) {
    if (r.lead_id === null && r.subject_key === null) return "all";
    if (r.lead_id !== null) leads.add(r.lead_id);
    if (r.subject_key !== null) subjects.push(r.subject_key);
  }
  if (subjects.length > 0) {
    const fed = await sql<Array<{ lead_id: string }>>`
      SELECT DISTINCT lead_id::text AS lead_id FROM lead_timeline_facts
      WHERE id = ANY(${subjects}) AND org_id = ${orgId} AND brand_id = ${brandId}
    `;
    for (const r of fed) leads.add(r.lead_id);
  }
  return leads.size > JOURNEYS_MAX_MOVED_LEADS ? "all" : leads;
}

/** The held answer: null = none (or too old), else the entry to serve or bring up to date. */
function heldEntry(key: string, now: number): Entry | null {
  const e = entries.get(key);
  if (!e) return null;
  if (now - e.readAt > JOURNEYS_CACHE_MAX_AGE_MS) {
    drop(key);
    return null;
  }
  return e;
}

function bodyOf(e: Entry): string {
  if (e.order === null) e.order = [...e.leads.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (e.body === null) {
    e.body = assembleJourneysBody(e.brandId, e.order, e.leads);
    heldChars -= e.chars;
    e.chars = e.body.length * 2;
    heldChars += e.chars;
  }
  return e.body;
}

function touch(key: string, e: Entry): void {
  entries.delete(key);
  entries.set(key, e);
  for (const [k] of entries) {
    if (heldChars <= MAX_CHARS) break;
    if (k === key) continue;
    drop(k);
  }
  if (heldChars > MAX_CHARS) drop(key);
}

/**
 * The held answer for `key` brought up to date, or null (none held, too old, or the whole org moved: read it whole).
 * `reread(leadIds)` re-reads those leads' journeys (keyed by lead; a lead absent from the answer has none left).
 */
export async function cachedJourneys(
  key: string,
  reread: (leadIds: readonly string[]) => Promise<Map<string, LeadJourneys>>,
  now = Date.now(),
): Promise<HeldJourneys | null> {
  const e = heldEntry(key, now);
  if (!e) return null;
  // Taken BEFORE the log and the leads are read: a write still open now carries a txid at or above it.
  const xmin = await journeysSnapshotXmin();
  const moved = await journeysMovedSince(e.orgId, e.brandId, e.xmin);
  if (moved === "all") {
    drop(key);
    return null;
  }
  if (moved !== null && moved.size > 0) {
    const fresh = await reread([...moved]);
    let added = false;
    for (const id of moved) {
      const j = fresh.get(id);
      if (j) {
        if (!e.leads.has(id)) added = true;
        e.leads.set(id, j);
      } else if (e.leads.delete(id)) {
        e.order = null;
      }
    }
    if (added) e.order = null;
    e.body = null;
    e.version = ++versions;
  }
  e.xmin = xmin;
  const body = bodyOf(e);
  touch(key, e);
  return { body, bodyKey: `journeys:${e.version}` };
}

/** Remember a COMPLETE answer, per lead, read under a snapshot whose xmin was `xmin` (taken before the read). */
export function rememberJourneys(
  key: string,
  orgId: string,
  brandId: string,
  xmin: string,
  leads: Map<string, LeadJourneys>,
  order: string[],
  body: string,
  now = Date.now(),
): void {
  drop(key);
  const e: Entry = { orgId, brandId, xmin, readAt: now, leads, order, body, version: ++versions, chars: body.length * 2 };
  if (e.chars > MAX_CHARS) return;
  entries.set(key, e);
  heldChars += e.chars;
  touch(key, e);
}
