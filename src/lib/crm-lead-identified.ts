import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { PROFESSIONAL_TO_BRAND } from "./relationship-subjects.js";
import { declareRunOutcomes, leadFoundDeclaration } from "./run-outcomes.js";

/**
 * A LEAD FOUND FROM THE CLIENT'S CRM CONSUMES THE `lead_identified` CRM-SERVICE PRODUCED (LEAD-IDENTIFIED-CONSUME-1024,
 * owner 2026-10-24: « le lead found appartient à ton service… c'est un outcome que tu produis »).
 *
 * crm-service pays to judge "this human x company is a lead of the brand" (its registry's tagging,
 * `professional_to_brand`) and declares that as `lead_identified` on ITS subject: the relation key it serves
 * (`rel:<personId>:...`, copied verbatim into `crm_registry_facts.payload.relationKey`). When our serve hands such a
 * person to a pipe, its `lead_found` consumes that occurrence, so the identification's cost reaches every outcome
 * downstream. A lead no crm relation identified (Apollo, Apify, signals...) consumes nothing new.
 *
 * Which relation (positive evidence only, one rule for the live serve and the backfill):
 *   - the serve came from the CRM (live: the served person's provider is `crm`; backfill: an email of the lead was
 *     registered from a `crm` serve), and
 *   - a LIVE professional relation crm-service states for one of the serve's brands, tagged `professional_to_brand`
 *     on its own tags (the relationship subjects' rule), carries one of the lead's registered emails.
 *   - one relation key = it; several = the one at the lead's company (crm's `companyId` = brand-service id =
 *     `leads.company_id`, '' = unknown on both sides); still not one = none, logged (never a pick).
 * Relation keys are crm-service's: read verbatim, never minted, re-keyed or lower-cased.
 */

/** The provider name human-service states on a person it served from the client's CRM. */
export const CRM_PROVIDER = "crm" as const;

export interface RelationCandidate {
  relationKey: string;
  /** crm's companyId of the relation, '' = professional, company unknown. */
  companyId: string;
}

/** The ONE relation a lead found from the CRM consumes, or null (none, or not one). Pure. */
export function pickRelationKey(candidates: readonly RelationCandidate[], leadCompanyId: string | null): string | null {
  const keys = [...new Set(candidates.map((c) => c.relationKey))];
  if (keys.length === 1) return keys[0];
  if (keys.length === 0) return null;
  const company = leadCompanyId ?? "";
  const atCompany = [...new Set(candidates.filter((c) => c.companyId === company).map((c) => c.relationKey))];
  return atCompany.length === 1 ? atCompany[0] : null;
}

export interface IdentifiedLeadQuery {
  orgId: string;
  leadId: string;
  brandIds: readonly string[];
}

/**
 * For each query (in order), the crm relation key whose `lead_identified` the find consumes, or null. One statement
 * whatever the number of queries. The caller decides the serve came from the CRM; this reads only the registry copy.
 */
export async function crmIdentifiedRelationKeys(queries: readonly IdentifiedLeadQuery[]): Promise<Array<string | null>> {
  if (queries.length === 0) return [];
  const payload = JSON.stringify(queries.map((q, i) => ({ i, org: q.orgId, lead: q.leadId, brands: [...q.brandIds] })));
  const rows = (await db.execute(sql`
    WITH q AS (
      SELECT (x->>'i')::int AS i, x->>'org' AS org_id, (x->>'lead')::uuid AS lead_id,
             ARRAY(SELECT jsonb_array_elements_text(x->'brands')) AS brand_ids
        FROM jsonb_array_elements(${payload}::jsonb) AS x
    ), em AS (
      SELECT q.i, q.org_id, q.brand_ids, coalesce(l.company_id::text, '') AS lead_company,
             array_agg(DISTINCT lower(cm.value)) AS emails
        FROM q
        JOIN leads l ON l.id = q.lead_id
        JOIN lead_contact_methods cm ON cm.lead_id = q.lead_id AND cm.channel = 'email'
       GROUP BY q.i, q.org_id, q.brand_ids, l.company_id
    )
    SELECT DISTINCT em.i, em.lead_company, f.payload->>'relationKey' AS relation_key,
           coalesce(f.payload->>'companyId', '') AS company_id
      FROM em
      JOIN crm_registry_facts f
        ON f.org_id = em.org_id AND f.brand_id = ANY(em.brand_ids) AND f.type = 'relation'
       AND f.emails && em.emails
       AND f.payload->>'capacity' = 'professional'
       AND f.payload->'tags' @> ${JSON.stringify([{ tag: PROFESSIONAL_TO_BRAND }])}::jsonb
       AND jsonb_typeof(f.payload->'relationKey') = 'string'
       AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id)
  `)) as unknown as Array<{ i: number; lead_company: string; relation_key: string; company_id: string }>;
  const byQuery = new Map<number, { leadCompany: string; candidates: RelationCandidate[] }>();
  for (const r of rows) {
    const i = Number(r.i);
    let entry = byQuery.get(i);
    if (!entry) byQuery.set(i, (entry = { leadCompany: r.lead_company, candidates: [] }));
    entry.candidates.push({ relationKey: r.relation_key, companyId: r.company_id });
  }
  return queries.map((q, i) => {
    const entry = byQuery.get(i);
    if (!entry) return null;
    const key = pickRelationKey(entry.candidates, entry.leadCompany || null);
    if (key === null) {
      console.warn(
        `[lead-service] lead_identified not consumed: org=${q.orgId} lead=${q.leadId} names several crm relations ` +
          `(${[...new Set(entry.candidates.map((c) => c.relationKey))].join(",")}), none at its company`,
      );
    }
    return key;
  });
}

/**
 * The live serve's declaration (buffer.ts recordServed): `lead_found` produced, `email_checked` consumed when stated,
 * the crm relation's `lead_identified` consumed when the person came from the CRM. Called WITHOUT await; never throws.
 * A registry read that fails declares the find without it (logged): the backfill re-reads the registry and adds it.
 */
export function declareLeadFound(input: { orgId: string; runId: string; leadId: string; brandIds: readonly string[]; emailChecked: boolean; fromCrm: boolean }): void {
  void (async () => {
    let crmRelationKey: string | null = null;
    if (input.fromCrm) {
      try {
        [crmRelationKey] = await crmIdentifiedRelationKeys([{ orgId: input.orgId, leadId: input.leadId, brandIds: input.brandIds }]);
      } catch (err) {
        console.error(`[lead-service] lead_identified unreadable for run=${input.runId} lead=${input.leadId}, lead_found declared without it:`, err);
      }
    }
    declareRunOutcomes(leadFoundDeclaration({ orgId: input.orgId, runId: input.runId, leadId: input.leadId, emailChecked: input.emailChecked, crmRelationKey }));
  })();
}
