/**
 * Serving a person through CANDIDATES: qualify before paying (owner 2026-10-07).
 *
 * human-service hands out the next person of an apollo audience for free (who, and their company),
 * and this service decides whether they are worth their reveal:
 *   1. the AUDIENCE SCREEN: does this person belong to the target audience the client described?
 *      The same yes/no judgment human-service used to run inside serve-next (same input fields,
 *      same question, same `P(yes) > 0.5` rule), now decided and stored here
 *      (`candidate_screenings`); a person offered again after a crash is not judged twice.
 *   2. the MUST-PASS qualification checks of the campaign's OFFER on the person's company
 *      (src/lib/qualification.ts; enabled, mode must_pass, every audience of the offer): a company
 *      that fails one is declined before its reveal is paid. Every check applied is recorded
 *      (`qualification_checks`), which is what the offer's pass rate counts.
 *      A check that cannot answer (no domain, probe failed) does NOT decline: an unknown is not a
 *      no, and declining on it would starve the audience on our own blind spots. It is logged.
 *   3. REVEAL (billed, recorded as served exactly as serve-next) or DECLINE (never offered again
 *      for that audience, the audience size drops by one).
 *
 * Every decision carries a `basis` (screen version + the must-pass set) so human-service measures
 * yield per basis and states exhaustion from it. An audience human-service does not serve through
 * candidates (crm, apify, CRM outreach) answers 422: the caller keeps serve-next for it.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { candidateScreenings, type QualificationCriterionRow } from "../db/schema.js";
import type { OrganizationView } from "./lead-shape.js";
import {
  CandidatesUnsupportedError,
  declineCandidate,
  HumanServiceStalledError,
  nextCandidate,
  revealCandidate,
  type Candidate,
  type ServeNextResult,
  type ServiceContext,
} from "./people-client.js";
import { criterionKey, judge, mustPassCriteria, observe, probeOf, recordCheck, subjectFromOrganization, YES_THRESHOLD } from "./qualification.js";
import { judgeYesNo } from "./qualification-judge.js";
import { walkCandidate, walkContext, type WalkCandidateHandle } from "./serve-walk.js";
import { TregMeter, type SpendIdentity } from "./treg-client.js";
import { createRun, updateRun } from "./runs-client.js";
import { candidateDecisions } from "../db/schema.js";
import {
  decideWithScript,
  decisionScriptSwitch,
  DecisionScriptError,
  findInFlight,
  registerInFlight,
  releaseInFlight,
  type CandidateDecision,
  type DecisionCall,
  type InFlight,
} from "./candidate-decision-script.js";

export const SCREEN_PROMPT_VERSION = "lead-v1";
/** The question human-service's screen asked, verbatim, so verdicts mean the same thing. */
export const SCREEN_QUESTION = "Does this candidate belong to the target audience the client described?";
/** Inside the route's own timeout, like serve-next's 120s walk budget. */
export const CANDIDATE_BUDGET_MS = 110_000;
/**
 * The longest ONE candidate call (next, reveal, decline) may take (DOCDINNERS-SERVE-TIMEOUT-1027). A reveal answers in
 * seconds; one that hung until the caller's 5 minutes ran out took the whole run with it, run after run, on the same
 * candidate. Past this the call is `HumanServiceStalledError`: the caller moves on, nothing is read as exhaustion.
 */
export const CANDIDATE_CALL_TIMEOUT_MS = 90_000;
/** Decline reason of a candidate whose reveal never answered. */
export const REVEAL_STALLED_REASON = "reveal_stalled";

export function targetHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The screen's input: the teaser fields human-service's screen judged, the company domain excluded. */
export function screenSnapshot(c: Candidate) {
  return {
    person: { ...c.person },
    company: {
      name: c.company.name,
      industry: c.company.industry,
      employees: c.company.employees,
      city: c.company.city,
      state: c.company.state,
      country: c.company.country,
      keywords: (c.company.keywords ?? []).slice(0, 20),
    },
  };
}

/** What we know of the candidate's company, in the shape the checks read. Unknown stays null. */
export function organizationFromCandidate(c: Candidate): OrganizationView {
  const nulls = {
    id: "",
    apolloOrganizationId: null,
    websiteUrl: null,
    annualRevenue: null,
    logoUrl: null,
    shortDescription: null,
    linkedinUrl: null,
    twitterUrl: null,
    facebookUrl: null,
    blogUrl: null,
    crunchbaseUrl: null,
    foundedYear: null,
    streetAddress: null,
    postalCode: null,
    technologyNames: null,
    industries: null,
    secondaryIndustries: null,
    latestFundingStage: null,
    latestFundingRoundDate: null,
    totalFunding: null,
    totalFundingPrinted: null,
    fundingEvents: [],
    retailLocationCount: null,
    publiclyTradedSymbol: null,
    publiclyTradedExchange: null,
    primaryPhone: null,
    seoDescription: null,
    angellistUrl: null,
    numSuborganizations: null,
    alexaRanking: null,
  };
  return {
    ...nulls,
    name: c.company.name,
    primaryDomain: c.company.domain,
    industry: c.company.industry,
    estimatedNumEmployees: c.company.employees,
    city: c.company.city,
    state: c.company.state,
    country: c.company.country,
    keywords: c.company.keywords,
  };
}

export function decisionBasis(mustPass: QualificationCriterionRow[]): string {
  const keys = mustPass.map((c) => criterionKey(c.question, probeOf(c))).sort();
  const set = keys.length ? createHash("sha256").update(keys.join(",")).digest("hex").slice(0, 12) : "none";
  return `screen:${SCREEN_PROMPT_VERSION};must:${set}`;
}

interface ScreenVerdict {
  pass: boolean;
  reason: string;
  /** What decided it, for the serve's walk record (serve-walk-rules.ts `screen`). */
  walkInputs: Record<string, unknown>;
}

async function screen(c: Candidate, target: { text: string; field: string } | null, ctx: ServiceContext, identity: SpendIdentity, recordRunId: string = identity.runId): Promise<ScreenVerdict> {
  if (!target?.text?.trim()) return { pass: true, reason: "no_target_text", walkInputs: { noTarget: true } };
  const hash = targetHash(target.text);
  const [prior] = await db
    .select()
    .from(candidateScreenings)
    .where(
      and(
        eq(candidateScreenings.audienceId, c.audienceId),
        eq(candidateScreenings.providerPersonId, c.providerPersonId),
        eq(candidateScreenings.targetHash, hash),
        eq(candidateScreenings.promptVersion, SCREEN_PROMPT_VERSION),
      ),
    )
    .limit(1);
  if (prior) {
    return {
      pass: prior.verdict === "pass",
      reason: prior.reason ?? "",
      walkInputs: { cached: prior.verdict, yesProbability: prior.yesProbability ?? null, threshold: YES_THRESHOLD, targetHash: hash, promptVersion: SCREEN_PROMPT_VERSION },
    };
  }

  const { probabilities, model } = await judgeYesNo(
    { targetAudience: target.text, candidate: screenSnapshot(c) },
    { answer: { instructions: SCREEN_QUESTION } },
    identity,
  );
  const p = probabilities.answer;
  const pass = p > YES_THRESHOLD;
  const reason = `P(yes)=${p.toFixed(3)} threshold>${YES_THRESHOLD}`;
  await db
    .insert(candidateScreenings)
    .values({
      orgId: ctx.orgId,
      brandId: ctx.brandId ?? "",
      audienceId: c.audienceId,
      providerPersonId: c.providerPersonId,
      candidateId: c.candidateId,
      targetHash: hash,
      targetText: target.text,
      promptVersion: SCREEN_PROMPT_VERSION,
      verdict: pass ? "pass" : "reject",
      yesProbability: p,
      reason,
      model,
      // The serve's run, as before (the judgment's spend may hang on a decision's own run).
      runId: recordRunId,
      companyDomain: c.company.domain,
      companyName: c.company.name,
    })
    .onConflictDoNothing();
  return { pass, reason, walkInputs: { cached: null, yesProbability: p, threshold: YES_THRESHOLD, targetHash: hash, promptVersion: SCREEN_PROMPT_VERSION } };
}

/** The first must-pass check the company fails, or null. An unanswerable check never declines. */
async function failedMustPass(
  c: Candidate,
  mustPass: QualificationCriterionRow[],
  meter: TregMeter,
  identity: SpendIdentity,
  /** Each check's answer, in order, for the serve's walk record (serve-walk-rules.ts `must_pass`). */
  verdicts: Array<{ criterionId: string; verdict: string; reason: string | null }> = [],
): Promise<string | null> {
  if (mustPass.length === 0) return null;
  const org = organizationFromCandidate(c);
  const subject = subjectFromOrganization(org);
  const who = `candidate:${c.audienceId}:${c.providerPersonId}`;
  if (!subject) {
    console.log(`[lead-service] candidate ${c.candidateId} has no company domain: must-pass checks cannot answer, not declined on them`);
    for (const criterion of mustPass) {
      await recordCheck({ criterion, subject: who, domain: null, verdictId: null, reason: "no_company_domain", runId: identity.runId });
      verdicts.push({ criterionId: criterion.id, verdict: "unavailable", reason: "no_company_domain" });
    }
    return null;
  }
  for (const criterion of mustPass) {
    const spec = probeOf(criterion);
    const observed = await observe(spec, subject, org, { meter, identity });
    const { verdict } = await judge({ question: criterion.question, probe: spec }, observed.observation, subject, { meter, identity });
    await recordCheck({ criterion, subject: who, domain: subject.domain, verdictId: verdict.id, reason: verdict.reason, runId: identity.runId });
    verdicts.push({ criterionId: criterion.id, verdict: verdict.verdict, reason: verdict.reason ?? null });
    if (verdict.verdict === "no") return `criterion_failed:${criterion.id}`;
    if (verdict.verdict === "unavailable") {
      console.log(`[lead-service] must-pass ${criterion.id} could not answer for ${subject.domain} (${verdict.reason}): not declined on it`);
    }
  }
  return null;
}

/**
 * The next person of this audience worth paying for, revealed and recorded as served by
 * human-service, in serve-next's own result shape. Returns null when human-service does not
 * serve this audience through candidates (the caller uses serve-next). `offerId` is the
 * campaign's offer: its must-pass checks apply (null only when the campaign could not say it).
 */
export async function serveThroughCandidates(
  audienceId: string,
  ctx: ServiceContext,
  offerId: string | null,
  signal?: AbortSignal,
  /** When the caller's own walk stops starting new work (ms since epoch); the budget never runs past it. */
  walkDeadline?: number,
): Promise<ServeNextResult | null> {
  if (!ctx.runId) throw new Error("[lead-service] serving through candidates needs the serve's run id");
  const identity: SpendIdentity = {
    orgId: ctx.orgId,
    userId: ctx.userId ?? null,
    runId: ctx.runId,
    brandId: ctx.brandId ?? null,
    campaignId: ctx.campaignId ?? null,
    workflowSlug: ctx.workflowSlug ?? null,
    featureSlug: ctx.featureSlug ?? null,
  };
  const deadline = Math.min(Date.now() + CANDIDATE_BUDGET_MS, walkDeadline ?? Number.POSITIVE_INFINITY);
  let mustPass: QualificationCriterionRow[] | null = null;
  const meter = new TregMeter(identity);

  while (Date.now() < deadline && !signal?.aborted) {
    let next;
    try {
      next = await nextCandidate(audienceId, ctx, CANDIDATE_CALL_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CandidatesUnsupportedError) return null;
      throw error;
    }
    if (next.status === "pending") return { status: "pending", person: null };
    if (next.status === "exhausted" || !next.candidate) {
      // Carry human-service's own reason (no_recent_posts is not exhaustion); absent stays absent.
      return next.reason ? { status: "exhausted", person: null, reason: next.reason } : { status: "exhausted", person: null };
    }
    const candidate = next.candidate;

    if (mustPass === null) {
      mustPass = ctx.brandId ? await mustPassCriteria(ctx.orgId, ctx.brandId, offerId) : [];
    }
    const basis = decisionBasis(mustPass);
    const walked = walkCandidate("candidates", `candidate:${candidate.candidateId}`);
    walkContext({ candidateBasis: basis });

    const hasTarget = !!next.target?.text?.trim();
    const decided: CandidateCtx = { audienceId, candidate, target: next.target, mustPass, basis, ctx, identity, meter, walked };
    const choose = await decisionScriptSwitch();
    const outcome =
      choose.switched && choose.dynasty ? await decideByScript(choose.dynasty, decided, hasTarget) : await decideHere(decided, hasTarget);
    if (outcome.decision === "served" && outcome.revealed?.person) {
      // Decided further once filed as a lead (journalist, fresh contacts: buffer.ts recordServed).
      return { status: "served", person: outcome.revealed.person, personId: outcome.revealed.personId, emailVerdict: outcome.revealed.emailVerdict };
    }
    if (outcome.decision === "not_served") console.log(`[lead-service] candidate ${candidate.candidateId} revealed but not served; asking the next one`);
  }
  return { status: "pending", person: null };
}

// ─── FACTORY-P3 next outcomes (lead_identified): one candidate's DECISION ─────────────────────────────────────────────
//
// Four calls, each run by THIS code exactly as before (and by the stored script through its doors, below): the
// screen (Jev, stored screening, reuse), the must-pass checks, the reveal, the decline. Each is recorded in the stored
// script's words, so a decision made here is a case the script is proven on.

/** A candidate being decided, as every call reads it. */
export interface CandidateCtx {
  audienceId: string;
  candidate: Candidate;
  target: { text: string; field: string } | null;
  mustPass: QualificationCriterionRow[];
  basis: string;
  ctx: ServiceContext;
  identity: SpendIdentity;
  meter: TregMeter;
  walked: WalkCandidateHandle;
  /** The run a judgment's spend hangs under (the decision's own run here, the script's run on a door). */
  judgeRunId?: string;
  /** Set by a reveal that never answered: a decline that then fails re-throws THIS (as before). */
  stalled?: HumanServiceStalledError;
}

export const SCREEN_CALL = "lead.candidate.screen";
export const MUST_PASS_CALL = "lead.candidate.must_pass";
export const REVEAL_CALL = "lead.candidate.reveal";
export const DECLINE_CALL = "lead.candidate.decline";
export const DECISION_TASK = "candidate-decision";

/** The screen: the answer the script reads (the yes-probability, or the verdict a prior screening stored). */
export async function screenCall(d: CandidateCtx): Promise<Record<string, unknown>> {
  const identity = d.judgeRunId ? { ...d.identity, runId: d.judgeRunId } : d.identity;
  const screened = await screen(d.candidate, d.target, d.ctx, identity, d.identity.runId);
  const passed = d.walked.check("screen", { audienceId: d.audienceId, providerPersonId: d.candidate.providerPersonId, ...screened.walkInputs }, screened.pass);
  if (!passed) d.walked.skip();
  const cached = typeof screened.walkInputs.cached === "string" ? screened.walkInputs.cached : null;
  return { yesProbability: typeof screened.walkInputs.yesProbability === "number" ? screened.walkInputs.yesProbability : null, cached, ...(cached ? { reason: screened.reason } : {}) };
}

export async function mustPassCall(d: CandidateCtx): Promise<Record<string, unknown>> {
  const verdicts: Array<{ criterionId: string; verdict: string; reason: string | null }> = [];
  const failed = await failedMustPass(d.candidate, d.mustPass, d.meter, d.identity, verdicts);
  if (d.mustPass.length > 0) d.walked.check("must_pass", { verdicts }, failed === null);
  if (failed) d.walked.skip();
  return { failed };
}

/** The reveal: served, not served, or stalled (never answered: the decision then declines it). */
export async function revealCall(d: CandidateCtx): Promise<{ answer: Record<string, unknown>; revealed: Awaited<ReturnType<typeof revealCandidate>> | null }> {
  let revealed;
  try {
    revealed = await revealCandidate(d.audienceId, d.candidate.candidateId, d.basis, d.ctx, CANDIDATE_CALL_TIMEOUT_MS);
  } catch (error) {
    if (!(error instanceof HumanServiceStalledError)) throw error;
    // DOCDINNERS-SERVE-TIMEOUT-1027: the same candidate hung every run, so its audience never served anyone again.
    console.error(`[lead-service] candidate ${d.candidate.candidateId} audience=${d.audienceId}: ${error.message}; declining it`);
    d.walked.check("reveal", { status: REVEAL_STALLED_REASON, timeoutMs: error.timeoutMs }, false);
    d.walked.skip();
    d.stalled = error;
    return { answer: { status: "stalled", timeoutMs: error.timeoutMs }, revealed: null };
  }
  const served = revealed.status === "served" && !!revealed.person;
  d.walked.check("reveal", { status: served ? "served" : revealed.status }, served);
  if (!served) d.walked.skip();
  return { answer: { status: served ? "served" : "not_served" }, revealed };
}

export async function declineCall(d: CandidateCtx, reason: string): Promise<Record<string, unknown>> {
  try {
    await declineCandidate(d.audienceId, d.candidate.candidateId, reason, d.basis, d.ctx, CANDIDATE_CALL_TIMEOUT_MS);
  } catch (declineError) {
    if (!d.stalled) throw declineError;
    console.error(`[lead-service] candidate ${d.candidate.candidateId} audience=${d.audienceId}: decline after a stalled reveal failed:`, declineError);
    throw d.stalled;
  }
  return { declined: true };
}

/** One call, recorded as the script's door answers it: its answer, or the refusal (re-thrown). */
async function recorded<T>(calls: DecisionCall[], name: string, args: Record<string, unknown>, call: () => Promise<T>, answerOf: (t: T) => Record<string, unknown> = (t) => t as unknown as Record<string, unknown>): Promise<T> {
  try {
    const out = await call();
    calls.push({ name, args, answer: { ok: true, data: answerOf(out) } });
    return out;
  } catch (error) {
    calls.push({ name, args, answer: { ok: false, data: { error: messageOf(error) } } });
    throw error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Revealed = Awaited<ReturnType<typeof revealCandidate>> | null;

/** Our own decision, on its own `candidate-decision` run (child of the serve's run): Monitoring's service path. */
async function decideHere(d: CandidateCtx, hasTarget: boolean): Promise<{ decision: CandidateDecision; revealed: Revealed }> {
  const id0 = d.identity;
  const run = await createRun({
    orgId: id0.orgId,
    serviceName: "lead-service",
    taskName: DECISION_TASK,
    parentRunId: id0.runId,
    ...(id0.userId ? { userId: id0.userId } : {}),
    ...(id0.brandId ? { brandId: id0.brandId } : {}),
    ...(id0.campaignId ? { campaignId: id0.campaignId } : {}),
    ...(id0.workflowSlug ? { workflowSlug: id0.workflowSlug } : {}),
    ...(id0.featureSlug ? { featureSlug: id0.featureSlug } : {}),
  });
  const own: CandidateCtx = { ...d, judgeRunId: run.id };
  const calls: DecisionCall[] = [];
  const id = d.candidate.candidateId;
  const decline = async (reason: string) => recorded(calls, DECLINE_CALL, { candidateId: id, reason }, () => declineCall(own, reason));
  try {
    let decision: CandidateDecision;
    let revealed: Revealed = null;
    decide: {
      if (hasTarget) {
        const s = await recorded(calls, SCREEN_CALL, { candidateId: id }, () => screenCall(own));
        const verdict = screenVerdict(s);
        if (!verdict.pass) {
          await decline(`screen_rejected ${verdict.reason}`);
          decision = "declined";
          break decide;
        }
      }
      const m = await recorded(calls, MUST_PASS_CALL, { candidateId: id }, () => mustPassCall(own));
      if (typeof m.failed === "string") {
        await decline(m.failed);
        decision = "declined";
        break decide;
      }
      const r = await recorded(calls, REVEAL_CALL, { candidateId: id }, () => revealCall(own), (x) => x.answer);
      revealed = r.revealed;
      if (r.answer.status === "stalled") {
        await decline(`${REVEAL_STALLED_REASON} after ${String(r.answer.timeoutMs)}ms`);
        decision = "stalled";
      } else decision = r.answer.status === "served" ? "served" : "not_served";
    }
    await closeRun(run.id, "completed", d.identity);
    await recordDecision(d, { path: "service", runId: run.id, hasTarget, calls, decision, error: null });
    return { decision, revealed };
  } catch (error) {
    await closeRun(run.id, "failed", d.identity);
    await recordDecision(d, { path: "service", runId: run.id, hasTarget, calls, decision: null, error: messageOf(error) });
    throw error;
  }
}

/** The screen's rule on the screen call's answer (the stored script's own rule, mirrored for our path). */
function screenVerdict(s: Record<string, unknown>): { pass: boolean; reason: string } {
  if (typeof s.cached === "string") return { pass: s.cached === "pass", reason: String(s.reason ?? "") };
  const p = Number(s.yesProbability);
  return { pass: p > YES_THRESHOLD, reason: `P(yes)=${p.toFixed(3)} threshold>${YES_THRESHOLD}` };
}

async function closeRun(runId: string, status: "completed" | "failed", identity: SpendIdentity): Promise<void> {
  try {
    await updateRun(runId, status, { orgId: identity.orgId, ...(identity.userId ? { userId: identity.userId } : {}) });
  } catch (error) {
    console.error(`[lead-service] candidate-decision run ${runId} not closed ${status}: ${messageOf(error)}`);
  }
}

/** The stored script decides; its doors run each call here, the judgment's spend on the script's run. */
async function decideByScript(dynasty: string, d: CandidateCtx, hasTarget: boolean): Promise<{ decision: CandidateDecision; revealed: Revealed }> {
  const serveRunId = d.identity.runId;
  const entry = registerInFlight(serveRunId, d.candidate.candidateId, d);
  try {
    const out = await decideWithScript({
      dynasty,
      orgId: d.identity.orgId,
      userId: d.identity.userId,
      serveRunId,
      tracking: { brandId: d.identity.brandId, campaignId: d.identity.campaignId, workflowSlug: d.identity.workflowSlug, featureSlug: d.identity.featureSlug },
      candidateId: d.candidate.candidateId,
      hasTarget,
    });
    await recordDecision(d, { path: "script", runId: out.runId, hasTarget, calls: entry.calls, decision: out.decision, error: null });
    return { decision: out.decision, revealed: entry.revealed as Revealed };
  } catch (error) {
    await recordDecision(d, { path: "script", runId: error instanceof DecisionScriptError ? error.runId : null, hasTarget, calls: entry.calls, decision: null, error: messageOf(error) });
    if (entry.thrown) throw entry.thrown;
    throw error;
  } finally {
    releaseInFlight(serveRunId, entry as InFlight<unknown>);
  }
}

/** Fail-soft: the serve is the product, its decision record is evidence (personal data: never logged). */
async function recordDecision(d: CandidateCtx, r: { path: "service" | "script"; runId: string | null; hasTarget: boolean; calls: DecisionCall[]; decision: CandidateDecision | null; error: string | null }): Promise<void> {
  try {
    await db.insert(candidateDecisions).values({
      orgId: d.identity.orgId,
      serveRunId: d.identity.runId,
      runId: r.runId,
      audienceId: d.audienceId,
      candidateId: d.candidate.candidateId,
      path: r.path,
      hasTarget: r.hasTarget,
      calls: r.calls,
      decision: r.decision,
      error: r.error ? r.error.slice(0, 1000) : null,
    });
  } catch (error) {
    console.error(`[lead-service] candidate decision NOT recorded (the serve stands): ${messageOf(error)}`);
  }
}

/**
 * A door of the stored decision (`POST /internal/candidate-decisions/<call>`): only for a candidate in flight here
 * (serve run x candidate), the judgment's spend on the SCRIPT's run. Keeps the error our own code would have thrown.
 */
export async function doorCall(input: { callerRunId: string; scriptRunId: string; call: string; candidateId: string; reason?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const entry = findInFlight<CandidateCtx>(input.callerRunId, input.candidateId);
  if (!entry) return { status: 409, body: { error: `no candidate ${input.candidateId} in flight for run ${input.callerRunId}` } };
  const d = entry.ctx;
  d.judgeRunId = input.scriptRunId;
  const args: Record<string, unknown> = { candidateId: input.candidateId, ...(input.call === DECLINE_CALL ? { reason: input.reason } : {}) };
  try {
    let data: Record<string, unknown>;
    if (input.call === SCREEN_CALL) data = await screenCall(d);
    else if (input.call === MUST_PASS_CALL) data = await mustPassCall(d);
    else if (input.call === REVEAL_CALL) {
      const r = await revealCall(d);
      entry.revealed = r.revealed;
      data = r.answer;
    } else if (input.call === DECLINE_CALL) {
      if (!input.reason) return { status: 400, body: { error: "a decline needs its reason" } };
      data = await declineCall(d, input.reason);
    } else return { status: 400, body: { error: `no call named ${input.call}` } };
    entry.calls.push({ name: input.call, args, answer: { ok: true, data } });
    return { status: 200, body: data };
  } catch (error) {
    entry.thrown = error instanceof Error ? error : new Error(String(error));
    entry.calls.push({ name: input.call, args, answer: { ok: false, data: { error: messageOf(error) } } });
    return { status: 502, body: { error: messageOf(error) } };
  }
}
