/**
 * Keeps every read model somebody is looking at inside its freshness bound, so a read never has
 * to rebuild one while a customer waits.
 *
 * Every `READ_MODEL_WORKER_INTERVAL_MS` it walks the live models: one past
 * `READ_MODEL_REFRESH_AFTER_MS` is rebuilt (its delivery evidence asked again, its population
 * re-read), every other one is brought up to date with the change log. The ENFORCED bound lives in
 * lead-read-model.ts (`READ_MODEL_MAX_EVIDENCE_AGE_MS`): if this worker falls behind, a read
 * rebuilds rather than serving a stale model — this worker only makes that rare.
 *
 * It also PRE-BUILDS the brand model of every brand that served a lead in the last
 * `ACTIVE_BRAND_WINDOW_DAYS`, so the first time a customer opens their Leads page it answers
 * immediately rather than paying the first build. A model nobody has read for `KEEP_WARM_MS` (and
 * that is not such a brand model) is retired, and retired models are deleted once no read can
 * still hold one.
 *
 * An interval armed after boot, not a cron: a declared cron is best-effort and skips. The mutex is
 * INSIDE the sweep, and each model is refreshed under the same per-scope lock a read takes, so a
 * sweep, a read and another sweep can never build the same scope twice at once.
 */
import { sql } from "../db/index.js";
import { DEFAULT_LEAD_LIST_STATUSES } from "./lead-list-query.js";
import {
  readModelKey,
  readModelScopeFor,
  refreshReadModel,
  type ReadModelScope,
} from "./lead-read-model.js";

export const READ_MODEL_WORKER_INTERVAL_MS = 15_000;
const FIRST_SWEEP_DELAY_MS = 20_000;
/** A model nobody read for this long stops being kept fresh (unless it is an active brand's). */
const KEEP_WARM_MS = 7 * 24 * 60 * 60_000;
/** A brand that served anybody within this window gets its brand model pre-built. */
const ACTIVE_BRAND_WINDOW_DAYS = 30;
/** How often the active-brand list is re-read. */
const ACTIVE_BRANDS_TTL_MS = 10 * 60_000;
/** Change-log rows older than this can no longer matter: every model is rebuilt well inside it. */
const CHANGE_LOG_RETENTION = "1 day";

let activeBrandScopes: { at: number; scopes: ReadModelScope[] } | null = null;

/** The brand-scope model the Leads page reads for every brand that served somebody recently. */
async function activeBrandModelScopes(): Promise<ReadModelScope[]> {
  if (activeBrandScopes && Date.now() - activeBrandScopes.at < ACTIVE_BRANDS_TTL_MS) {
    return activeBrandScopes.scopes;
  }
  const rows = await sql<Array<{ org_id: string; brand_id: string }>>`
    SELECT DISTINCT lc.org_id, b AS brand_id
    FROM leads_campaigns lc, unnest(lc.brand_ids) AS b
    WHERE lc.served_at > now() - make_interval(days => ${ACTIVE_BRAND_WINDOW_DAYS})
  `;
  const scopes = rows.map((row) =>
    readModelScopeFor(
      { orgId: row.org_id, brandId: row.brand_id, statuses: DEFAULT_LEAD_LIST_STATUSES },
      row.brand_id,
      true,
    ),
  );
  activeBrandScopes = { at: Date.now(), scopes };
  return scopes;
}

interface LiveModel {
  scope_key: string;
  scope: ReadModelScope;
  last_read_at: Date | string;
}

let sweeping = false;

export async function sweepReadModels(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const live = await sql<LiveModel[]>`
      SELECT scope_key, scope, last_read_at FROM lead_read_models WHERE scope_key IS NOT NULL
    `;
    const pinned = new Map<string, ReadModelScope>();
    for (const scope of await activeBrandModelScopes()) pinned.set(readModelKey(scope), scope);

    const toRefresh = new Map<string, ReadModelScope>(pinned);
    const staleBefore = Date.now() - KEEP_WARM_MS;
    for (const model of live) {
      if (pinned.has(model.scope_key)) continue;
      if (new Date(model.last_read_at).getTime() < staleBefore) {
        await sql`
          UPDATE lead_read_models SET scope_key = NULL, retired_at = now()
          WHERE scope_key = ${model.scope_key}
        `;
        continue;
      }
      toRefresh.set(model.scope_key, model.scope);
    }

    for (const [key, scope] of toRefresh) {
      try {
        await refreshReadModel(scope);
      } catch (error) {
        console.error(
          `[lead-read-model] scope ${key} (org=${scope.orgId} brand=${scope.brandId ?? "-"}) could ` +
            `not be refreshed; a read past its bound will rebuild it or answer 502: ${(error as Error).message}`,
        );
      }
    }

    // A retired model is kept a while so a read that picked it up just before a swap still reads a
    // whole model; a build that died without cleaning up is dropped once it cannot be running.
    await sql`
      DELETE FROM lead_read_models
      WHERE (retired_at IS NOT NULL AND retired_at < now() - interval '15 minutes')
         OR (scope_key IS NULL AND retired_at IS NULL AND created_at < now() - interval '1 hour')
    `;
    await sql`
      DELETE FROM lead_read_changes WHERE created_at < now() - ${CHANGE_LOG_RETENTION}::interval
    `;
  } finally {
    sweeping = false;
  }
}

export function startReadModelWorker(): void {
  const tick = () => {
    sweepReadModels().catch((error) => console.error("[lead-read-model] sweep failed:", error));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, READ_MODEL_WORKER_INTERVAL_MS).unref();
}
