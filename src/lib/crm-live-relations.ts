import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * The brand's LIVE crm relations (fact `relation`, not withdrawn), kept per brand and brought up to date from what was
 * copied since (DASH-SPEED-1110-LEAD-R4).
 *
 * The relationship sweep read them whole on every pass for every brand: 415k relation facts of the largest brand (41k
 * live), anti-joined to 713k withdrawals, ~780 ms a call on the shared box, while ~70 registry facts a HOUR arrive
 * fleet-wide. Every write to the registry copy notes the LOWEST seq it wrote, in the writer's transaction
 * (`crm_registry_fact_changes`, migration 0144); an UPDATE or DELETE (a brand transfer) notes "re-read all". A kept list
 * remembers the snapshot xmin taken BEFORE it was read. To bring it up to date: every change with `txid >= xmin` (a
 * transaction still open at that read carries a txid at or above it, so a copy committing late is never missed) gives
 * the seq to re-read from; the facts copied from there (through the seq index) are applied: a live relation of the
 * brand is (re)kept, one that left the brand dropped, a withdrawal drops its target. Exact, no time window; a list
 * older than an hour is re-read whole (the change log is pruned after a day).
 */

export interface LiveRelationRow {
  fact_id: string;
  human: string | null;
  person_key: string;
  name: string | null;
  seq: string;
  payload: Record<string, unknown>;
}

interface Kept {
  xmin: string;
  readAt: number;
  rows: Map<string, LiveRelationRow>;
}

export const LIVE_RELATIONS_MAX_AGE_MS = 60 * 60_000;
/** Brands kept per thread (the largest is ~41k rows, ~30 MB). */
const MAX_SCOPES = 200;

const kept = new Map<string, Kept>();

/** Test seam. */
export function resetLiveRelations(): void {
  kept.clear();
}

const keyOf = (orgId: string, brandId: string) => `${orgId}\u0000${brandId}`;

const humanSql = sql`CASE WHEN f.raw->>'humanId' ~* '^[0-9a-f-]{36}$' THEN f.raw->>'humanId' END`;

/**
 * Only what the sweep reads of a relation's payload (capacity, its own tags, relation key, company, contact point ids,
 * emails, phones), same shapes, so a kept brand costs a fraction of its raw payloads.
 */
export function trimRelationPayload(p: Record<string, unknown> | null): Record<string, unknown> {
  const v = p ?? {};
  const out: Record<string, unknown> = {};
  if ("capacity" in v) out.capacity = v.capacity;
  if (Array.isArray(v.tags)) out.tags = (v.tags as Array<{ tag?: unknown } | null>).map((t) => ({ tag: t?.tag }));
  if ("relationKey" in v) out.relationKey = v.relationKey;
  if ("companyId" in v) out.companyId = v.companyId;
  if (Array.isArray(v.contactPoints)) out.contactPoints = (v.contactPoints as Array<{ id?: unknown } | null>).map((c) => ({ id: c?.id }));
  if ("emails" in v) out.emails = v.emails;
  if ("phones" in v) out.phones = v.phones;
  return out;
}

const trimmed = (r: LiveRelationRow): LiveRelationRow => ({ ...r, payload: trimRelationPayload(r.payload) });

async function snapshotXmin(): Promise<string> {
  const rows = (await db.execute(sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`)) as unknown as Array<{ xmin: string }>;
  return rows[0].xmin;
}

/** The whole read, as the sweep ran it before (the planner's anti-join over the withdrawn index). */
async function readAll(orgId: string, brandId: string): Promise<Map<string, LiveRelationRow>> {
  const rows = (await db.execute(sql`
    SELECT f.fact_id, ${humanSql} AS human, f.person_key, f.full_name AS name, f.seq::text AS seq, f.payload
    FROM crm_registry_facts f
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId} AND f.type = 'relation'
      AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id)
  `)) as unknown as LiveRelationRow[];
  return new Map(rows.map((r) => [r.fact_id, trimmed(r)]));
}

/** What moved since `xmin`: null = nothing, `"all"` = re-read whole, else the lowest seq written. */
async function movedSince(xmin: string): Promise<null | "all" | string> {
  const rows = (await db.execute(sql`
    SELECT bool_or(full_reload) AS full_reload, min(min_seq)::text AS from_seq, count(*)::int AS n
    FROM crm_registry_fact_changes WHERE txid >= ${xmin}::xid8
  `)) as unknown as Array<{ full_reload: boolean | null; from_seq: string | null; n: number }>;
  const r = rows[0];
  if (!r || r.n === 0) return null;
  if (r.full_reload) return "all";
  return r.from_seq;
}

async function applySince(orgId: string, brandId: string, fromSeq: string, rows: Map<string, LiveRelationRow>): Promise<void> {
  // Everything copied from that seq on, fleet-wide, through the seq index (a few rows an hour); the brand filter is
  // applied here so a relation that LEFT the brand is seen too.
  const facts = (await db.execute(sql`
    SELECT f.fact_id, f.org_id, f.brand_id, f.type, f.withdrawn_of, ${humanSql} AS human, f.person_key,
      f.full_name AS name, f.seq::text AS seq, f.payload,
      EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id OFFSET 0) AS withdrawn
    FROM crm_registry_facts f
    WHERE f.seq >= ${fromSeq}::bigint
    ORDER BY f.seq
  `)) as unknown as Array<LiveRelationRow & { org_id: string; brand_id: string; type: string; withdrawn_of: string | null; withdrawn: boolean }>;
  for (const f of facts) {
    if (f.type === "relation") {
      if (f.org_id === orgId && f.brand_id === brandId && !f.withdrawn) {
        rows.set(f.fact_id, trimmed({ fact_id: f.fact_id, human: f.human, person_key: f.person_key, name: f.name, seq: f.seq, payload: f.payload }));
      } else {
        rows.delete(f.fact_id);
      }
    }
  }
  for (const f of facts) if (f.withdrawn_of) rows.delete(f.withdrawn_of);
}

/** The brand's live relations, as the whole read answers them now. */
export async function liveRelationRows(orgId: string, brandId: string, now = Date.now()): Promise<LiveRelationRow[]> {
  const key = keyOf(orgId, brandId);
  const held = kept.get(key);
  // Taken BEFORE anything is read: a write still open now carries a txid at or above it.
  const xmin = await snapshotXmin();
  if (held && now - held.readAt < LIVE_RELATIONS_MAX_AGE_MS) {
    const moved = await movedSince(held.xmin);
    if (moved !== "all") {
      if (moved !== null) await applySince(orgId, brandId, moved, held.rows);
      held.xmin = xmin;
      kept.delete(key);
      kept.set(key, held);
      return [...held.rows.values()];
    }
  }
  const rows = await readAll(orgId, brandId);
  kept.delete(key);
  kept.set(key, { xmin, readAt: now, rows });
  while (kept.size > MAX_SCOPES) kept.delete(kept.keys().next().value as string);
  return [...rows.values()];
}
