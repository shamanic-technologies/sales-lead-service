/**
 * The company a person works at, when nothing told us yet (RELATIONSHIP-TAGS-1014, owner 2026-10-14):
 * a lead is a human AT a company; until the company is known the Unibox row has none, and once found the
 * same row becomes the company row (relationship-subjects.ts moves its tags).
 *
 * Order, cheapest first, the next step only when the one before found nothing:
 *   1. FREE: the person's WORK email domain (never a free-mail provider) -> brand-service company;
 *   2. FREE: a website / company the feed's facts state (a signup that named its site);
 *   3. treg `treg.people.enrich` (owner-approved, ~$0.0026 per success, capped per call at
 *      ENRICH_MAX_MICRO through `X-Treg-Route-Max-Cost`): the person's current company;
 *   (`treg.people.identity.resolve`, $0.02 per success, is NOT called: it answers a LinkedIn URL, never a company,
 *   and the enrich that would read that profile finds nobody under the approved ceiling: measured 2026-10-14, 15
 *   identity hits bought, 0 companies. A higher enrich ceiling is the owner's call.)
 * No org request starts the sweep, so treg is PLATFORM-billed (platform keys, a platform run, `actual` cost).
 * Two different companies found at the same step (two work domains) = a QUESTION on the review page
 * (`conflict`), nothing chosen. Every treg call is declared (`treg-micro-usd`) on the sweep's platform run, summed per human
 * in `treg_micro`. A person's own word (`PUT .../company`) outranks all and is never looked up again.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getCompanies, resolveCompanies } from "./company-client.js";
import { workEmailDomain } from "./lead-identity.js";
import { toSubject, type Scope, type Subject } from "./relationship-subjects.js";
import { PlatformTregMeter } from "./treg-client.js";

export const ENRICH_ENDPOINT = "treg.people.enrich";
export const ENRICH_MAX_MICRO = 3_000;
const LOOKUPS_PER_TICK = 60;
const RECHECK_AFTER = "30 days";

/** `crm`: the company crm-service links the person to (PROFESSIONAL-LEADS-1017); the others are older bases kept readable. */
export type CompanySource = "crm" | "lead" | "email_domain" | "signup" | "treg_enrich" | "treg_identity" | "person";

export interface CompanyCandidate {
  name: string | null;
  domain: string | null;
  source: CompanySource;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function domainOf(v: string | null): string | null {
  if (!v) return null;
  const host = v.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

/** The company a treg enrich answer names (providers spell it differently; read, never guessed). */
export function companyOfEnrich(body: unknown): { found: boolean; company: CompanyCandidate | null; linkedinUrl: string | null } {
  const out = (body as { output?: Record<string, unknown> } | null)?.output ?? null;
  if (!out || typeof out !== "object") return { found: false, company: null, linkedinUrl: null };
  const found = str(out.full_name) !== null;
  const nested = (out.company ?? out.organization ?? out.current_company ?? null) as Record<string, unknown> | null;
  const name =
    str(out.company_name) ?? str(out.job_company_name) ?? str(out.organization_name) ?? str(out.current_company_name) ??
    (nested && typeof nested === "object" ? str(nested.name) : typeof nested === "string" ? str(nested) : null);
  const domain =
    domainOf(str(out.company_domain) ?? str(out.job_company_website) ?? str(out.company_website) ?? str(out.organization_domain)) ??
    (nested && typeof nested === "object" ? domainOf(str(nested.domain) ?? str(nested.website) ?? str(nested.website_url)) : null);
  const linkedinUrl = str(out.linkedin_url) ?? str(out.linkedin);
  return { found, company: name || domain ? { name, domain, source: "treg_enrich" } : null, linkedinUrl };
}

async function subjectsWithoutCompany(scope: Scope): Promise<Subject[]> {
  const rows = (await db.execute(sql`
    SELECT s.* FROM relationship_subjects s
    LEFT JOIN relationship_companies c ON c.org_id = s.org_id AND c.human_id = s.human_id
    WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId} AND s.company_key = ''
      AND (c.human_id IS NULL OR (c.company_id IS NULL AND c.stated_by_user_id IS NULL AND NOT c.conflict
           AND c.checked_at < now() - ${RECHECK_AFTER}::interval))
    ORDER BY s.has_messages DESC, s.thread_seq DESC
    LIMIT ${LOOKUPS_PER_TICK}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(toSubject);
}

async function statedWebsites(s: Subject): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT COALESCE(f.payload->>'website', f.payload->>'companyWebsite', f.payload->>'url') AS site
    FROM crm_facts f
    WHERE f.org_id = ${s.orgId} AND f.brand_id = ${s.brandId} AND f.person_key = ANY(${sql.param(s.personKeys)}::text[])
      AND f.type IN ('signup', 'form_submitted', 'added_to_crm', 'payment')
      AND COALESCE(f.payload->>'website', f.payload->>'companyWebsite', f.payload->>'url') IS NOT NULL
  `)) as unknown as Array<{ site: string }>;
  return rows.map((r) => domainOf(r.site)).filter((d): d is string => d !== null && workEmailDomain(`x@${d}`) !== null);
}

async function record(s: Subject, c: { candidates: CompanyCandidate[]; chosen: CompanyCandidate | null; companyId: string | null; tregMicro: number }): Promise<void> {
  const conflict = c.chosen === null && c.candidates.length > 1;
  await db.execute(sql`
    INSERT INTO relationship_companies (org_id, human_id, company_id, name, domain, source, candidates, conflict, treg_micro, checked_at)
    VALUES (${s.orgId}, ${s.humanId}::uuid, ${c.companyId}, ${c.chosen?.name ?? null}, ${c.chosen?.domain ?? null}, ${c.chosen?.source ?? null},
      ${JSON.stringify(c.candidates)}::jsonb, ${conflict}, ${c.tregMicro}, now())
    ON CONFLICT (org_id, human_id) DO UPDATE SET company_id = excluded.company_id, name = excluded.name, domain = excluded.domain,
      source = excluded.source, candidates = excluded.candidates, conflict = excluded.conflict,
      treg_micro = relationship_companies.treg_micro + excluded.treg_micro, checked_at = now()
    WHERE relationship_companies.stated_by_user_id IS NULL
  `);
}

/** One step's candidates: one distinct domain = found; several = a question; none = next step. */
async function settle(s: Subject, candidates: CompanyCandidate[], tregMicro: number): Promise<boolean> {
  const byDomain = new Map<string, CompanyCandidate>();
  for (const c of candidates) if (c.domain) byDomain.set(c.domain, c);
  const named = candidates.filter((c) => !c.domain && c.name);
  if (byDomain.size > 1) {
    await record(s, { candidates: [...byDomain.values()], chosen: null, companyId: null, tregMicro });
    return true;
  }
  if (byDomain.size === 1) {
    const chosen = [...byDomain.values()][0];
    const [r] = await resolveCompanies([{ ref: s.humanId, domain: chosen.domain }]);
    let name = chosen.name;
    if (r?.brandId && !name) name = (await getCompanies([r.brandId]))[0]?.name ?? null;
    await record(s, { candidates, chosen: { ...chosen, name }, companyId: r?.brandId ?? null, tregMicro });
    return true;
  }
  if (named.length > 0) {
    // A name alone is never a company identity (brand-service refuses it): kept for the review page.
    await record(s, { candidates: named, chosen: named.length === 1 ? named[0] : null, companyId: null, tregMicro });
    return true;
  }
  return false;
}

export interface CompanyTick {
  looked: number;
  free: number;
  treg: number;
  none: number;
  tregMicro: number;
}

/** `platformRunId`: the platform run this sweep's treg spend is declared on (no org request starts the sweep). */
export async function lookUpCompanies(scope: Scope, platformRunId: () => Promise<string>): Promise<CompanyTick> {
  const tick: CompanyTick = { looked: 0, free: 0, treg: 0, none: 0, tregMicro: 0 };
  let meter: PlatformTregMeter | null = null;
  const treg = async () => (meter ??= new PlatformTregMeter(await platformRunId()));
  for (const s of await subjectsWithoutCompany(scope)) {
    tick.looked++;
    // 1. work email domain
    const work = Array.from(new Set(s.emails.map((e) => workEmailDomain(e)).filter((d): d is string => d !== null)));
    if (await settle(s, work.map((d) => ({ name: null, domain: d, source: "email_domain" as const })), 0)) {
      tick.free++;
      continue;
    }
    // 2. a site the feed states
    const sites = Array.from(new Set(await statedWebsites(s)));
    if (await settle(s, sites.map((d) => ({ name: null, domain: d, source: "signup" as const })), 0)) {
      tick.free++;
      continue;
    }
    const email = s.emails[0];
    if (!email) {
      await record(s, { candidates: [], chosen: null, companyId: null, tregMicro: 0 });
      tick.none++;
      continue;
    }
    // 3. treg enrich (the approved ceiling)
    let micro = 0;
    try {
      const first = await (await treg()).call({ endpointId: ENRICH_ENDPOINT, method: "POST", params: { email, ...(s.name ? { full_name: s.name } : {}) }, maxMicro: ENRICH_MAX_MICRO });
      micro += first.chargedMicro;
      const enrich = first.status < 300 ? companyOfEnrich(first.body) : { found: false, company: null, linkedinUrl: null };
      const source: CompanySource = "treg_enrich";
      tick.tregMicro += micro;
      if (enrich.company && (await settle(s, [{ ...enrich.company, source }], micro))) {
        tick.treg++;
        continue;
      }
      await record(s, { candidates: [], chosen: null, companyId: null, tregMicro: micro });
      tick.none++;
    } catch (err) {
      console.error(`[lead-service] relationship company lookup failed for human ${s.humanId} (org ${s.orgId}):`, err);
      if (micro > 0) await record(s, { candidates: [], chosen: null, companyId: null, tregMicro: micro });
    }
  }
  return tick;
}

export class CompanyStatementError extends Error {}

/** A person of the org states the company (or that there is none). Outranks every lookup. */
export async function stateCompany(input: { orgId: string; humanId: string; userId: string; domain?: string; name?: string; none?: boolean }): Promise<{ companyId: string | null; name: string | null; domain: string | null }> {
  let companyId: string | null = null;
  let name = input.name?.trim() || null;
  let domain: string | null = null;
  if (!input.none && input.domain) {
    domain = domainOf(input.domain);
    if (!domain) throw new CompanyStatementError(`not a domain: ${input.domain}`);
    const [r] = await resolveCompanies([{ ref: input.humanId, domain }]);
    companyId = r?.brandId ?? null;
    if (companyId && !name) name = (await getCompanies([companyId]))[0]?.name ?? null;
  }
  if (input.none) name = null;
  await db.execute(sql`
    INSERT INTO relationship_companies (org_id, human_id, company_id, name, domain, source, candidates, conflict, checked_at, stated_by_user_id)
    VALUES (${input.orgId}, ${input.humanId}::uuid, ${companyId}, ${name}, ${domain}, 'person', '[]'::jsonb, false, now(), ${input.userId})
    ON CONFLICT (org_id, human_id) DO UPDATE SET company_id = excluded.company_id, name = excluded.name, domain = excluded.domain,
      source = 'person', candidates = '[]'::jsonb, conflict = false, checked_at = now(), stated_by_user_id = excluded.stated_by_user_id
  `);
  return { companyId, name, domain };
}
