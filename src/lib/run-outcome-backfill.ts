import { sql } from "drizzle-orm";
import { RUNS_SERVICE_API_KEY, RUNS_SERVICE_URL } from "../config.js";
import { db } from "../db/index.js";
import { errorMessage } from "./db-error.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { leadFoundDeclaration, type OutcomeItem } from "./run-outcomes.js";

/**
 * THE OUTCOMES OF OUR PAST RUNS, DECLARED AS IF ON TIME (COST-BACKFILL-1023-LEAD, owner 2026-10-23: « chaque service
 * peut rétro-engineerer pour estimer tous les coûts du passé pour être à 100 % now »).
 *
 * Live declarations (run-outcomes.ts) started on 2026-10-23. Every serve run before that paid for the person it found
 * (Apollo enrichment, verification, screening, under its own run tree) and stated nothing, so runs-service read that
 * spend as "produced none". Our own rows say what each past serve run found; this module re-reads them and declares
 * the same `lead_found` the live serve declares (`leadFoundDeclaration`, one rule) on the PAST run, through
 * runs-service's backfill door (`POST /v1/platform-runs/outcomes/batch`, `occurredAt: "run_started_at"`, `redate`).
 *
 * Which past run FOUND which lead (positive evidence only, never a time guess):
 *   1. `direct`: a `leads_campaigns` row the serve itself wrote when it found the person (`status_details` = the serve's
 *      own text, `Served via audience …` since 2026-06-20, `Lead served, email=…` from 2026-05-08), never re-pointed
 *      (no retry claim, no `lead_campaign_run_repoints` row), so its `run_id` is still the finding run.
 *   2. `archived`: the same row archived by the requeue (`requeued_serves.row_snapshot`), same predicate.
 *   3. `repointed`: a find row whose run ids a later re-hand overwrote (retry claim, named serve, follow-up due). Its
 *      finding run is named by the serve's own idempotent answer (`idempotency_cache`, keyed on the CALLER's run, the
 *      answer naming the lead) AND confirmed by runs-service: the caller run's `lead-serve` child whose window holds the
 *      row's `served_at`. Both or nothing.
 * Not a find, never declared: a stock hand-over, a "Lead follow-up due" or contacted-prospects population (they bought
 * nobody), a journalist filed but not kept (a loss, as live), a run that failed or found nobody (its spend stays
 * "produced none": the truth). Before 2026-05-08 lead-service kept no serve rows (the buffer pipeline wrote none), so
 * those runs' output cannot be read here: not declared by guess.
 *
 * The consumed side is the live rule: the person's `email_checked` when a verification verdict is recorded on their
 * address. Idempotent at runs-service (a replay is `already_recorded`, `redate` moves a live-door declaration back to
 * the run's start, never later); nothing stored here, so a re-run after a failure resumes by replaying.
 */

export const BACKFILL_SINCE = "2026-02-02T00:00:00Z";
export const BATCH_MAX_RUNS = 500;
export const BATCH_MAX_OCCURRENCES = 1000;
const CALL_TIMEOUT_MS = 120_000;
const CHILD_LOOKUP_CONCURRENCY = 4;
const SERVE_WINDOW_SLACK_MS = 5_000;

/** The serve's own `status_details` when it FOUND the person (buffer.ts recordServed, and its 2026-05-08 predecessor). */
export const findDetailsSql = (col: string) => sql.raw(`(${col} LIKE 'Served via audience %' OR ${col} LIKE 'Lead served, email=%')`);
const UUID_RE_SQL = sql.raw(`'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`);

export type FindSource = "direct" | "archived" | "repointed";

export interface PastFind {
  source: FindSource;
  runId: string;
  orgId: string;
  leadId: string;
  emailChecked: boolean;
}

export interface BackfillRun {
  runId: string;
  orgId: string;
  produced: OutcomeItem[];
  consumed: OutcomeItem[];
}

/** One declaration per past run: every lead it found (equal shares), the email checks they came with. Pure. */
export function groupFindsByRun(finds: readonly PastFind[]): BackfillRun[] {
  const byRun = new Map<string, { orgId: string; leads: Map<string, boolean> }>();
  for (const f of finds) {
    const runId = f.runId.toLowerCase();
    let run = byRun.get(runId);
    if (!run) byRun.set(runId, (run = { orgId: f.orgId, leads: new Map() }));
    if (run.orgId !== f.orgId) throw new Error(`run ${runId} names two orgs (${run.orgId}, ${f.orgId})`);
    run.leads.set(f.leadId, (run.leads.get(f.leadId) ?? false) || f.emailChecked);
  }
  return [...byRun.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([runId, run]) => {
      const produced: OutcomeItem[] = [];
      const consumed: OutcomeItem[] = [];
      for (const [leadId, emailChecked] of [...run.leads.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const d = leadFoundDeclaration({ orgId: run.orgId, runId, leadId, emailChecked });
        produced.push(...d.produced);
        consumed.push(...d.consumed);
      }
      return { runId, orgId: run.orgId, produced, consumed };
    });
}

/** Batches within the door's limits (≤ 500 runs, ≤ 1000 occurrences), in order. Pure. */
export function chunkBackfillRuns(runs: readonly BackfillRun[]): BackfillRun[][] {
  const batches: BackfillRun[][] = [];
  let current: BackfillRun[] = [];
  let occurrences = 0;
  for (const run of runs) {
    const n = run.produced.length + run.consumed.length;
    if (n > BATCH_MAX_OCCURRENCES) throw new Error(`run ${run.runId} states ${n} occurrences, over the door's ${BATCH_MAX_OCCURRENCES}`);
    if (current.length > 0 && (current.length >= BATCH_MAX_RUNS || occurrences + n > BATCH_MAX_OCCURRENCES)) {
      batches.push(current);
      current = [];
      occurrences = 0;
    }
    current.push(run);
    occurrences += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface ChildRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

/** The caller run's `lead-serve` child whose window holds the find: exactly one, else none. Pure. */
export function findingChild(children: readonly ChildRun[], servedAt: string): ChildRun | null {
  const at = Date.parse(servedAt);
  const hits = children.filter((c) => {
    const start = Date.parse(c.startedAt);
    const end = Date.parse(c.completedAt ?? c.updatedAt) + SERVE_WINDOW_SLACK_MS;
    return at >= start && at <= end;
  });
  return hits.length === 1 ? hits[0] : null;
}

const notJournalistSql = (alias: string, brands: string) =>
  sql.raw(`NOT EXISTS (SELECT 1 FROM brand_journalists bj WHERE bj.lead_id = ${alias}.lead_id AND bj.journalist
                        AND bj.org_id = ${alias}.org_id AND bj.brand_id = ANY(${brands}))`);
const emailCheckedSql = (alias: string) =>
  sql.raw(`EXISTS (SELECT 1 FROM lead_contact_methods cm WHERE cm.lead_id = ${alias}.lead_id AND cm.channel = 'email'
                    AND cm.verification_verdict IS NOT NULL)`);

/** Test-only: narrow every read to one org (the suite's files share one database). Production reads the fleet. */
export interface BackfillScope {
  orgId?: string;
}
const orgScopeSql = (col: string, scope: BackfillScope) => (scope.orgId === undefined ? sql`` : sql`AND ${sql.raw(col)} = ${scope.orgId}`);

/** Sources 1 and 2: the find rows whose run ids are still the finding run's. */
export async function loadDirectFinds(scope: BackfillScope = {}): Promise<PastFind[]> {
  const rows = (await db.execute(sql`
    SELECT 'direct' AS source, lc.run_id, lc.org_id, lc.lead_id::text AS lead_id, ${emailCheckedSql("lc")} AS email_checked
      FROM leads_campaigns lc
     WHERE lc.status_reason IN ('served', 'source_found') AND ${findDetailsSql("lc.status_details")}
       AND lc.run_id ~* ${UUID_RE_SQL} AND lc.served_at >= ${BACKFILL_SINCE}::timestamptz
       AND lc.retry_claimed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM lead_campaign_run_repoints p WHERE p.lead_campaign_id = lc.id)
       AND ${notJournalistSql("lc", "lc.brand_ids")} ${orgScopeSql("lc.org_id", scope)}
    UNION ALL
    SELECT 'archived', s.run_id, s.org_id, s.lead_id::text, ${emailCheckedSql("s")}
      FROM (SELECT q.row_snapshot->>'run_id' AS run_id, q.org_id, q.lead_id, q.brand_ids,
                   q.row_snapshot->>'status_reason' AS status_reason, q.row_snapshot->>'status_details' AS status_details,
                   q.row_snapshot->>'retry_claimed_at' AS retry_claimed_at, (q.row_snapshot->>'served_at')::timestamptz AS served_at
              FROM requeued_serves q) s
     WHERE s.status_reason IN ('served', 'source_found') AND ${findDetailsSql("s.status_details")}
       AND s.run_id ~* ${UUID_RE_SQL} AND s.served_at >= ${BACKFILL_SINCE}::timestamptz
       AND s.retry_claimed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM brand_journalists bj WHERE bj.lead_id = s.lead_id AND bj.journalist
                        AND bj.org_id = s.org_id AND bj.brand_id = ANY(s.brand_ids)) ${orgScopeSql("s.org_id", scope)}
  `)) as unknown as Array<{ source: FindSource; run_id: string; org_id: string; lead_id: string; email_checked: boolean }>;
  return rows.map((r) => ({ source: r.source, runId: r.run_id.toLowerCase(), orgId: r.org_id, leadId: r.lead_id, emailChecked: r.email_checked === true }));
}

export interface RepointedFind {
  orgId: string;
  leadId: string;
  servedAt: string;
  callerRunId: string;
  emailChecked: boolean;
}

/**
 * Source 3's candidates: re-pointed find rows + the caller runs whose idempotent answer named that lead. Two plain reads
 * joined here: one statement joining the cache's JSON on the rows was planned as a nested loop and ran past 10 min in prod.
 */
export async function loadRepointedFindCandidates(scope: BackfillScope = {}): Promise<RepointedFind[]> {
  const rows = (await db.execute(sql`
    SELECT lc.org_id, lc.lead_id::text AS lead_id,
           to_char(lc.served_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS served_at, ${emailCheckedSql("lc")} AS email_checked
      FROM leads_campaigns lc
     WHERE lc.status_reason IN ('served', 'source_found') AND ${findDetailsSql("lc.status_details")}
       AND lc.served_at >= ${BACKFILL_SINCE}::timestamptz
       AND (lc.retry_claimed_at IS NOT NULL OR EXISTS (SELECT 1 FROM lead_campaign_run_repoints p WHERE p.lead_campaign_id = lc.id))
       AND ${notJournalistSql("lc", "lc.brand_ids")} ${orgScopeSql("lc.org_id", scope)}
  `)) as unknown as Array<{ org_id: string; lead_id: string; served_at: string; email_checked: boolean }>;
  if (rows.length === 0) return [];
  const answers = (await db.execute(sql`
    SELECT i.org_id, lower(i.idempotency_key) AS caller_run_id, i.response->'lead'->'data'->>'leadId' AS lead_id
      FROM idempotency_cache i
     WHERE i.response->>'found' = 'true' AND i.idempotency_key ~* ${UUID_RE_SQL} ${orgScopeSql("i.org_id", scope)}
  `)) as unknown as Array<{ org_id: string; caller_run_id: string; lead_id: string | null }>;
  const callersOf = new Map<string, string[]>();
  for (const a of answers) {
    if (!a.lead_id) continue;
    const key = `${a.org_id} ${a.lead_id}`;
    const list = callersOf.get(key);
    if (list) list.push(a.caller_run_id);
    else callersOf.set(key, [a.caller_run_id]);
  }
  return rows.flatMap((r) =>
    (callersOf.get(`${r.org_id} ${r.lead_id}`) ?? []).map((callerRunId) => ({
      orgId: r.org_id,
      leadId: r.lead_id,
      servedAt: r.served_at,
      callerRunId,
      emailChecked: r.email_checked === true,
    })),
  );
}

/** runs-service: the `lead-serve` runs of ours a caller run opened. Throws on any non-2xx. */
export async function listLeadServeChildren(orgId: string, callerRunId: string): Promise<ChildRun[]> {
  const qs = new URLSearchParams({ parentRunId: callerRunId, serviceName: "lead-service", taskName: "lead-serve", limit: "50" });
  const res = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/runs?${qs}`, {
    headers: { "x-api-key": RUNS_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`runs-service GET /v1/runs?parentRunId=${callerRunId}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { runs: ChildRun[] };
  return body.runs;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Source 3: confirm each candidate with runs-service; unconfirmed ones are counted, never declared. */
export async function resolveRepointedFinds(
  candidates: readonly RepointedFind[],
  lookup: (orgId: string, callerRunId: string) => Promise<ChildRun[]> = listLeadServeChildren,
): Promise<{ finds: PastFind[]; unconfirmed: number }> {
  const children = new Map<string, Promise<ChildRun[]>>();
  const childrenOf = (orgId: string, callerRunId: string) => {
    const key = `${orgId} ${callerRunId}`;
    let p = children.get(key);
    if (!p) children.set(key, (p = lookup(orgId, callerRunId)));
    return p;
  };
  const resolved = await mapLimit(candidates, CHILD_LOOKUP_CONCURRENCY, async (c) => {
    const child = findingChild(await childrenOf(c.orgId, c.callerRunId), c.servedAt);
    return child ? ({ source: "repointed", runId: child.id.toLowerCase(), orgId: c.orgId, leadId: c.leadId, emailChecked: c.emailChecked } as PastFind) : null;
  });
  const finds = resolved.filter((f): f is PastFind => f !== null);
  return { finds, unconfirmed: candidates.length - finds.length };
}

export interface BatchOutcome {
  recorded: number;
  alreadyRecorded: number;
  redated: number;
  refusedRuns: Array<{ runId: string; reason: string; message?: string }>;
}

export type BatchPost = (body: unknown) => Promise<{ status: number; json: unknown; text: string }>;

const postBatch: BatchPost = async (body) => {
  const res = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/platform-runs/outcomes/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": RUNS_SERVICE_API_KEY, "x-service-name": "lead-service" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
};

/**
 * One batch through the backfill door. A run the door refuses (422 `invalid_runs`: unknown, voided, out of bounds; 409
 * conflict) is set aside WITH its reason and the rest re-sent; anything else (5xx, 502 catalogue) throws: the whole
 * backfill stops and is resumed by a re-run (idempotent).
 */
export async function declareBackfillBatch(batch: readonly BackfillRun[], post: BatchPost = postBatch): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { recorded: 0, alreadyRecorded: 0, redated: 0, refusedRuns: [] };
  let pending = [...batch];
  for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
    const body = {
      runs: pending.map((r) => ({
        runId: r.runId,
        ...(r.produced.length > 0 ? { produced: r.produced } : {}),
        ...(r.consumed.length > 0 ? { consumed: r.consumed } : {}),
        occurredAt: "run_started_at",
        redate: true,
      })),
    };
    const res = await post(body);
    if (res.status === 200 || res.status === 201) {
      const j = res.json as { recordedCount?: number; alreadyRecordedCount?: number; redatedCount?: number };
      outcome.recorded += j.recordedCount ?? 0;
      outcome.alreadyRecorded += j.alreadyRecordedCount ?? 0;
      outcome.redated += j.redatedCount ?? 0;
      return outcome;
    }
    const refused = new Map<string, { reason: string; message?: string }>();
    if (res.status === 422) {
      const invalid = (res.json as { details?: { invalid?: Array<{ runId: string; reason: string; message?: string }> } } | null)?.details?.invalid ?? [];
      for (const i of invalid) refused.set(i.runId.toLowerCase(), { reason: i.reason, message: i.message });
    } else if (res.status === 409) {
      const conflicts = (res.json as { conflicts?: Array<{ runId?: string }> } | null)?.conflicts ?? [];
      for (const c of conflicts) if (c.runId) refused.set(c.runId.toLowerCase(), { reason: "conflict" });
    }
    if (refused.size === 0) throw new Error(`runs-service outcomes batch: ${res.status} ${res.text.slice(0, 500)}`);
    for (const [runId, r] of refused) outcome.refusedRuns.push({ runId, ...r });
    pending = pending.filter((r) => !refused.has(r.runId));
  }
  if (pending.length > 0) throw new Error(`runs-service outcomes batch: ${pending.length} runs still refused after 5 attempts`);
  return outcome;
}

export interface BackfillReport {
  dryRun: boolean;
  since: string;
  finds: Record<FindSource, number>;
  repointedUnconfirmed: number;
  runs: number;
  occurrences: { produced: number; consumed: number };
  batches: number;
  recorded: number;
  alreadyRecorded: number;
  redated: number;
  refusedRuns: BatchOutcome["refusedRuns"];
}

export async function runOutcomeBackfill(
  opts: { dryRun: boolean },
  deps: { post?: BatchPost; lookup?: typeof listLeadServeChildren; scope?: BackfillScope } = {},
): Promise<BackfillReport> {
  const direct = await loadDirectFinds(deps.scope);
  const repointed = await resolveRepointedFinds(await loadRepointedFindCandidates(deps.scope), deps.lookup);
  // A run named by both a row of its own and a re-pointed find declares each lead once (groupFindsByRun).
  const finds = [...direct, ...repointed.finds];
  const runs = groupFindsByRun(finds);
  const batches = chunkBackfillRuns(runs);
  const report: BackfillReport = {
    dryRun: opts.dryRun,
    since: BACKFILL_SINCE,
    finds: {
      direct: direct.filter((f) => f.source === "direct").length,
      archived: direct.filter((f) => f.source === "archived").length,
      repointed: repointed.finds.length,
    },
    repointedUnconfirmed: repointed.unconfirmed,
    runs: runs.length,
    occurrences: { produced: runs.reduce((n, r) => n + r.produced.length, 0), consumed: runs.reduce((n, r) => n + r.consumed.length, 0) },
    batches: batches.length,
    recorded: 0,
    alreadyRecorded: 0,
    redated: 0,
    refusedRuns: [],
  };
  if (opts.dryRun) return report;
  for (const [i, batch] of batches.entries()) {
    const out = await declareBackfillBatch(batch, deps.post);
    report.recorded += out.recorded;
    report.alreadyRecorded += out.alreadyRecorded;
    report.redated += out.redated;
    report.refusedRuns.push(...out.refusedRuns);
    if (out.refusedRuns.length > 0) console.error(`[lead-service] run-outcome backfill batch ${i + 1}/${batches.length}: refused ${JSON.stringify(out.refusedRuns)}`);
    console.log(`[lead-service] run-outcome backfill batch ${i + 1}/${batches.length}: recorded=${out.recorded} alreadyRecorded=${out.alreadyRecorded} redated=${out.redated}`);
  }
  return report;
}

/** In-process single flight for the route: one backfill at a time, its last report readable. */
interface BackfillJob {
  state: "running" | "done" | "failed";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  report: BackfillReport | null;
  error: string | null;
}
let job: BackfillJob | null = null;

export function backfillJob(): BackfillJob | null {
  return job;
}

export function startOutcomeBackfill(opts: { dryRun: boolean }): { started: boolean; job: BackfillJob } {
  if (job?.state === "running") return { started: false, job };
  const current: BackfillJob = { state: "running", dryRun: opts.dryRun, startedAt: new Date().toISOString(), finishedAt: null, report: null, error: null };
  job = current;
  runOutcomeBackfill(opts)
    .then((report) => {
      current.state = "done";
      current.report = report;
      console.log(`[lead-service] run-outcome backfill done: ${JSON.stringify({ ...report, refusedRuns: report.refusedRuns.length })}`);
    })
    .catch((err) => {
      current.state = "failed";
      current.error = errorMessage(err);
      console.error("[lead-service] run-outcome backfill FAILED (re-run resumes, idempotent):", err);
    })
    .finally(() => {
      current.finishedAt = new Date().toISOString();
    });
  return { started: true, job: current };
}
