/**
 * Serving a person through CANDIDATES: qualify before paying (owner 2026-10-07).
 *
 * human-service hands out the next person of an apollo audience for free (who, and their company),
 * and this service decides whether they are worth their reveal:
 *   1. the AUDIENCE SCREEN: does this person belong to the target audience the client described?
 *      The same yes/no judgment human-service used to run inside serve-next (same input fields,
 *      same question, same `P(yes) > 0.5` rule), now decided and stored here
 *      (`candidate_screenings`); a person offered again after a crash is not judged twice.
 *   2. the brand's MUST-PASS qualification checks on the person's company
 *      (src/lib/qualification.ts): a company that fails one is declined before its reveal is paid.
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
  nextCandidate,
  revealCandidate,
  type Candidate,
  type ServeNextResult,
  type ServiceContext,
} from "./people-client.js";
import { criterionKey, judge, listCriteria, observe, probeOf, subjectFromOrganization, YES_THRESHOLD } from "./qualification.js";
import { judgeYesNo } from "./qualification-judge.js";
import { TregMeter, type SpendIdentity } from "./treg-client.js";

export const SCREEN_PROMPT_VERSION = "lead-v1";
/** The question human-service's screen asked, verbatim, so verdicts mean the same thing. */
export const SCREEN_QUESTION = "Does this candidate belong to the target audience the client described?";
/** Inside the route's own timeout, like serve-next's 120s walk budget. */
export const CANDIDATE_BUDGET_MS = 110_000;

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
}

async function screen(c: Candidate, target: { text: string; field: string } | null, ctx: ServiceContext, identity: SpendIdentity): Promise<ScreenVerdict> {
  if (!target?.text?.trim()) return { pass: true, reason: "no_target_text" };
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
  if (prior) return { pass: prior.verdict === "pass", reason: prior.reason ?? "" };

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
      runId: identity.runId,
    })
    .onConflictDoNothing();
  return { pass, reason };
}

/** The first must-pass check the company fails, or null. An unanswerable check never declines. */
async function failedMustPass(c: Candidate, mustPass: QualificationCriterionRow[], meter: TregMeter, identity: SpendIdentity): Promise<string | null> {
  if (mustPass.length === 0) return null;
  const org = organizationFromCandidate(c);
  const subject = subjectFromOrganization(org);
  if (!subject) {
    console.log(`[lead-service] candidate ${c.candidateId} has no company domain: must-pass checks cannot answer, not declined on them`);
    return null;
  }
  for (const criterion of mustPass) {
    const spec = probeOf(criterion);
    const observed = await observe(spec, subject, org, { meter, identity });
    const { verdict } = await judge({ question: criterion.question, probe: spec }, observed.observation, subject, { meter, identity });
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
 * serve this audience through candidates (the caller uses serve-next).
 */
export async function serveThroughCandidates(audienceId: string, ctx: ServiceContext, signal?: AbortSignal): Promise<ServeNextResult | null> {
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
  const deadline = Date.now() + CANDIDATE_BUDGET_MS;
  let mustPass: QualificationCriterionRow[] | null = null;
  const meter = new TregMeter(identity);

  while (Date.now() < deadline && !signal?.aborted) {
    let next;
    try {
      next = await nextCandidate(audienceId, ctx);
    } catch (error) {
      if (error instanceof CandidatesUnsupportedError) return null;
      throw error;
    }
    if (next.status === "pending") return { status: "pending", person: null };
    if (next.status === "exhausted" || !next.candidate) return { status: "exhausted", person: null };
    const candidate = next.candidate;

    if (mustPass === null) {
      mustPass = ctx.brandId ? (await listCriteria(ctx.orgId, ctx.brandId)).filter((c) => c.mode === "must_pass") : [];
    }
    const basis = decisionBasis(mustPass);

    const screened = await screen(candidate, next.target, ctx, identity);
    if (!screened.pass) {
      await declineCandidate(audienceId, candidate.candidateId, `screen_rejected ${screened.reason}`, basis, ctx);
      continue;
    }
    const failed = await failedMustPass(candidate, mustPass, meter, identity);
    if (failed) {
      await declineCandidate(audienceId, candidate.candidateId, failed, basis, ctx);
      continue;
    }

    const revealed = await revealCandidate(audienceId, candidate.candidateId, basis, ctx);
    if (revealed.status === "served" && revealed.person) {
      return { status: "served", person: revealed.person, personId: revealed.personId };
    }
    // Revealed but nobody servable came out (no deliverable email): the next candidate.
    console.log(`[lead-service] candidate ${candidate.candidateId} revealed but not served; asking the next one`);
  }
  return { status: "pending", person: null };
}
