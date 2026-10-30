/**
 * FACTORY-P3 next outcomes (lead_identified): the per-candidate DECISION of a candidates serve (screen threshold,
 * must-pass, reveal or decline, a stalled reveal declined) as a STORED SCRIPT (workflow-service
 * `lead_identified/<dynasty>`, proven 100 % on recorded decisions), while workflow-service says the outcome is switched
 * for this service (`GET /internal/scripts/switches/service`, read at most once a minute here).
 *
 * No workflow step calls it (`buffer/next` serves inside this service), so it is a SERVICE switch; the roll-back guard
 * flips it back when the script errs more than our own decisions did. The script reaches this service only through its
 * DOORS (`POST /internal/candidate-decisions/{screen,must-pass,decline,reveal}`), which run our exact calls for the
 * candidate this serve has IN FLIGHT (`x-caller-run-id` = the serve's run + the candidate id): the Jev screen with its
 * stored screening and 30-day reuse, the offer's must-pass checks, human-service's decline and reveal. A refusal a door
 * meets is kept and re-thrown to the serve as the SAME error our own code would have thrown.
 */
import { randomUUID } from "node:crypto";

export const LEAD_IDENTIFIED_OUTCOME = "lead_identified";
export const CALLER_SERVICE = "lead";
const STATE_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 600_000;

export interface DecisionScriptSwitch {
  switched: boolean;
  dynasty: string | null;
}

let cached: { state: DecisionScriptSwitch; at: number } | null = null;

/** Test hook. */
export function resetDecisionScriptSwitchMemo(): void {
  cached = null;
}

function workflow(): { base: string; key: string } {
  const base = (process.env.WORKFLOW_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.WORKFLOW_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("[lead-service] WORKFLOW_SERVICE_URL and WORKFLOW_SERVICE_API_KEY are required for the candidate decision switch");
  return { base, key };
}

/** Whether candidates are decided by the stored script now. Unreadable = the last state read; never read = our code. */
export async function decisionScriptSwitch(now = Date.now()): Promise<DecisionScriptSwitch> {
  if (cached && now - cached.at < STATE_TTL_MS) return cached.state;
  try {
    const { base, key } = workflow();
    const q = new URLSearchParams({ outcome: LEAD_IDENTIFIED_OUTCOME, callerService: CALLER_SERVICE });
    const res = await fetch(`${base}/internal/scripts/switches/service?${q}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET /internal/scripts/switches/service -> ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { switched?: unknown; dynasty?: unknown };
    const state: DecisionScriptSwitch = body.switched === true && typeof body.dynasty === "string" && body.dynasty ? { switched: true, dynasty: body.dynasty } : { switched: false, dynasty: null };
    cached = { state, at: now };
    return state;
  } catch (error) {
    const kept = cached?.state ?? { switched: false, dynasty: null };
    console.error(`[lead-service] candidate decision switch: state unreadable, keeping ${kept.switched ? `the script ${kept.dynasty}` : "our own code"}: ${error instanceof Error ? error.message : String(error)}`);
    cached = { state: kept, at: now };
    return kept;
  }
}

/** One recorded vendor call of a decision, in the stored script's words. */
export interface DecisionCall {
  name: string;
  args?: Record<string, unknown>;
  answer: { ok: boolean; data: Record<string, unknown> };
}

export interface InFlight<Ctx> {
  token: string;
  candidateId: string;
  ctx: Ctx;
  calls: DecisionCall[];
  /** The error our own code would have thrown at that point (re-thrown to the serve). */
  thrown: Error | null;
  /** What the reveal door answered (the person served, when served). */
  revealed: unknown;
}

const inFlight = new Map<string, Array<InFlight<unknown>>>();
const key = (callerRunId: string, candidateId: string) => `${callerRunId}\u0000${candidateId}`;

export function registerInFlight<Ctx>(callerRunId: string, candidateId: string, ctx: Ctx): InFlight<Ctx> {
  const entry: InFlight<Ctx> = { token: randomUUID(), candidateId, ctx, calls: [], thrown: null, revealed: null };
  const k = key(callerRunId, candidateId);
  inFlight.set(k, [...(inFlight.get(k) ?? []), entry as InFlight<unknown>]);
  return entry;
}

export function releaseInFlight(callerRunId: string, entry: InFlight<unknown>): void {
  const k = key(callerRunId, entry.candidateId);
  const left = (inFlight.get(k) ?? []).filter((e) => e !== entry);
  if (left.length > 0) inFlight.set(k, left);
  else inFlight.delete(k);
}

export function findInFlight<Ctx>(callerRunId: string, candidateId: string): InFlight<Ctx> | null {
  return ((inFlight.get(key(callerRunId, candidateId)) ?? [])[0] as InFlight<Ctx> | undefined) ?? null;
}

export class DecisionScriptError extends Error {
  constructor(message: string, readonly runId: string | null) {
    super(message);
  }
}

export type CandidateDecision = "served" | "not_served" | "declined" | "stalled";

/** Run the stored decision for one candidate on the serve's run. Throws `DecisionScriptError` on a refusal. */
export async function decideWithScript(input: {
  dynasty: string;
  orgId: string;
  userId: string | null;
  serveRunId: string;
  tracking: { brandId?: string | null; campaignId?: string | null; workflowSlug?: string | null; featureSlug?: string | null };
  candidateId: string;
  hasTarget: boolean;
}): Promise<{ runId: string | null; scriptSlug: string | null; decision: CandidateDecision }> {
  const { base, key: apiKey } = workflow();
  const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": apiKey, "x-org-id": input.orgId, "x-run-id": input.serveRunId };
  if (input.userId) headers["x-user-id"] = input.userId;
  if (input.tracking.brandId) headers["x-brand-id"] = input.tracking.brandId;
  if (input.tracking.campaignId) headers["x-campaign-id"] = input.tracking.campaignId;
  if (input.tracking.workflowSlug) headers["x-workflow-slug"] = input.tracking.workflowSlug;
  if (input.tracking.featureSlug) headers["x-feature-slug"] = input.tracking.featureSlug;
  const res = await fetch(`${base}/internal/scripts/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outcome: LEAD_IDENTIFIED_OUTCOME,
      dynasty: input.dynasty,
      subject: { service: "lead", id: input.candidateId },
      units: { lead_found: { content: { candidateId: input.candidateId } }, audience_built: { content: { hasTarget: input.hasTarget } } },
      recordedBy: CALLER_SERVICE,
    }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Named below by status.
  }
  const details = (res.ok ? body : ((body.details ?? {}) as Record<string, unknown>)) as Record<string, unknown>;
  const runId = typeof details.runId === "string" ? details.runId : null;
  if (!res.ok) throw new DecisionScriptError(`workflow-service POST /internal/scripts/run -> ${res.status}: ${String(body.error ?? text).slice(0, 400)}`, runId);
  const decision = ((body.unit ?? null) as { content?: Record<string, unknown> } | null)?.content?.decision;
  if (body.status !== "made" || !["served", "not_served", "declined", "stalled"].includes(String(decision))) {
    throw new DecisionScriptError(`the script made no decision (status ${String(body.status)})`, runId);
  }
  return { runId, scriptSlug: typeof body.scriptSlug === "string" ? body.scriptSlug : null, decision: decision as CandidateDecision };
}
