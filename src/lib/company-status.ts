/**
 * The COMPANY a lead is at, and what is true of the company as a BUYER of a brand (owner 2026-10-13,
 * LEAD-REFONTE-1013): a company is a CLIENT of brand X when any of its leads holds a live sale at X,
 * and SIGNED UP when any of its leads holds a live signup at X (the same `conversion_events` every
 * step count reads: tracker, hand-stated or CRM). "Not our target" is the company-level Disqualified
 * mark (lead-disqualification.ts). These buyer facts live HERE, never in brand-service (which holds
 * only the company's identity facts).
 *
 * The company is keyed on the brand-service company id, else `org:<local organization id>` for a
 * name-only employer (lead-identity.ts). Served on lead rows as `company`; null when the lead has no
 * known company.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { effectiveMark, type LeadAndCompanyMarks, type LeadDisqualification } from "./lead-disqualification.js";

export interface LeadCompanyBlock {
  /** brand-service company id; null for a name-only employer. */
  id: string | null;
  /** The company key: `id`, else `org:<local organization id>`. */
  key: string;
  /** A lead of this company holds a live sale at one of the row's brands. */
  isClient: boolean;
  /** A lead of this company holds a live signup at one of the row's brands. */
  signedUp: boolean;
  /** The COMPANY-level Disqualified mark ("not our target") for the row's conversation, or null. */
  disqualification: LeadDisqualification | null;
}

/** `companyKey|brandId` -> what is true of the company at that brand. */
export type CompanyStatus = Map<string, { isClient: boolean; signedUp: boolean }>;

export async function loadCompanyStatus(input: {
  orgId: string;
  brandIds: readonly string[];
  companyKeys: readonly string[];
}): Promise<CompanyStatus> {
  const out: CompanyStatus = new Map();
  const keys = [...new Set(input.companyKeys)];
  if (keys.length === 0 || input.brandIds.length === 0) return out;
  const companyIds = keys.filter((k) => !k.startsWith("org:"));
  const orgIds = keys.filter((k) => k.startsWith("org:")).map((k) => k.slice(4));
  const rows = (await db.execute(sql`
    SELECT k.company_key, ce.brand_id,
      bool_or(ce.event IN ('sale', 'purchase')) AS is_client,
      bool_or(ce.event = 'signup') AS signed_up
    FROM (
      SELECT id, company_id::text AS company_key FROM leads WHERE company_id = ANY(${sql.param(companyIds)}::uuid[])
      UNION ALL
      SELECT id, 'org:' || organization_id::text FROM leads
      WHERE company_id IS NULL AND organization_id = ANY(${sql.param(orgIds)}::uuid[])
    ) k
    JOIN conversion_events ce ON ce.matched_lead_id = k.id
    WHERE ce.org_id = ${input.orgId}
      AND ce.brand_id = ANY(${sql.param([...input.brandIds])}::text[])
      AND ce.attribution_status = 'attributed'
      AND ce.withdrawn_at IS NULL
      AND ce.event IN ('sale', 'purchase', 'signup')
    GROUP BY k.company_key, ce.brand_id
  `)) as unknown as Array<{ company_key: string; brand_id: string; is_client: boolean; signed_up: boolean }>;
  for (const r of rows) out.set(`${r.company_key}|${r.brand_id}`, { isClient: r.is_client, signedUp: r.signed_up });
  return out;
}

export function companyBlockFor(
  leadId: string,
  brandIds: readonly string[],
  offerId: string | null,
  marks: LeadAndCompanyMarks,
  status: CompanyStatus,
): LeadCompanyBlock | null {
  const key = marks.companyKeyOf.get(leadId);
  if (!key) return null;
  let isClient = false;
  let signedUp = false;
  let disqualification: LeadDisqualification | null = null;
  for (const b of brandIds) {
    const s = status.get(`${key}|${b}`);
    if (s?.isClient) isClient = true;
    if (s?.signedUp) signedUp = true;
    disqualification ??= effectiveMark(marks.company.get(`${key}|${b}`), offerId);
  }
  return { id: key.startsWith("org:") ? null : key, key, isClient, signedUp, disqualification };
}
