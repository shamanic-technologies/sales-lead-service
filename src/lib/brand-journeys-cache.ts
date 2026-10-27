import { sql } from "../db/index.js";

/**
 * The last answer of `GET /internal/brands/:id/timeline-journeys` per (org, brand, offers), served again ONLY while
 * nothing it read has moved (BOX-DB-LOAD-1027-LEAD-2).
 *
 * The read is one aggregate over the brand's whole timeline (1.5 s on average, 8 s on the largest brand under load:
 * the most expensive lead-service statement on the shared box) and its consumer asks the largest brand about twice
 * a minute, while that brand's inputs move a few minutes an hour. Every write to an input of the read
 * (`lead_timeline_facts`, `outreach_facts`, `followup_actions`, `lead_campaign_run_repoints`, and the
 * `leads_campaigns` rows its sends join) notes the org in `journey_input_changes` inside the writer's transaction
 * (migration 0128). An answer remembers the snapshot xmin taken BEFORE it was read; it is served again only if no
 * change of its org carries `txid >= xmin` (the read model's catch-up rule: a transaction still open when the
 * answer was read has a txid at or above that xmin, so a late commit is never missed; a change the answer already
 * saw only costs a recompute). The campaign offers are part of the key, asked of campaign-service on every request.
 * The cached body is the exact bytes the stream wrote, so a hit answers byte for byte what a recompute would.
 */

interface Entry {
  orgId: string;
  xmin: string;
  body: string;
  storedAt: number;
}

/** An answer older than this is recomputed whatever the log says (the change log is pruned after a day). */
export const JOURNEYS_CACHE_MAX_AGE_MS = 60 * 60_000;
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
  heldChars -= e.body.length;
}

/** The held answer for `key` if nothing it read has moved since, else null (and it is forgotten). */
export async function cachedJourneys(key: string, now = Date.now()): Promise<string | null> {
  const e = entries.get(key);
  if (!e) return null;
  if (now - e.storedAt > JOURNEYS_CACHE_MAX_AGE_MS) {
    drop(key);
    return null;
  }
  const moved = await sql<Array<{ moved: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM journey_input_changes WHERE org_id = ${e.orgId} AND txid >= ${e.xmin}::xid8
    ) AS moved
  `;
  if (moved[0].moved) {
    drop(key);
    return null;
  }
  // Most recently used last: eviction takes the oldest first.
  entries.delete(key);
  entries.set(key, e);
  return e.body;
}

/** Remember a COMPLETE answer read under a snapshot whose xmin was `xmin` (taken before the read). */
export function rememberJourneys(key: string, orgId: string, xmin: string, body: string, now = Date.now()): void {
  drop(key);
  if (body.length > MAX_CHARS) return;
  entries.set(key, { orgId, xmin, body, storedAt: now });
  heldChars += body.length;
  for (const [k] of entries) {
    if (heldChars <= MAX_CHARS) break;
    drop(k);
  }
}
