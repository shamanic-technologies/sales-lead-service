/**
 * A served lead names its COMPANY (COLD-NO-COMPANY-1121, 2026-11-21).
 *
 * Some employer rows here carry a domain but no name (a source handed the
 * company by its website only: `bruggen-apotheke.ch`). The company itself lives
 * in brand-service (LEAD-REFONTE-1013: the employer row's `company_id`, else the
 * lead's, else the domain resolved there), which DOES know its name
 * ("Bruggen Apotheke"). A cold email script maps `organization.name` to the
 * send's `recipientCompany`; a null there was refused by email-gateway AFTER the
 * writer had paid for the email (Swiss pharmacies campaign a75bc489, 4 refused
 * sends on 2026-11-21).
 *
 * So on EVERY serve (the write path: company facts are persisted at write,
 * never fetched on a read), a served lead whose current employer has no name
 * gets the name its owner states, written onto the employer row (only while
 * the row still has none) and onto the served answer. Never a name derived from
 * the domain here, never a default string. brand-service unreadable or nameless
 * = the name stays null, logged loud: a paid serve is never stranded on it.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getCompanies, resolveCompanies } from "./company-client.js";
import type { FullLead } from "./lead-shape.js";

export function hasCompanyName(name: string | null | undefined): name is string {
  return typeof name === "string" && name.trim().length > 0;
}

export interface CompanyNameDeps {
  getCompanies: typeof getCompanies;
  resolveCompanies: typeof resolveCompanies;
  readCompanyIds: (organizationId: string, leadId: string) => Promise<{ orgCompanyId: string | null; leadCompanyId: string | null }>;
  writeName: (organizationId: string, name: string) => Promise<void>;
}

const defaultDeps: CompanyNameDeps = {
  getCompanies,
  resolveCompanies,
  readCompanyIds: async (organizationId, leadId) => {
    const [row] = (await db.execute(sql`
      SELECT (SELECT company_id::text FROM organizations WHERE id = ${organizationId}::uuid) AS org_company_id,
             (SELECT company_id::text FROM leads WHERE id = ${leadId}::uuid) AS lead_company_id
    `)) as unknown as Array<{ org_company_id: string | null; lead_company_id: string | null }>;
    return { orgCompanyId: row?.org_company_id ?? null, leadCompanyId: row?.lead_company_id ?? null };
  },
  writeName: async (organizationId, name) => {
    await db.execute(sql`
      UPDATE organizations SET name = ${name}, updated_at = now()
      WHERE id = ${organizationId}::uuid AND (name IS NULL OR btrim(name) = '')
    `);
  },
};

/**
 * Completes `lead.organization.name` in place (and the matching employment
 * history entry) from brand-service when the employer row has none.
 * Returns the name filled, or null when nothing was filled.
 */
export async function completeServedCompanyName(
  lead: Pick<FullLead, "leadId" | "organization" | "employmentHistory">,
  deps: CompanyNameDeps = defaultDeps,
): Promise<string | null> {
  const org = lead.organization;
  if (!org || hasCompanyName(org.name)) return null;
  try {
    const { orgCompanyId, leadCompanyId } = await deps.readCompanyIds(org.id, lead.leadId);
    let companyId = orgCompanyId ?? leadCompanyId;
    if (!companyId && org.primaryDomain) {
      // A fresh serve precedes the identity sweep: ask the owner which company the domain is.
      const [resolved] = await deps.resolveCompanies([{ domain: org.primaryDomain }]);
      companyId = resolved?.brandId ?? null;
    }
    if (!companyId) {
      console.error(`[lead-service] company-name-fill: lead=${lead.leadId} org=${org.id} has no name and no company to ask`);
      return null;
    }
    const [company] = await deps.getCompanies([companyId]);
    if (!company || !hasCompanyName(company.name)) {
      console.error(`[lead-service] company-name-fill: lead=${lead.leadId} company=${companyId} brand-service states no name`);
      return null;
    }
    const name = company.name.trim();
    await deps.writeName(org.id, name);
    org.name = name;
    for (const e of lead.employmentHistory ?? []) {
      if (e.organizationId === org.id && !hasCompanyName(e.organizationName)) e.organizationName = name;
    }
    return name;
  } catch (error) {
    console.error(
      `[lead-service] company-name-fill: lead=${lead.leadId} org=${org.id} name left null: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}
