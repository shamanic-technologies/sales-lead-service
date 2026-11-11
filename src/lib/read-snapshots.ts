/**
 * A slow brand-wide read served from its last stored answer (MON-PAGE-SPEED-1111, owner 2026-11-09 « make every page
 * instant »: no read over 1 s, cold included).
 *
 * Why. "Who is waiting on us" (awaiting-reply) and the relationships review are brand-wide computations: 10-25 s on
 * the largest brand when Postgres has to read their rows from disk (after any quiet stretch), 0.3-10 s warm. The answer
 * is a few KB to a few MB of JSON that changes a few times an hour.
 *
 * How. The answer's JSON body is stored per (kind, org, brand) in `read_snapshots` (survives a deploy, shared by every
 * thread). A read:
 *  - serves the stored body when it is VALID (built after the last invalidation); when it was built more than
 *    `revalidateAfterMs` ago, the same computation runs again in the background (one at a time per key) and the next
 *    read gets its answer. A read never waits on a valid answer, and nothing is computed for a brand nobody reads.
 *  - computes and stores it when there is none, or when a write invalidated it (waiting on a build already running
 *    that started after the invalidation instead of starting a second one).
 * A write of this service that changes the answer (a person's statement) INVALIDATES it and starts the rebuild at once,
 * so the read after a click never shows the state before it. A build that started before an invalidation is never
 * stored over it (`built_at` = when the build started; the upsert keeps only a later one).
 */
import { sql } from "../db/index.js";

export type SnapshotKind = "awaiting_reply" | "relationship_review";

interface Building {
  startedAt: number;
  done: Promise<string>;
}

const building = new Map<string, Building>();
const keyOf = (kind: SnapshotKind, orgId: string, brandId: string) => `${kind}|${orgId}|${brandId}`;

/** Test seam: wait for every build this process runs (background ones included). */
export async function settleReadSnapshotBuilds(): Promise<void> {
  while (building.size > 0) await Promise.allSettled([...building.values()].map((b) => b.done));
}

async function store(kind: SnapshotKind, orgId: string, brandId: string, body: string, startedAt: number): Promise<void> {
  const at = new Date(startedAt).toISOString();
  await sql`
    INSERT INTO read_snapshots (kind, org_id, brand_id, body, built_at)
    VALUES (${kind}, ${orgId}, ${brandId}, ${body}, ${at}::timestamptz)
    ON CONFLICT (kind, org_id, brand_id) DO UPDATE SET body = EXCLUDED.body, built_at = EXCLUDED.built_at
    WHERE read_snapshots.built_at < EXCLUDED.built_at
      AND (read_snapshots.invalidated_at IS NULL OR read_snapshots.invalidated_at < EXCLUDED.built_at)
  `;
}

/** Start (or join) a build of this key that started at or after `notBefore` (ms). */
function build(kind: SnapshotKind, orgId: string, brandId: string, compute: () => Promise<string>, notBefore: number): Promise<string> {
  const key = keyOf(kind, orgId, brandId);
  const running = building.get(key);
  if (running && running.startedAt >= notBefore) return running.done;
  // Never dated before `notBefore`: a build started right after an invalidation (same millisecond) must outrank it.
  const startedAt = Math.max(Date.now(), notBefore);
  const done = (async () => {
    const body = await compute();
    await store(kind, orgId, brandId, body, startedAt);
    return body;
  })();
  const entry: Building = { startedAt, done };
  building.set(key, entry);
  const clear = () => {
    if (building.get(key) === entry) building.delete(key);
  };
  done.then(clear, clear);
  return done;
}

/**
 * The JSON body of this read: the stored one when valid (revalidated in the background once older than
 * `revalidateAfterMs`), else computed now and stored. `compute` returns the exact body the route sends.
 */
export async function readThroughSnapshot(input: {
  kind: SnapshotKind;
  orgId: string;
  brandId: string;
  revalidateAfterMs: number;
  compute: () => Promise<string>;
}): Promise<string> {
  const { kind, orgId, brandId, compute } = input;
  const rows = (await sql`
    SELECT body, built_at, invalidated_at FROM read_snapshots
    WHERE kind = ${kind} AND org_id = ${orgId} AND brand_id = ${brandId}
  `) as unknown as Array<{ body: string; built_at: Date | string; invalidated_at: Date | string | null }>;
  const row = rows[0];
  const builtAt = row ? new Date(row.built_at).getTime() : null;
  const invalidatedAt = row?.invalidated_at ? new Date(row.invalidated_at).getTime() : null;
  if (row && builtAt !== null && (invalidatedAt === null || invalidatedAt < builtAt)) {
    if (Date.now() - builtAt > input.revalidateAfterMs) {
      build(kind, orgId, brandId, compute, builtAt + 1).catch((error: unknown) => {
        console.error(`[lead-service] read snapshot ${kind} org=${orgId} brand=${brandId}: background rebuild failed (the stored answer stays served):`, error);
      });
    }
    return row.body;
  }
  return build(kind, orgId, brandId, compute, invalidatedAt === null ? 0 : invalidatedAt + 1);
}

/**
 * A write changed these answers: mark them invalid, so no read serves them again until a build that started after now
 * stored a new one. `brandId` null = every brand of the org that has one; a named brand is marked even before its first
 * answer is stored (a build already running for it then cannot store its older answer). Returns the invalidation time (ms).
 */
export async function invalidateSnapshots(kind: SnapshotKind, orgId: string, brandId: string | null): Promise<number> {
  const ms = Date.now();
  const at = new Date(ms).toISOString();
  if (brandId === null) {
    await sql`UPDATE read_snapshots SET invalidated_at = ${at}::timestamptz WHERE kind = ${kind} AND org_id = ${orgId}`;
  } else {
    await sql`
      INSERT INTO read_snapshots (kind, org_id, brand_id, body, built_at, invalidated_at)
      VALUES (${kind}, ${orgId}, ${brandId}, '', '-infinity', ${at}::timestamptz)
      ON CONFLICT (kind, org_id, brand_id) DO UPDATE SET invalidated_at = EXCLUDED.invalidated_at
    `;
  }
  return ms;
}

/** Invalidate, then rebuild this brand's answer in the background right away (the next read joins that build). */
export async function invalidateAndRebuild(input: {
  kind: SnapshotKind;
  orgId: string;
  brandId: string;
  /** Invalidate every brand of the org (an org-wide statement), the named brand rebuilt. */
  orgWide?: boolean;
  compute: () => Promise<string>;
}): Promise<void> {
  if (input.orgWide) await invalidateSnapshots(input.kind, input.orgId, null);
  const invalidatedAt = await invalidateSnapshots(input.kind, input.orgId, input.brandId);
  build(input.kind, input.orgId, input.brandId, input.compute, invalidatedAt + 1).catch((error: unknown) => {
    console.error(`[lead-service] read snapshot ${input.kind} org=${input.orgId} brand=${input.brandId}: rebuild after a write failed (the next read computes it):`, error);
  });
}
