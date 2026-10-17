/**
 * A person's own word on which company someone works at (RELATIONSHIP-TAGS-1014), kept readable until the review page
 * drops it. Since PROFESSIONAL-LEADS-1017 (owner 2026-10-17) lead-service no longer LOOKS UP companies (no treg, no
 * email-domain guess): the company is the one crm-service links the person to (relationship-subjects.ts). The treg
 * enrich ceiling below is the named-lead serve's (named-lead-serve.ts), not this module's.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getCompanies, resolveCompanies } from "./company-client.js";

export const ENRICH_ENDPOINT = "treg.people.enrich";
export const ENRICH_MAX_MICRO = 3_000;
/** `crm`: the company crm-service links the person to (PROFESSIONAL-LEADS-1017); the others are older bases kept readable. */
export type CompanySource = "crm" | "lead" | "email_domain" | "signup" | "treg_enrich" | "treg_identity" | "person";

export interface CompanyCandidate {
  name: string | null;
  domain: string | null;
  source: CompanySource;
}

function domainOf(v: string | null): string | null {
  if (!v) return null;
  const host = v.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
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
