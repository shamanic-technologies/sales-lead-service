import net from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.LEAD_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("LEAD_SERVICE_DATABASE_URL is not set");
}

// Node 20 gives each candidate address 250ms before happy-eyeballs moves on and,
// once every candidate has been tried, rejects with `AggregateError [ETIMEDOUT]`.
// A Neon compute resuming from scale-to-zero takes ~1-7s to accept, so the first
// connection after a suspend loses that race and fails outright. Widen the
// per-candidate budget to 5s.
//
// This is NOT a postgres.js option: `connect_timeout` already defaults to 30s and
// `idle_timeout` defaults to `null` (idle connections are never closed), so
// neither would help here — see brand-service#389.
net.setDefaultAutoSelectFamilyAttemptTimeout(5_000);

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[lead-service] ${name} must be a positive number, got '${raw}'`);
  }
  return Math.floor(parsed);
}

/**
 * How many database connections this service may hold, stated HERE rather than inherited.
 *
 * postgres.js defaults to `max: 10`. On 2026-09-07 ten concurrent whole-population lead reads
 * each took one of those ten connections and never gave it back — the callers had already
 * abandoned their sockets at their own 300s HTTP timeout, so the walks never progressed and
 * Postgres held ten backends at `state=active, wait_event_type=Client` for 11h30m. The pool was
 * permanently exhausted, every later read hung forever, and `/health` answered 503 until somebody
 * restarted the container by hand. A ceiling that is a library default is a ceiling nobody chose;
 * it is now a number in code, next to the two timeouts that bound how long one connection may be
 * held, so the three can be read together.
 */
export const POOL_MAX = positiveInt("LEAD_DB_POOL_MAX", 20);

/**
 * Per-SESSION statement timeouts, sent in the startup packet, so they apply to lead-service's own
 * connections and to NOTHING else on the shared Postgres — no server configuration is touched.
 *
 * These are the backstop, not the fix: the fix is that an abandoned read stops walking (see
 * `src/lib/client-abort.ts`). They bound the other half — a single statement that runs, or a
 * transaction that sits open, longer than any legitimate read of the largest brand ever does.
 */
export const STATEMENT_TIMEOUT_MS = positiveInt("LEAD_DB_STATEMENT_TIMEOUT_MS", 120_000);
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = positiveInt(
  "LEAD_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  120_000,
);

export const POOL_OPTIONS = {
  prepare: false,
  max: POOL_MAX,
  connection: {
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  },
} as const;

export const sql = postgres(connectionString, POOL_OPTIONS);
export const db = drizzle(sql, { schema });
restorePostgresArrayTypes(sql);

/**
 * drizzle-orm >= 0.41 registers pass-through parsers/serializers on the postgres.js client for
 * the array types date[] (1182), timestamptz[] (1185), timestamp[] (1115) and numeric[] (1231).
 * postgres.js then skips its own array handling for them: a JS array bound to `$1::timestamptz[]`
 * fails with ERR_INVALID_ARG_TYPE and such a column reads back as a raw '{...}' string. Drop those
 * four overrides so postgres.js handles them exactly as it did under drizzle-orm 0.36.
 */
function restorePostgresArrayTypes(client: postgres.Sql): void {
  const options = client.options as unknown as {
    parsers: Record<string, unknown>;
    serializers: Record<string, unknown>;
  };
  for (const oid of ["1182", "1185", "1115", "1231"]) {
    delete options.parsers[oid];
    delete options.serializers[oid];
  }
}

/**
 * Liveness reads its own, tiny pool.
 *
 * `/health` answering is what tells the deploy — and whoever is looking — whether this service is
 * alive. During the 2026-09-07 incident it was starved by the same exhausted pool the wedged
 * reads had taken, so a service that could still have answered anything cheap reported itself
 * unavailable for 11.5 hours. Two connections nothing else can take keeps that answer honest.
 */
export const healthSql = postgres(connectionString, {
  ...POOL_OPTIONS,
  max: 2,
  connection: {
    ...POOL_OPTIONS.connection,
    statement_timeout: 5_000,
  },
});
