/**
 * Running a criterion on leads, reading the stored answers back, and suggesting criteria for an
 * OFFER. The model lives in src/lib/qualification.ts.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { leadsCampaigns, qualificationCriteria, qualificationObservations, qualificationVerdicts } from "../db/schema.js";
import { getOfferText } from "./brand-client.js";
import { complete, stripDashes } from "./chat-complete-client.js";
import { buildFullLeadsBatch, type FullLead } from "./lead-shape.js";
import { priceCentsPerUnit } from "./price-client.js";
import {
  criterionKey,
  judge,
  observe,
  probeLabel,
  probeOf,
  recordCheck,
  subjectFromOrganization,
  type OfferScope,
  type QualificationDeps,
  type QualificationMode,
} from "./qualification.js";
import { judgeChoice } from "./qualification-judge.js";
import { BUILTIN_PROBES, BUILTIN_PROBE_KEYS, catalogEntryToCall, type ProbeSpec } from "./qualification-probes.js";
import { searchCatalog } from "./treg-catalog-client.js";
import { TREG_COST_NAME, TregMeter, type SpendIdentity } from "./treg-client.js";
import type { QualificationCriterionRow } from "../db/schema.js";

export { MAX_SAMPLE } from "./qualification-probes.js";
const DOMAIN_CONCURRENCY = 4;

export interface SampleRow {
  leadId: string;
  name: string | null;
  company: string | null;
  domain: string | null;
  verdict: "yes" | "no" | "unavailable";
  yesProbability: number | null;
  evidence: string | null;
  screenshotUrl: string | null;
  reason: string | null;
  /** True when this lead's company had already been checked: nothing was paid for this row. */
  reused: boolean;
  /** What the probe call cost the client for this row, USD (0 when reused). AI cost is on the run. */
  probeCostUsd: number;
}

/** The brand's most recently served leads, one row per person. */
export async function recentServedLeadIds(orgId: string, brandId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ leadId: leadsCampaigns.leadId, servedAt: sql<string>`max(${leadsCampaigns.servedAt})` })
    .from(leadsCampaigns)
    .where(and(eq(leadsCampaigns.orgId, orgId), eq(leadsCampaigns.status, "served"), sql`${brandId} = ANY(${leadsCampaigns.brandIds})`))
    .groupBy(leadsCampaigns.leadId)
    .orderBy(desc(sql`max(${leadsCampaigns.servedAt})`))
    .limit(limit);
  return rows.map((r) => r.leadId);
}

/** Leads among `leadIds` that belong to this org and brand (a foreign id is simply absent). */
export async function leadsOfBrand(orgId: string, brandId: string, leadIds: string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ leadId: leadsCampaigns.leadId })
    .from(leadsCampaigns)
    .where(and(eq(leadsCampaigns.orgId, orgId), sql`${brandId} = ANY(${leadsCampaigns.brandIds})`, sql`${leadsCampaigns.leadId}::text = ANY(${sql.param(leadIds)}::text[])`));
  return new Set(rows.map((r) => r.leadId));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
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

/**
 * Run one criterion on these leads. Leads at the same company are checked ONCE (one domain, one
 * observation, one verdict): the first pays, the others read it back as `reused`.
 */
export async function runCriterionOnLeads(criterion: QualificationCriterionRow, leadIds: string[], identity: SpendIdentity): Promise<SampleRow[]> {
  const spec = probeOf(criterion);
  const deps: QualificationDeps = { meter: new TregMeter(identity), identity };
  const leads = await buildFullLeadsBatch(leadIds);
  const microCents = spec.kind === "treg" ? await priceCentsPerUnit(TREG_COST_NAME) : 0;

  const byDomain = new Map<string, FullLead[]>();
  const rows = new Map<string, SampleRow>();
  for (const id of leadIds) {
    const lead = leads.get(id);
    const subject = subjectFromOrganization(lead?.organization ?? null);
    if (!lead || !subject) {
      rows.set(id, {
        leadId: id,
        name: lead?.name ?? null,
        company: lead?.organization?.name ?? null,
        domain: null,
        verdict: "unavailable",
        yesProbability: null,
        evidence: null,
        screenshotUrl: null,
        reason: lead ? "no_company_domain" : "lead_not_found",
        reused: false,
        probeCostUsd: 0,
      });
      if (lead) await recordCheck({ criterion, subject: `lead:${id}`, domain: null, verdictId: null, reason: "no_company_domain", runId: identity.runId });
      continue;
    }
    const group = byDomain.get(subject.domain) ?? [];
    group.push(lead);
    byDomain.set(subject.domain, group);
  }

  await mapLimit([...byDomain.values()], DOMAIN_CONCURRENCY, async (group) => {
    const first = group[0];
    const org = first.organization!;
    const subject = subjectFromOrganization(org)!;
    const observed = await observe(spec, subject, org, deps);
    const judged = await judge({ question: criterion.question, probe: spec }, observed.observation, subject, deps);
    for (const lead of group) {
      await recordCheck({ criterion, subject: `lead:${lead.leadId}`, domain: subject.domain, verdictId: judged.verdict.id, reason: judged.verdict.reason, runId: identity.runId });
    }
    group.forEach((lead, i) => {
      const v = judged.verdict;
      rows.set(lead.leadId, {
        leadId: lead.leadId,
        name: lead.name,
        company: lead.organization?.name ?? null,
        domain: subject.domain,
        verdict: v.verdict as SampleRow["verdict"],
        yesProbability: v.yesProbability,
        evidence: v.evidence,
        screenshotUrl: observed.observation.imageUrl,
        reason: v.reason,
        reused: i > 0 || (observed.reused && judged.reused),
        probeCostUsd: i === 0 ? Math.round(observed.chargedMicro * microCents * 10_000) / 1_000_000 : 0,
      });
    });
  });

  return leadIds.map((id) => rows.get(id)!);
}

export interface LeadQualification {
  criterionId: string;
  offerId: string;
  question: string;
  mode: QualificationMode;
  source: string;
  verdict: "yes" | "no" | "unavailable" | "not_checked";
  yesProbability: number | null;
  evidence: string | null;
  screenshotUrl: string | null;
  reason: string | null;
  checkedAt: string | null;
}

/**
 * What the given checks (the ENABLED criteria of the offer(s) asked about) say about this lead's
 * company, read from what is stored. A read never spends: a company nobody checked yet reads
 * `not_checked`.
 */
export async function readLeadQualification(lead: FullLead, criteria: QualificationCriterionRow[]): Promise<{ domain: string | null; checks: LeadQualification[] }> {
  const subject = subjectFromOrganization(lead.organization);
  const checks: LeadQualification[] = [];
  for (const c of criteria) {
    const spec = probeOf(c);
    const base = { criterionId: c.id, offerId: c.offerId as string, question: c.question, mode: c.mode as QualificationMode, source: probeLabel(spec) };
    if (!subject) {
      checks.push({ ...base, verdict: "unavailable", yesProbability: null, evidence: null, screenshotUrl: null, reason: "no_company_domain", checkedAt: null });
      continue;
    }
    const [hit] = await db
      .select({ v: qualificationVerdicts, imageUrl: qualificationObservations.imageUrl })
      .from(qualificationVerdicts)
      .innerJoin(qualificationObservations, eq(qualificationObservations.id, qualificationVerdicts.observationId))
      .where(and(eq(qualificationVerdicts.criterionKey, criterionKey(c.question, spec)), eq(qualificationVerdicts.domain, subject.domain)))
      .orderBy(desc(qualificationVerdicts.judgedAt))
      .limit(1);
    if (!hit) {
      checks.push({ ...base, verdict: "not_checked", yesProbability: null, evidence: null, screenshotUrl: null, reason: null, checkedAt: null });
      continue;
    }
    checks.push({
      ...base,
      verdict: hit.v.verdict as LeadQualification["verdict"],
      yesProbability: hit.v.yesProbability,
      evidence: hit.v.evidence,
      screenshotUrl: hit.imageUrl,
      reason: hit.v.reason,
      checkedAt: hit.v.judgedAt.toISOString(),
    });
  }
  return { domain: subject?.domain ?? null, checks };
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

/**
 * The suggestion rule (owner 2026-10-07): criteria belong to the OFFER and apply to every audience
 * of it, so a suggestion says why a company NEEDS this offer (site slow on mobile, no active
 * newsletter, not posting on LinkedIn, hiring support). Firmographics (industry, size, geography,
 * roles, funding stage) are the AUDIENCE's job: the draft classifies each check and a firmographic
 * one is DROPPED unless the draft states it holds for every audience of the offer.
 */
const SUGGEST_PROMPT = `You help a B2B company choose which conditions to check on the companies of its sales prospects, so its cold emails can cite a real fact about each prospect.
The checks belong to ONE offer and apply to EVERY audience that offer is sold to (different industries, sizes, countries, roles). So a check must be a NEED SIGNAL: an observable fact showing the company needs THIS offer (for example its site is slow on mobile, it has no active newsletter, it stopped posting on LinkedIn, it is hiring support staff), never who the company is.
Firmographic conditions (industry, company size, headcount, revenue, geography, job roles, funding stage, company age) are chosen per audience, not here. Propose one ONLY if it holds for every possible audience of this offer (for example the offer only makes sense for companies that sell online), and say why in "universalWhy".
From the offer below, propose between 5 and 8 checks. Each check is ONE yes/no question about the prospect's COMPANY, answerable from ONE source, where "yes" means the company needs the offer.
Sources you may use:
${BUILTIN_PROBE_KEYS.map((k) => `- "${k}": ${BUILTIN_PROBES[k].description}`).join("\n")}
- "search": any other public web data about a company (reviews, traffic, ads running, tech stack, press...). Give a short search phrase describing the data needed, e.g. "google reviews of a business".
Questions are short and concrete ("Has the company posted on LinkedIn less than twice in the last month?"). No dashes.
Answer JSON: {"checks":[{"question":"...","why":"one short sentence on why it shows a need for this offer","kind":"need|firmographic","universal":true|false,"universalWhy":"only for a firmographic check","source":"company_data|homepage_text|homepage_screenshot|job_postings|linkedin_company_posts|search","search":"only when source is search"}]}`;

export interface DraftCheck {
  question: string;
  why: string;
  kind?: string;
  universal?: boolean;
  universalWhy?: string;
  source: string;
  search?: string;
}

export interface DroppedSuggestion {
  question: string;
  /** firmographic_not_universal | unclassified_kind:<x> | no_usable_source */
  reason: string;
}

export class SuggestionDraftUnreadableError extends Error {
  constructor(excerpt: string) {
    super(`[lead-service] suggestion draft is neither a list of checks nor {checks: [...]}: ${excerpt}`);
    this.name = "SuggestionDraftUnreadableError";
  }
}

/**
 * The draft's checks. The model answers either `{"checks":[...]}` (what the prompt asks) or the
 * bare list (seen in prod 2026-10-07, every run on a chiropractic offer): both are read. Anything
 * else throws with the raw answer, so the failure names what came back.
 */
export function readDraftChecks(json: unknown, content: string): DraftCheck[] {
  if (Array.isArray(json)) return json as DraftCheck[];
  const inner = json && typeof json === "object" ? (json as Record<string, unknown>).checks : undefined;
  if (Array.isArray(inner)) return inner as DraftCheck[];
  throw new SuggestionDraftUnreadableError(content.slice(0, 1_500));
}

/** A check kept as an offer criterion: a need signal, or a firmographic the draft states is universal. */
export function keepsDraft(c: DraftCheck): { keep: true } | { keep: false; reason: string } {
  if (c.kind === "need") return { keep: true };
  if (c.kind === "firmographic") return c.universal === true && typeof c.universalWhy === "string" && c.universalWhy.trim() ? { keep: true } : { keep: false, reason: "firmographic_not_universal" };
  return { keep: false, reason: `unclassified_kind:${String(c.kind)}` };
}
/** Pick the treg endpoint that best answers a question, among usable ones from a catalogue search. */
async function pickCatalogProbe(question: string, phrase: string, identity: SpendIdentity): Promise<ProbeSpec | null> {
  const results = await searchCatalog(phrase, 25);
  const usable = results
    .map((e) => ({ e, r: catalogEntryToCall(e) }))
    .filter((x): x is { e: (typeof results)[number]; r: Extract<ReturnType<typeof catalogEntryToCall>, { ok: true }> } => x.r.ok)
    .slice(0, 12);
  if (usable.length === 0) return null;
  const options: Record<string, string> = { none: "None of these sources can answer the question about a company." };
  for (const { e, r } of usable) options[e.id] = `${e.name ?? e.id}: ${e.summary ?? ""} (about $${r.vendorUsd} per call)`;
  const { choice, confidence } = await judgeChoice(
    { question, sources: Object.keys(options).filter((k) => k !== "none") },
    { instructions: `Which data source best answers this question about a prospect's company, given only its domain, website, name or LinkedIn page: "${question}"? Prefer reliable and cheap.`, options },
    identity,
  );
  if (choice === "none" || confidence < 0.3) return null;
  const picked = usable.find((u) => u.e.id === choice)!;
  return { kind: "treg", label: picked.e.name ?? picked.e.id, reading: /screenshot/i.test(picked.e.id) ? "screenshot" : "text", calls: [picked.r.call] };
}

/**
 * Suggest criteria for an offer and WRITE them as criteria rows, OFF (`origin: suggested`), so the
 * dashboard reads one list and flips one switch. Suggestions nobody touched (still off, never
 * changed by a person) from an earlier run are archived; a suggestion asking what a live criterion
 * of the offer already asks is skipped.
 */
export async function generateSuggestions(params: OfferScope & { identity: SpendIdentity }): Promise<{ rows: QualificationCriterionRow[]; dropped: DroppedSuggestion[] }> {
  const offer = await getOfferText(params.orgId, params.brandId, params.offerId);
  const drafted = await complete(
    {
      systemPrompt: SUGGEST_PROMPT,
      message: `Offer: ${offer.name}\nDescription: ${offer.description ?? "(none)"}\nStated fields: ${JSON.stringify(offer.fields).slice(0, 12_000)}`,
      json: true,
      maxTokens: 2_500,
      model: "flash",
    },
    params.identity,
  );
  const checks = readDraftChecks(drafted.json, drafted.content);

  const drafts: Array<{ question: string; why: string; spec: ProbeSpec }> = [];
  const dropped: DroppedSuggestion[] = [];
  for (const c of checks.slice(0, 8)) {
    if (typeof c.question !== "string" || !c.question.trim()) continue;
    const kept = keepsDraft(c);
    if (!kept.keep) {
      console.log(`[lead-service] qualification suggestion dropped (${kept.reason}) for offer ${params.offerId}: ${c.question}`);
      dropped.push({ question: stripDashes(c.question), reason: kept.reason });
      continue;
    }
    let spec: ProbeSpec | null = null;
    if (c.source === "search") {
      if (typeof c.search === "string" && c.search.trim()) spec = await pickCatalogProbe(c.question, c.search, params.identity);
    } else if ((BUILTIN_PROBE_KEYS as readonly string[]).includes(c.source)) {
      spec = BUILTIN_PROBES[c.source as keyof typeof BUILTIN_PROBES].spec;
    }
    if (!spec) {
      console.log(`[lead-service] qualification suggestion dropped, no usable source: ${c.question}`);
      dropped.push({ question: stripDashes(c.question), reason: "no_usable_source" });
      continue;
    }
    drafts.push({ question: stripDashes(c.question), why: stripDashes(String(c.why ?? "")), spec });
  }

  const rows = await db.transaction(async (tx) => {
    const scope = and(
      eq(qualificationCriteria.orgId, params.orgId),
      eq(qualificationCriteria.brandId, params.brandId),
      eq(qualificationCriteria.offerId, params.offerId),
      isNull(qualificationCriteria.archivedAt),
    );
    await tx
      .update(qualificationCriteria)
      .set({ archivedAt: new Date() })
      .where(and(scope, eq(qualificationCriteria.origin, "suggested"), eq(qualificationCriteria.enabled, false), isNull(qualificationCriteria.updatedAt)));
    const live = await tx.select().from(qualificationCriteria).where(scope);
    const asked = new Set(live.map((r) => criterionKey(r.question, probeOf(r))));
    const fresh = drafts.filter((d) => {
      const k = criterionKey(d.question, d.spec);
      if (asked.has(k)) return false;
      asked.add(k);
      return true;
    });
    if (fresh.length === 0) return [];
    return tx
      .insert(qualificationCriteria)
      .values(
        fresh.map((d) => ({
          orgId: params.orgId,
          brandId: params.brandId,
          offerId: params.offerId,
          question: d.question,
          why: d.why,
          probe: d.spec,
          mode: "mention",
          enabled: false,
          origin: "suggested",
          createdByUserId: params.identity.userId ?? null,
        })),
      )
      .returning();
  });
  return { rows, dropped };
}
