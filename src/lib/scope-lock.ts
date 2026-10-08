/**
 * Per-scope serialization that holds ACROSS the request thread and the background thread.
 *
 * The background sweeps (read models, change feeds, CRM evidence, outcome causes) run in their own
 * worker thread (`src/background-worker.ts`), so a whole-scope re-derivation never blocks the event
 * loop that answers the dashboard. Each thread has its own memory, so an in-process lock alone no
 * longer stops a read's catch-up and the worker's refresh of the same scope from interleaving.
 *
 * Two layers, in this order:
 *   1. an in-process promise queue per key — callers of one thread queue here, and hold nothing
 *      while they wait;
 *   2. once cross-thread locking is enabled (both threads do so at boot), a Postgres SESSION
 *      advisory lock on a small dedicated pool. Waiting is a `pg_try_advisory_lock` poll that hands
 *      its connection back between tries, so a waiter never holds a connection the holder needs.
 *
 * One pool PER NAMESPACE, never one shared pool. A held lock keeps its connection for the whole
 * task, and locks nest (`read-model-refresh` holds while its build takes `read-model` for the
 * swap). With one shared pool of N, N scopes refreshing at once held all N connections and each
 * waited for an (N+1)th to take its inner lock: the thread deadlocked for good, and every read
 * queued behind those scopes hung until its caller gave up (2026-10-08, interactive thread, N=2:
 * every board and count read dropped). Per namespace, an inner lock never waits on a connection
 * an outer holder of another namespace keeps. Never nest a namespace inside itself.
 *
 * Tests never enable layer 2: they run one thread, and the in-process queue is the whole lock, as
 * it always was.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";

const POLL_MS = 25;

let lockConfig: { connectionString: string; max: number } | null = null;
const lockPools = new Map<string, postgres.Sql>();

/**
 * Turn on the cross-thread layer. Called once per thread at boot, by `src/http-worker.ts` (HTTP
 * threads) and `src/background-worker.ts` (background thread). `max` bounds each namespace's pool.
 */
export function enableCrossThreadLocks(connectionString: string, max: number): void {
  if (lockConfig) return;
  lockConfig = { connectionString, max };
}

/** The namespace's own lock pool, opened on first use; null when cross-thread locking is off. */
function poolFor(namespace: string): postgres.Sql | null {
  if (!lockConfig) return null;
  let pool = lockPools.get(namespace);
  if (!pool) {
    // Idle connections close: a pool holds a connection only while a lock is held or polled.
    pool = postgres(lockConfig.connectionString, { prepare: false, max: lockConfig.max, idle_timeout: 60 });
    lockPools.set(namespace, pool);
  }
  return pool;
}

/** One signed 64-bit advisory key per (namespace, key). Exported for tests that hold it elsewhere. */
export function advisoryKey(namespace: string, key: string): string {
  return createHash("sha256").update(`${namespace}\0${key}`).digest().readBigInt64BE(0).toString();
}

const queues = new Map<string, Promise<unknown>>();

function inProcess<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(id) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  queues.set(id, tail);
  tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

async function acquire(pool: postgres.Sql, lockKey: string): Promise<postgres.ReservedSql> {
  for (;;) {
    const conn = await pool.reserve();
    try {
      const [row] = await conn<Array<{ ok: boolean }>>`
        SELECT pg_try_advisory_lock(${lockKey}::bigint) AS ok
      `;
      if (row.ok) return conn;
    } catch (error) {
      conn.release();
      throw error;
    }
    conn.release();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Run `task` while no other holder of (namespace, key) runs, in this thread or the other one. */
export function withScopeLock<T>(namespace: string, key: string, task: () => Promise<T>): Promise<T> {
  const id = `${namespace}\0${key}`;
  return inProcess(id, async () => {
    const pool = poolFor(namespace);
    if (!pool) return task();
    const lockKey = advisoryKey(namespace, key);
    const conn = await acquire(pool, lockKey);
    try {
      return await task();
    } finally {
      try {
        await conn`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
      } finally {
        conn.release();
      }
    }
  });
}

/**
 * Whether somebody holds (or is queued for) the lock right now, in either thread. A hint, not a
 * guarantee — it may change the moment it is answered — for a reader that would rather answer from
 * what is committed than queue behind somebody else's long pass.
 */
export async function scopeLockBusy(namespace: string, key: string): Promise<boolean> {
  if (queues.has(`${namespace}\0${key}`)) return true;
  const pool = poolFor(namespace);
  if (!pool) return false;
  const lockKey = advisoryKey(namespace, key);
  const conn = await pool.reserve();
  try {
    const [row] = await conn<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_lock(${lockKey}::bigint) AS ok
    `;
    if (!row.ok) return true;
    await conn`SELECT pg_advisory_unlock(${lockKey}::bigint)`;
    return false;
  } finally {
    conn.release();
  }
}
