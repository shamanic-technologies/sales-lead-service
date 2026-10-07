/**
 * QUALIFICATION CHECKS: does a lead's COMPANY meet a business condition the client cares about
 * (site slow on mobile, hiring support staff, posts on LinkedIn...), with the evidence in plain
 * words so whatever writes the email can cite it.
 *
 * Ownership (owner, 2026-10-07): human-service says WHO a person is; whether my leads MEET a
 * business condition is decided HERE.
 *
 * The model, four rules:
 * (1) A criterion = ONE probe from the catalogue (src/lib/qualification-probes.ts) + ONE yes/no
 *     question. The AI that suggests criteria picks probes; it never composes a pipeline. So the
 *     price of a row is known before the client turns a check on.
 * (2) Everything is keyed on the company DOMAIN, never the lead: an OBSERVATION (what a probe saw)
 *     is keyed (probe, domain) and serves every lead at that company, for every client, for
 *     OBSERVATION_FRESH_DAYS. A VERDICT is keyed (question+probe, observation) and frozen with the
 *     model release that made it (same doctrine as crm_pairing_judgments). A second lead at the
 *     same company is neither re-observed nor re-judged nor re-billed.
 * (3) FAIL LOUD, never a silent no: a probe that could not produce a result, or an observation
 *     that cannot answer the question, is `unavailable` with a reason. Only an observation that
 *     answers yields `yes`/`no`.
 * (4) All spend is the requesting org's: treg calls are metered here (src/lib/treg-client.ts),
 *     judgments and writing through chat-service, screenshot storage through cloudflare-service,
 *     all on one run, so every cent is in runs under a seeded cost name.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  qualificationCriteria,
  qualificationObservations,
  qualificationVerdicts,
  type QualificationCriterionRow,
  type QualificationObservationRow,
  type QualificationVerdictRow,
} from "../db/schema.js";
import { complete, stripDashes } from "./chat-complete-client.js";
import { storeImage } from "./image-store-client.js";
import type { OrganizationView } from "./lead-shape.js";
import { priceCentsPerUnit } from "./price-client.js";
import { MAX_STATE_CHARS, judgeYesNo } from "./qualification-judge.js";
import {
  BUILTIN_PROBES,
  MissingCompanyFactError,
  bindCall,
  catalogEntryToCall,
  probeKey,
  type CompanySubject,
  type ProbeSpec,
  type QualificationVerdict,
} from "./qualification-probes.js";
import { getCatalogEntry } from "./treg-catalog-client.js";
import { InsufficientCreditError, TREG_COST_NAME, TregMeter, isTregRefusal, type SpendIdentity } from "./treg-client.js";

export { QUALIFICATION_MODES, QUALIFICATION_VERDICTS } from "./qualification-probes.js";
export type { QualificationMode, QualificationVerdict } from "./qualification-probes.js";

export const OBSERVATION_FRESH_DAYS = 30;
/** A failed observation is retried after a day, not re-paid on every lead of the same company. */
export const UNAVAILABLE_FRESH_HOURS = 24;
export const YES_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------------------------

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

/** The company a lead's checks are about, or null when we hold no usable domain for it. */
export function subjectFromOrganization(org: OrganizationView | null): CompanySubject | null {
  if (!org) return null;
  const domain = normalizeDomain(org.primaryDomain) ?? normalizeDomain(org.websiteUrl);
  if (!domain) return null;
  return {
    domain,
    websiteUrl: `https://${domain}`,
    companyName: org.name ?? null,
    companyLinkedinUrl: org.linkedinUrl ?? null,
  };
}

/** The firmographics `company_data` judges: only facts we hold, never an invented one. */
export function companyDataContent(org: OrganizationView): string {
  const facts: Record<string, unknown> = {
    name: org.name,
    domain: org.primaryDomain,
    industry: org.industry,
    industries: org.industries,
    employees: org.estimatedNumEmployees,
    annualRevenue: org.annualRevenue,
    foundedYear: org.foundedYear,
    city: org.city,
    state: org.state,
    country: org.country,
    shortDescription: org.shortDescription,
    seoDescription: org.seoDescription,
    keywords: org.keywords,
    technologies: org.technologyNames,
    latestFundingStage: org.latestFundingStage,
    latestFundingRoundDate: org.latestFundingRoundDate,
    totalFunding: org.totalFundingPrinted ?? org.totalFunding,
    publiclyTraded: org.publiclyTradedSymbol,
  };
  for (const k of Object.keys(facts)) {
    const v = facts[k];
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) delete facts[k];
  }
  return JSON.stringify(facts);
}

// ---------------------------------------------------------------------------------------------
// Identity of a criterion's judgment
// ---------------------------------------------------------------------------------------------

/** Two criteria asking the same question through the same probe share their verdicts. */
export function criterionKey(question: string, spec: ProbeSpec): string {
  const q = question.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(`${JUDGE_VERSION}\n${q}\n${probeKey(spec)}`).digest("hex");
}

/**
 * Bumped whenever what the judge is asked changes, so verdicts frozen under the old wording are
 * re-judged on their stored observation (no probe is paid again). v2: the readability gate asks
 * whether the observation is a usable reading of THIS company's source, never whether it "contains
 * enough to answer" (a full homepage with no newsletter form IS the answer no; v1 read it as
 * unavailable on 5 of 12 prod leads). v3: evidence written with thinking off (v2 sentences were cut).
 */
export const JUDGE_VERSION = "v3";

export function probeLabel(spec: ProbeSpec): string {
  return spec.kind === "company_data" ? "Company data we hold" : spec.label;
}

// ---------------------------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------------------------

/** What the judge reads from a provider answer: the routed `output` when treg wraps one. */
export function contentOfAnswer(body: unknown): string {
  let v = body;
  if (v && typeof v === "object" && "output" in (v as Record<string, unknown>) && "_treg" in (v as Record<string, unknown>)) {
    v = (v as Record<string, unknown>).output;
  }
  // A scraper's page text, without its envelope (bytes, cache, ladder...): what the judge should read.
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).markdown === "string") {
    v = (v as Record<string, unknown>).markdown;
  }
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > MAX_STATE_CHARS ? s.slice(0, MAX_STATE_CHARS) : s;
}

/** The first image URL anywhere in a provider answer (a screenshot provider returns a CDN link). */
export function findImageUrl(body: unknown): string | null {
  const stack: unknown[] = [body];
  let fallback: string | null = null;
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (/^https?:\/\/\S+\.(png|jpe?g|webp)(\?\S*)?$/i.test(v)) return v;
      continue;
    }
    if (Array.isArray(v)) {
      stack.push(...v);
      continue;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string" && /screenshot|image/i.test(k) && /^https?:\/\//.test(val)) fallback = fallback ?? val;
        stack.push(val);
      }
    }
  }
  return fallback;
}

const VISION_PROMPT =
  "You look at the first screen of a company's homepage for a sales researcher. Describe only what is visible, " +
  "in plain words, under 120 words: the main headline (quote it), what the company offers as stated on screen, " +
  "whether a call-to-action button is visible and its text, any sign-up or newsletter form, and how the page looks " +
  "(clean or cluttered, modern or dated, readable or not). Do not guess anything that is not visible.";

async function freshObservation(key: string, domain: string): Promise<QualificationObservationRow | null> {
  const okSince = new Date(Date.now() - OBSERVATION_FRESH_DAYS * 86_400_000).toISOString();
  const [ok] = await db
    .select()
    .from(qualificationObservations)
    .where(and(eq(qualificationObservations.probeKey, key), eq(qualificationObservations.domain, domain), eq(qualificationObservations.status, "ok"), gt(qualificationObservations.observedAt, new Date(okSince))))
    .orderBy(desc(qualificationObservations.observedAt))
    .limit(1);
  if (ok) return ok;
  const failedSince = new Date(Date.now() - UNAVAILABLE_FRESH_HOURS * 3_600_000);
  const [failed] = await db
    .select()
    .from(qualificationObservations)
    .where(and(eq(qualificationObservations.probeKey, key), eq(qualificationObservations.domain, domain), eq(qualificationObservations.status, "unavailable"), gt(qualificationObservations.observedAt, failedSince)))
    .orderBy(desc(qualificationObservations.observedAt))
    .limit(1);
  return failed ?? null;
}

async function recordObservation(row: Omit<typeof qualificationObservations.$inferInsert, "id" | "observedAt">): Promise<QualificationObservationRow> {
  const [inserted] = await db.insert(qualificationObservations).values(row).returning();
  return inserted;
}

export interface ObserveResult {
  observation: QualificationObservationRow;
  reused: boolean;
  chargedMicro: number;
}

export interface QualificationDeps {
  meter: TregMeter;
  identity: SpendIdentity;
}

export async function observe(spec: ProbeSpec, subject: CompanySubject, org: OrganizationView, deps: QualificationDeps): Promise<ObserveResult> {
  const key = probeKey(spec);
  const prior = await freshObservation(key, subject.domain);
  if (prior) return { observation: prior, reused: true, chargedMicro: 0 };

  if (spec.kind === "company_data") {
    const observation = await recordObservation({
      probeKey: key,
      domain: subject.domain,
      status: "ok",
      content: companyDataContent(org),
      vendorCostMicro: 0,
      runId: deps.identity.runId,
    });
    return { observation, reused: false, chargedMicro: 0 };
  }

  let charged = 0;
  const reasons: string[] = [];
  for (const call of spec.calls) {
    let params;
    try {
      params = bindCall(call, subject);
    } catch (error) {
      if (error instanceof MissingCompanyFactError) {
        reasons.push(`${call.endpointId}: ${error.message}`);
        continue;
      }
      throw error;
    }
    const result = await deps.meter.call({ endpointId: call.endpointId, method: call.method, params, maxMicro: call.maxMicro });
    charged += result.chargedMicro;
    if (result.status < 200 || result.status >= 300 || isTregRefusal(result.status, result.body)) {
      reasons.push(`${call.endpointId}: HTTP ${result.status} ${contentOfAnswer(result.body).slice(0, 160)}`);
      continue;
    }

    if (spec.reading === "screenshot") {
      const providerUrl = findImageUrl(result.body);
      if (!providerUrl) {
        reasons.push(`${call.endpointId}: answered without an image`);
        continue;
      }
      const imageUrl = await storeImage(providerUrl, `${subject.domain}-${Date.now()}.png`, deps.identity);
      const described = await complete({ systemPrompt: VISION_PROMPT, message: `Homepage of ${subject.domain}.`, imageUrl, maxTokens: 400 }, deps.identity);
      const observation = await recordObservation({
        probeKey: key,
        domain: subject.domain,
        status: "ok",
        endpointId: call.endpointId,
        content: stripDashes(described.content),
        imageUrl,
        vendorCostMicro: charged,
        runId: deps.identity.runId,
      });
      return { observation, reused: false, chargedMicro: charged };
    }

    const observation = await recordObservation({
      probeKey: key,
      domain: subject.domain,
      status: "ok",
      endpointId: call.endpointId,
      content: contentOfAnswer(result.body),
      vendorCostMicro: charged,
      runId: deps.identity.runId,
    });
    return { observation, reused: false, chargedMicro: charged };
  }

  const observation = await recordObservation({
    probeKey: key,
    domain: subject.domain,
    status: "unavailable",
    reason: reasons.join(" | ").slice(0, 2000) || "no provider answered",
    vendorCostMicro: charged,
    runId: deps.identity.runId,
  });
  return { observation, reused: false, chargedMicro: charged };
}

// ---------------------------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------------------------

const EVIDENCE_PROMPT =
  "You state ONE measured fact that answers a yes/no question about a company, for a salesperson who will cite it " +
  "in an email. One sentence, under 30 words, plain words, concrete figures and dates taken from the observation " +
  "(\"last LinkedIn post 5 months ago\", \"no sign-up form on the homepage\"). Never invent a figure. No dashes.";

export interface JudgeResult {
  verdict: QualificationVerdictRow;
  reused: boolean;
}

export async function judge(criterion: { question: string; probe: ProbeSpec }, observation: QualificationObservationRow, subject: CompanySubject, deps: QualificationDeps): Promise<JudgeResult> {
  const key = criterionKey(criterion.question, criterion.probe);
  const [prior] = await db
    .select()
    .from(qualificationVerdicts)
    .where(and(eq(qualificationVerdicts.criterionKey, key), eq(qualificationVerdicts.observationId, observation.id)))
    .limit(1);
  if (prior) return { verdict: prior, reused: true };

  let row: typeof qualificationVerdicts.$inferInsert;
  if (observation.status !== "ok" || !observation.content) {
    row = { criterionKey: key, domain: subject.domain, observationId: observation.id, verdict: "unavailable", reason: `probe_failed: ${observation.reason ?? "no content"}`, runId: deps.identity.runId };
  } else {
    const state = {
      company: { name: subject.companyName, domain: subject.domain },
      source: probeLabel(criterion.probe),
      observedAt: observation.observedAt,
      observation: observation.content,
    };
    const { probabilities, model } = await judgeYesNo(
      state,
      {
        answerable: {
          instructions: `Is this observation a usable reading of the company's ${probeLabel(criterion.probe).toLowerCase()}?`,
          whenTrue:
            "It is a real reading of this company's source, so whatever it shows or does not show is a fact about the company. The absence of something in a complete reading counts as an answer.",
          whenFalse: "It is empty, an error page, a cookie or login wall, a bot challenge, or clearly about another company.",
        },
        holds: {
          instructions: criterion.question,
          whenTrue: "The observation shows the condition holds for this company.",
          whenFalse: "The observation shows the condition does not hold for this company.",
        },
      },
      deps.identity,
    );
    if (probabilities.answerable < YES_THRESHOLD) {
      row = { criterionKey: key, domain: subject.domain, observationId: observation.id, verdict: "unavailable", yesProbability: probabilities.holds, reason: `observation_cannot_answer: P(answerable)=${probabilities.answerable.toFixed(3)}`, judgmentModel: model, runId: deps.identity.runId };
    } else {
      const verdict: QualificationVerdict = probabilities.holds > YES_THRESHOLD ? "yes" : "no";
      const evidence = await complete(
        {
          systemPrompt: EVIDENCE_PROMPT,
          message: `Company: ${subject.companyName ?? subject.domain} (${subject.domain})\nQuestion: ${criterion.question}\nAnswer: ${verdict}\nSource: ${probeLabel(criterion.probe)}\nObservation:\n${observation.content.slice(0, 60_000)}`,
          maxTokens: 300,
        },
        deps.identity,
      );
      row = { criterionKey: key, domain: subject.domain, observationId: observation.id, verdict, yesProbability: probabilities.holds, evidence: stripDashes(evidence.content), judgmentModel: model, runId: deps.identity.runId };
    }
  }
  const [inserted] = await db.insert(qualificationVerdicts).values(row).onConflictDoNothing().returning();
  if (inserted) return { verdict: inserted, reused: false };
  // A concurrent request froze the same judgment first: that one is the answer.
  const [winner] = await db
    .select()
    .from(qualificationVerdicts)
    .where(and(eq(qualificationVerdicts.criterionKey, key), eq(qualificationVerdicts.observationId, observation.id)))
    .limit(1);
  return { verdict: winner, reused: true };
}

// ---------------------------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------------------------

export function probeOf(row: QualificationCriterionRow): ProbeSpec {
  return row.probe as ProbeSpec;
}

export async function listCriteria(orgId: string, brandId: string): Promise<QualificationCriterionRow[]> {
  return db
    .select()
    .from(qualificationCriteria)
    .where(and(eq(qualificationCriteria.orgId, orgId), eq(qualificationCriteria.brandId, brandId), isNull(qualificationCriteria.archivedAt)))
    .orderBy(qualificationCriteria.createdAt);
}

export async function getCriterion(orgId: string, brandId: string, id: string): Promise<QualificationCriterionRow | null> {
  const [row] = await db
    .select()
    .from(qualificationCriteria)
    .where(and(eq(qualificationCriteria.id, id), eq(qualificationCriteria.orgId, orgId), eq(qualificationCriteria.brandId, brandId), isNull(qualificationCriteria.archivedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * A probe a client may turn on: a built-in key, or treg endpoints that the catalogue says are
 * priced, on the platform key and bindable to company facts. Returns the spec or why not.
 */
export async function resolveProbe(input: { builtin: string } | { tregEndpointIds: string[] }): Promise<{ ok: true; spec: ProbeSpec } | { ok: false; reason: string }> {
  if ("builtin" in input) {
    const b = BUILTIN_PROBES[input.builtin as keyof typeof BUILTIN_PROBES];
    return b ? { ok: true, spec: b.spec } : { ok: false, reason: `unknown built-in probe ${input.builtin}` };
  }
  const calls = [];
  let label: string | null = null;
  for (const id of input.tregEndpointIds) {
    const entry = await getCatalogEntry(id);
    const r = catalogEntryToCall(entry);
    if (!r.ok) return { ok: false, reason: `${id}: ${r.reason}` };
    calls.push(r.call);
    label = label ?? entry.name ?? entry.summary ?? id;
  }
  if (calls.length === 0) return { ok: false, reason: "no endpoint named" };
  const screenshot = calls.some((c) => /screenshot/i.test(c.endpointId));
  return { ok: true, spec: { kind: "treg", label: label ?? calls[0].endpointId, reading: screenshot ? "screenshot" : "text", calls } };
}

// ---------------------------------------------------------------------------------------------
// Estimated cost per row, from catalogue prices (shown before a client turns a check on)
// ---------------------------------------------------------------------------------------------

/** Token sizes the estimate assumes; the sample measures the real figure. */
const EST = { stateTokens: 8_000, questions: 2, evidenceIn: 8_000, evidenceOut: 60, visionIn: 2_000, visionOut: 250 };

export interface CostEstimate {
  perRowUsd: number;
  probeUsd: number;
  aiUsd: number;
  storageUsd: number;
}

export async function estimateCostPerRow(spec: ProbeSpec): Promise<CostEstimate> {
  const [jevIn, liteIn, liteOut] = await Promise.all([
    priceCentsPerUnit("typesafe-jev-1.13-tokens-input"),
    priceCentsPerUnit("google-flash-lite-3.1-tokens-input"),
    priceCentsPerUnit("google-flash-lite-3.1-tokens-output"),
  ]);
  let aiCents = EST.stateTokens * EST.questions * jevIn + EST.evidenceIn * liteIn + EST.evidenceOut * liteOut;
  let probeCents = 0;
  let storageCents = 0;
  if (spec.kind === "treg") {
    // The first provider of the list is the one that answers in the common case.
    const entry = await getCatalogEntry(spec.calls[0].endpointId);
    const r = catalogEntryToCall(entry);
    if (!r.ok) throw new Error(`[lead-service] ${spec.calls[0].endpointId} is no longer usable: ${r.reason}`);
    probeCents = r.vendorUsd * 1_000_000 * (await priceCentsPerUnit(TREG_COST_NAME));
    if (spec.reading === "screenshot") {
      aiCents += EST.visionIn * liteIn + EST.visionOut * liteOut;
      storageCents = await priceCentsPerUnit("cloudflare-r2-class-a-operation");
    }
  }
  const round = (c: number) => Math.round(c * 10_000) / 1_000_000; // cents -> USD, 6 decimals
  return { perRowUsd: round(probeCents + aiCents + storageCents), probeUsd: round(probeCents), aiUsd: round(aiCents), storageUsd: round(storageCents) };
}

export { InsufficientCreditError };
