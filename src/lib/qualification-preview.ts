/**
 * An offer's checks on SAMPLE COMPANIES that are not leads yet (PREVIEW-CHECKS-1017, 2026-10-17).
 *
 * The signed-out onboarding of distribute.you shows ~10 companies of the audience preview, then writes a sample cold
 * email for some of them. Its visitor has just picked the offer's checks (Must have = `must_pass`, Nice to have =
 * `mention`); the preview runs them on those companies so the samples show what a live campaign would do: a company
 * failing a Must have is shown with the check it fails, the others carry the facts the writer cites.
 *
 * Same model as every check (src/lib/qualification.ts): one observation per (probe, domain), one verdict per
 * (question+probe, observation), so a company already checked is never paid for again, and a company that later
 * becomes a lead reads the same answers. No lead is created: a preview company is a DOMAIN + a name. Firmographics
 * (`company_data`) come from the organization we hold for that domain when we hold one; otherwise only its name and
 * domain are known, and a check that cannot be answered from that reads `unavailable` (never a silent no).
 *
 * Order, as on the serve: Must haves first; a company failing one (verdict `no`) is not paid a Nice to have (it would
 * never be emailed). `unavailable` never fails a company (an unanswerable check never declines, candidate-serve.ts).
 * Each check applied is recorded on subject `company:<domain>`, so the offer's pass rate counts the sample.
 *
 * Asynchronous: the POST opens the spend run, records the preview and starts it, waits up to PREVIEW_WAIT_MS, and
 * answers what is done (200) or still running (202); the GET reads it back. Results are always READ from the stored
 * verdicts, never held in memory, so a poll and the POST answer the same thing. A preview whose process died (deploy)
 * reads `failed` / `interrupted` after PREVIEW_STALE_MS; asking again reuses everything already paid.
 */
import { errorMessage } from "./db-error.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { organizations, qualificationCriteria, qualificationPreviews, type QualificationCriterionRow, type QualificationPreviewRow } from "../db/schema.js";
import { mapOrganizationView, type OrganizationView } from "./lead-shape.js";
import {
  InsufficientCreditError,
  judge,
  normalizeDomain,
  observe,
  probeLabel,
  probeOf,
  recordCheck,
  subjectFromOrganization,
  type QualificationDeps,
  type QualificationMode,
} from "./qualification.js";
import { probeKey, type CompanySubject } from "./qualification-probes.js";
import { readCompanyQualification, type LeadQualification } from "./qualification-run.js";
import { TregMeter, type SpendIdentity } from "./treg-client.js";

export { MAX_PREVIEW_COMPANIES } from "./qualification-probes.js";
/** How long the POST waits for the run before answering 202 (the caller then polls). */
export const PREVIEW_WAIT_MS = 25_000;
/** A preview still `running` after this died with its process: it reads `failed` / `interrupted`. */
export const PREVIEW_STALE_MS = 15 * 60_000;
const COMPANY_CONCURRENCY = 5;

export interface PreviewCompany {
  domain: string;
  name: string;
}

export type PreviewStatus = "running" | "completed" | "failed";

/** Domains normalized like every check's subject; a duplicate keeps its first name; an unusable domain is refused. */
export function normalizePreviewCompanies(raw: Array<{ domain: string; name: string }>): { ok: true; companies: PreviewCompany[] } | { ok: false; invalidDomains: string[] } {
  const invalid: string[] = [];
  const seen = new Map<string, PreviewCompany>();
  for (const c of raw) {
    const domain = normalizeDomain(c.domain);
    if (!domain) {
      invalid.push(c.domain);
      continue;
    }
    if (!seen.has(domain)) seen.set(domain, { domain, name: c.name.trim() });
  }
  return invalid.length ? { ok: false, invalidDomains: invalid } : { ok: true, companies: [...seen.values()] };
}

/** The organization we hold for this domain (newest), else one carrying only the name and domain we were given. */
export async function previewOrganization(company: PreviewCompany): Promise<OrganizationView> {
  const [held] = await db
    .select()
    .from(organizations)
    .where(sql`lower(${organizations.primaryDomain}) IN (${company.domain}, ${`www.${company.domain}`})`)
    .orderBy(desc(organizations.updatedAt))
    .limit(1);
  if (held) {
    const view = mapOrganizationView(held);
    return { ...view, name: view.name ?? company.name, primaryDomain: company.domain };
  }
  return nameAndDomainOnly(company);
}

function nameAndDomainOnly(company: PreviewCompany): OrganizationView {
  return {
    id: `preview:${company.domain}`,
    apolloOrganizationId: null,
    name: company.name,
    primaryDomain: company.domain,
    websiteUrl: null,
    industry: null,
    estimatedNumEmployees: null,
    annualRevenue: null,
    logoUrl: null,
    shortDescription: null,
    linkedinUrl: null,
    twitterUrl: null,
    facebookUrl: null,
    blogUrl: null,
    crunchbaseUrl: null,
    foundedYear: null,
    city: null,
    state: null,
    country: null,
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
    keywords: null,
  };
}

/** Criteria sharing a probe run one after the other (the second reads the first's observation); others side by side. */
async function runChecks(criteria: QualificationCriterionRow[], subject: CompanySubject, org: OrganizationView, deps: QualificationDeps): Promise<string[]> {
  const byProbe = new Map<string, QualificationCriterionRow[]>();
  for (const c of criteria) {
    const k = probeKey(probeOf(c));
    byProbe.set(k, [...(byProbe.get(k) ?? []), c]);
  }
  const verdicts: string[] = [];
  await Promise.all(
    [...byProbe.values()].map(async (group) => {
      for (const criterion of group) {
        const spec = probeOf(criterion);
        const observed = await observe(spec, subject, org, deps);
        const judged = await judge({ question: criterion.question, probe: spec }, observed.observation, subject, deps);
        await recordCheck({ criterion, subject: `company:${subject.domain}`, domain: subject.domain, verdictId: judged.verdict.id, reason: judged.verdict.reason, runId: deps.identity.runId });
        verdicts.push(judged.verdict.verdict);
      }
    }),
  );
  return verdicts;
}

async function checkCompany(company: PreviewCompany, criteria: QualificationCriterionRow[], deps: QualificationDeps): Promise<void> {
  const org = await previewOrganization(company);
  const subject = subjectFromOrganization(org);
  if (!subject) throw new Error(`[lead-service] preview company ${company.domain} has no usable domain`);
  const mustPass = await runChecks(criteria.filter((c) => c.mode === "must_pass"), subject, org, deps);
  if (mustPass.includes("no")) return;
  await runChecks(criteria.filter((c) => c.mode === "mention"), subject, org, deps);
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function errorCode(error: unknown): string {
  if (error instanceof InsufficientCreditError) return `insufficient_credit: ${error.message}`;
  return `failed: ${errorMessage(error) ?? String(error)}`.slice(0, 2000);
}

/**
 * Run every frozen check on every company, then close the preview. Never rejects: a failure is recorded on the row
 * (what was already judged stays readable). `closeRun` is the caller's run bookkeeping.
 */
export async function runPreview(preview: QualificationPreviewRow, criteria: QualificationCriterionRow[], identity: SpendIdentity, closeRun: (ok: boolean) => Promise<void>): Promise<void> {
  let ok = true;
  let error: string | null = null;
  try {
    const deps: QualificationDeps = { meter: new TregMeter(identity), identity };
    await mapLimit(preview.companies as PreviewCompany[], COMPANY_CONCURRENCY, (company) => checkCompany(company, criteria, deps));
  } catch (e) {
    ok = false;
    error = errorCode(e);
    console.error(`[lead-service] qualification preview ${preview.id} failed:`, e);
  }
  try {
    await db
      .update(qualificationPreviews)
      .set({ status: ok ? "completed" : "failed", error, finishedAt: new Date() })
      .where(and(eq(qualificationPreviews.id, preview.id), eq(qualificationPreviews.status, "running")));
    await closeRun(ok);
  } catch (e) {
    console.error(`[lead-service] closing qualification preview ${preview.id} failed:`, e);
  }
}

export interface PreviewScope {
  orgId: string;
  brandId: string;
  offerId: string;
}

export async function getPreview(scope: PreviewScope, id: string): Promise<QualificationPreviewRow | null> {
  const [row] = await db
    .select()
    .from(qualificationPreviews)
    .where(
      and(
        eq(qualificationPreviews.id, id),
        eq(qualificationPreviews.orgId, scope.orgId),
        eq(qualificationPreviews.brandId, scope.brandId),
        eq(qualificationPreviews.offerId, scope.offerId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.status === "running" && Date.now() - row.createdAt.getTime() > PREVIEW_STALE_MS) {
    const [marked] = await db
      .update(qualificationPreviews)
      .set({ status: "failed", error: "interrupted: the run stopped before finishing; ask again (what was checked is reused)", finishedAt: new Date() })
      .where(and(eq(qualificationPreviews.id, row.id), eq(qualificationPreviews.status, "running")))
      .returning();
    return marked ?? (await getPreview(scope, id));
  }
  return row;
}

/** The frozen criteria, in the preview's order (a criterion archived since is still named: it was asked). */
export async function previewCriteria(preview: QualificationPreviewRow): Promise<QualificationCriterionRow[]> {
  if (preview.criterionIds.length === 0) return [];
  const rows = await db.select().from(qualificationCriteria).where(inArray(qualificationCriteria.id, preview.criterionIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return preview.criterionIds.map((id) => byId.get(id)).filter((r): r is QualificationCriterionRow => Boolean(r));
}

export interface PreviewCheck extends LeadQualification {
  title: string | null;
}

export interface PreviewCompanyResult {
  domain: string;
  name: string;
  /**
   * passes = no Must have answered no (unavailable never fails); fails = at least one answered no (`failed` names
   * them); pending = still running and a Must have is not answered yet; unknown = the preview failed before it was.
   */
  mustPass: { state: "passes" | "fails" | "pending" | "unknown"; failed: Array<{ criterionId: string; title: string | null; question: string }> };
  /** Same shape as a served lead's `qualification` (buffer/next), each check also titled. */
  qualification: { domain: string; checks: PreviewCheck[] };
}

export interface PreviewAnswer {
  id: string;
  brandId: string;
  offerId: string;
  status: PreviewStatus;
  error: { code: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
  checks: Array<{ criterionId: string; title: string | null; question: string; mode: QualificationMode; source: string }>;
  companies: PreviewCompanyResult[];
}

function splitError(raw: string | null): PreviewAnswer["error"] {
  if (!raw) return null;
  const i = raw.indexOf(":");
  return i === -1 ? { code: raw, message: raw } : { code: raw.slice(0, i), message: raw.slice(i + 1).trim() };
}

/** What the preview says now, read from the stored verdicts (never spends). */
export async function readPreview(preview: QualificationPreviewRow, criteria: QualificationCriterionRow[]): Promise<PreviewAnswer> {
  const status = preview.status as PreviewStatus;
  const titles = new Map(criteria.map((c) => [c.id, c.title ?? null]));
  const companies: PreviewCompanyResult[] = [];
  for (const company of preview.companies as PreviewCompany[]) {
    const subject: CompanySubject = { domain: company.domain, websiteUrl: `https://${company.domain}`, companyName: company.name, companyLinkedinUrl: null };
    const read = await readCompanyQualification(subject, criteria);
    const checks: PreviewCheck[] = read.checks.map((c) => ({ ...c, title: titles.get(c.criterionId) ?? null }));
    const must = checks.filter((c) => c.mode === "must_pass");
    const failed = must.filter((c) => c.verdict === "no");
    const unanswered = must.some((c) => c.verdict === "not_checked");
    const state: PreviewCompanyResult["mustPass"]["state"] = failed.length ? "fails" : !unanswered ? "passes" : status === "running" ? "pending" : "unknown";
    if (failed.length) {
      for (const c of checks) if (c.mode === "mention" && c.verdict === "not_checked") c.reason = "failed_must_pass";
    }
    companies.push({
      domain: company.domain,
      name: company.name,
      mustPass: { state, failed: failed.map((c) => ({ criterionId: c.criterionId, title: c.title, question: c.question })) },
      qualification: { domain: company.domain, checks },
    });
  }
  return {
    id: preview.id,
    brandId: preview.brandId,
    offerId: preview.offerId,
    status,
    error: splitError(preview.error),
    createdAt: preview.createdAt.toISOString(),
    finishedAt: preview.finishedAt ? preview.finishedAt.toISOString() : null,
    checks: criteria.map((c) => ({ criterionId: c.id, title: c.title ?? null, question: c.question, mode: c.mode as QualificationMode, source: probeLabel(probeOf(c)) })),
    companies,
  };
}
