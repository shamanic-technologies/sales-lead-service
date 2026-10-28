/**
 * FACTORY-RECORD-SERVE-1028: records the walk of one `buffer/next` serve (who was looked at, in order, and what decided
 * each) and stores it with the serve, read-only for staff. Rules and replay: `serve-walk-rules.ts` (pure).
 *
 * The recorder rides Node's AsyncLocalStorage (as `request-context.ts`): the route opens one walk around `pullNext`,
 * every module of the serve path notes its decisions through the helpers below, and code running outside a serve (a
 * sweep, a script, a test without a walk) notes into nothing. Recording NEVER changes who is served or when: the
 * helpers only append to memory, and the row is written after the answer, not awaited (a failed write is logged).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  replayServeWalk,
  skipReasonOf,
  type WalkCandidateStep,
  type WalkCheck,
  type WalkPool,
  type WalkRule,
  type WalkStep,
} from "./serve-walk-rules.js";

/** How long a walk is kept: replays are run on recent serves; older rows are deleted by the background sweep. */
export const SERVE_WALK_RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;
const PRUNE_FIRST_DELAY_MS = 5 * 60_000;
/** A walk that looked at more people than this keeps the first ones and says how many it dropped (a runaway loop guard). */
export const SERVE_WALK_MAX_STEPS = 2_000;

export interface ServeWalkHeader {
  orgId: string;
  brandId: string;
  campaignId: string;
  callerRunId: string | null;
  serveRunId: string | null;
  mode: string;
  /** The serve's stated policy (what every pool's SQL filters on), its audience(s), its sources. */
  context: Record<string, unknown>;
}

/** One person in the walk, as the serve path holds it while deciding. */
export interface WalkCandidateHandle {
  readonly ref: string;
  check(rule: WalkRule, inputs: Record<string, unknown>, passed: boolean): boolean;
  identify(leadId: string): void;
  serve(): void;
  skip(): void;
}

const NOOP_HANDLE: WalkCandidateHandle = {
  ref: "",
  check: (_rule, _inputs, passed) => passed,
  identify: () => undefined,
  serve: () => undefined,
  skip: () => undefined,
};

export class ServeWalk {
  readonly header: ServeWalkHeader;
  readonly startedAt = new Date();
  readonly steps: WalkStep[] = [];
  dropped = 0;
  private seq = 0;
  private open: WalkCandidateStep | null = null;

  constructor(header: ServeWalkHeader) {
    this.header = header;
  }

  private push(step: WalkStep): boolean {
    if (this.steps.length >= SERVE_WALK_MAX_STEPS) {
      this.dropped++;
      return false;
    }
    this.steps.push(step);
    return true;
  }

  context(extra: Record<string, unknown>): void {
    Object.assign(this.header.context, extra);
  }

  event(what: string, detail: Record<string, unknown> = {}): void {
    this.push({ type: "event", seq: ++this.seq, what, detail });
  }

  candidate(pool: WalkPool, ref: string, leadId: string | null = null): WalkCandidateHandle {
    const step: WalkCandidateStep = { type: "candidate", seq: ++this.seq, pool, ref, leadId, checks: [], outcome: "not_reached", reason: null };
    if (!this.push(step)) return NOOP_HANDLE;
    this.open = step;
    return this.handle(step);
  }

  /**
   * The person still being decided, when it came from one of `pools` (a candidate revealed by human-service is decided
   * further once it is filed as a lead); else a new one. One person = one walk step across module boundaries.
   */
  continueOr(pools: readonly WalkPool[], newPool: WalkPool, ref: string): WalkCandidateHandle {
    const open = this.open;
    const last = open?.checks[open.checks.length - 1];
    // Only a person just revealed (last check a passed reveal): a candidate left open by a failure is never borrowed.
    if (open && pools.includes(open.pool) && open.outcome === "not_reached" && last?.rule === "reveal" && last.passed) return this.handle(open);
    return this.candidate(newPool, ref);
  }

  private handle(step: WalkCandidateStep): WalkCandidateHandle {
    const close = (outcome: "served" | "skipped") => {
      step.outcome = outcome;
      step.reason = outcome === "skipped" ? (skipReasonOf(step.checks) ?? "unstated") : null;
      if (this.open === step) this.open = null;
    };
    return {
      ref: step.ref,
      check: (rule, inputs, passed) => {
        step.checks.push({ rule, inputs, passed } satisfies WalkCheck);
        return passed;
      },
      identify: (id) => {
        step.leadId = id;
      },
      serve: () => close("served"),
      skip: () => close("skipped"),
    };
  }
}

const storage = new AsyncLocalStorage<ServeWalk>();

/** Run `fn` with `walk` as the serve's recorder. */
export function withServeWalk<T>(walk: ServeWalk, fn: () => Promise<T>): Promise<T> {
  return storage.run(walk, fn);
}

export function currentServeWalk(): ServeWalk | undefined {
  return storage.getStore();
}

/** Note a person the serve looks at (a no-op outside a serve). */
export function walkCandidate(pool: WalkPool, ref: string, leadId: string | null = null): WalkCandidateHandle {
  return storage.getStore()?.candidate(pool, ref, leadId) ?? NOOP_HANDLE;
}

/** The person a fresh serve is deciding (revealed by the candidates walk), or a new one from serve-next. */
export function walkFoundPerson(ref: string): WalkCandidateHandle {
  return storage.getStore()?.continueOr(["candidates"], "serve_next", ref) ?? NOOP_HANDLE;
}

/** Note something the serve met that is not a person (an audience's empty answer, a sender unreadable). */
export function walkEvent(what: string, detail: Record<string, unknown> = {}): void {
  storage.getStore()?.event(what, detail);
}

/** Add to the serve's stated context (its offer, its must-pass basis...). */
export function walkContext(extra: Record<string, unknown>): void {
  storage.getStore()?.context(extra);
}

export interface ServeWalkOutcome {
  found: boolean | null;
  reason: string | null;
  servedLeadId: string | null;
  error: string | null;
}

/** Write the walk with the serve's answer. Never awaited by the serve; a failure is logged, the serve unaffected. */
export async function persistServeWalk(walk: ServeWalk, outcome: ServeWalkOutcome): Promise<void> {
  const h = walk.header;
  const replay = replayServeWalk(walk.steps);
  if (outcome.found && replay.servedLeadId !== outcome.servedLeadId) {
    // Loud: the record does not replay to the person served (a decision the walk did not note). Stored as is.
    console.error(
      `[lead-service] serve-walk does not replay: campaign=${h.campaignId} run=${h.serveRunId} served=${outcome.servedLeadId} replayed=${replay.servedLeadId} mismatches=${replay.mismatches.length}`,
    );
  }
  const context = walk.dropped > 0 ? { ...h.context, droppedSteps: walk.dropped } : h.context;
  await db.execute(sql`
    INSERT INTO serve_walks (
      org_id, brand_id, campaign_id, caller_run_id, serve_run_id, mode, found, reason, served_lead_id, error,
      context, steps, started_at, finished_at
    ) VALUES (
      ${h.orgId}, ${h.brandId}, ${h.campaignId}, ${h.callerRunId}, ${h.serveRunId}, ${h.mode}, ${outcome.found},
      ${outcome.reason}, ${outcome.servedLeadId}::uuid, ${outcome.error},
      ${JSON.stringify(context)}::jsonb, ${JSON.stringify(walk.steps)}::jsonb,
      ${walk.startedAt.toISOString()}::timestamptz, ${new Date().toISOString()}::timestamptz
    )
  `);
}

/** Fire-and-forget write: the serve's answer never waits on its record. */
export function recordServeWalk(walk: ServeWalk, outcome: ServeWalkOutcome): void {
  persistServeWalk(walk, outcome).catch((err) => {
    console.error(`[lead-service] serve-walk record failed campaign=${walk.header.campaignId} run=${walk.header.serveRunId}:`, err);
  });
}

export interface StoredServeWalk {
  id: string;
  orgId: string;
  brandId: string;
  campaignId: string;
  callerRunId: string | null;
  serveRunId: string | null;
  mode: string;
  found: boolean | null;
  reason: string | null;
  servedLeadId: string | null;
  error: string | null;
  context: Record<string, unknown>;
  steps: WalkStep[];
  startedAt: string;
  finishedAt: string;
}

type Row = {
  id: string; org_id: string; brand_id: string; campaign_id: string; caller_run_id: string | null; serve_run_id: string | null;
  mode: string; found: boolean | null; reason: string | null; served_lead_id: string | null; error: string | null;
  context: Record<string, unknown>; steps: WalkStep[]; started_at: string; finished_at: string;
};

/** Staff read: the walks of one serve run, one caller run, or a campaign's latest (newest first, at most `limit`). */
export async function readServeWalks(q: { runId?: string; campaignId?: string; limit: number }): Promise<StoredServeWalk[]> {
  const where = q.runId
    ? sql`(serve_run_id = ${q.runId} OR caller_run_id = ${q.runId})`
    : sql`campaign_id = ${q.campaignId!}`;
  const rows = (await db.execute(sql`
    SELECT id::text AS id, org_id, brand_id, campaign_id, caller_run_id, serve_run_id, mode, found, reason,
      served_lead_id::text AS served_lead_id, error, context, steps,
      to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
      to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at
    FROM serve_walks WHERE ${where}
    ORDER BY started_at DESC, id DESC
    LIMIT ${q.limit}
  `)) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id, orgId: r.org_id, brandId: r.brand_id, campaignId: r.campaign_id, callerRunId: r.caller_run_id,
    serveRunId: r.serve_run_id, mode: r.mode, found: r.found, reason: r.reason, servedLeadId: r.served_lead_id,
    error: r.error, context: r.context, steps: r.steps, startedAt: r.started_at, finishedAt: r.finished_at,
  }));
}

export async function pruneServeWalks(): Promise<number> {
  const rows = (await db.execute(sql`
    DELETE FROM serve_walks WHERE created_at < now() - make_interval(days => ${SERVE_WALK_RETENTION_DAYS}) RETURNING 1
  `)) as unknown as unknown[];
  return rows.length;
}

export function startServeWalkPruneWorker(): void {
  const tick = () =>
    pruneServeWalks()
      .then((n) => n > 0 && console.log(`[lead-service] serve-walks pruned ${n} older than ${SERVE_WALK_RETENTION_DAYS} days`))
      .catch((err) => console.error("[lead-service] serve-walks prune failed:", err));
  setTimeout(() => void tick(), PRUNE_FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), PRUNE_INTERVAL_MS).unref();
}
