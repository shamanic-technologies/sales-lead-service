/**
 * Who WENT COLD, read the same way every other surface reads a lead's standing.
 *
 * The derivation lives in ONE place (`deriveWentCold`, run inside `createLeadStandingResolver`), so
 * the brand-level read features-service prices from, the lead panel and the Leads board cannot
 * disagree about the same lead: this module only gathers the rows and their delivery evidence and
 * hands them to that resolver.
 *
 * Nothing here costs anything for a brand whose CRM cannot prove an absence: the eligibility check
 * comes first, and it is a local query for a brand no CRM was ever paired against.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";
import { DEFAULT_STATUS, flattenBrandStatus } from "./delivery-flatten.js";
import { readDeliveryEvidence } from "./lead-delivery-evidence.js";
import { createLeadStandingResolver, type StandingRow } from "./lead-standing-resolver.js";
import { STANDING_RESOLVE_CHUNK_SIZE, standingDelivery } from "./lead-standing-index.js";
import { crmPairedOrgs, loadCrmColdEligibility } from "./crm-cold-eligibility.js";
import type { CrmColdEligibility, WentCold } from "./lead-cold.js";

/**
 * How old a stored delivery answer the brand-level read accepts. It only dates a positive reply
 * against a 30-day window, and a reply the store has not seen yet merely delays a lead going cold —
 * the conservative direction.
 */
export const COLD_EVIDENCE_MAX_AGE_MS = 30 * 60 * 1000;

export interface BrandColdLead {
  leadId: string;
  leadCampaignId: string;
  campaignId: string;
  email: string | null;
  wentCold: WentCold;
}

export interface BrandColdRead {
  /** Per org whose CRM was ever paired against this brand: can its CRM prove an absence? */
  eligibility: Array<{ orgId: string } & CrmColdEligibility>;
  leads: BrandColdLead[];
}

interface MembershipRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  brand_ids: string[];
  status: string;
  email: string | null;
}

/** Every served membership row of the brand (as its PRIMARY brand) for one org. */
async function servedRows(orgId: string, brandId: string): Promise<MembershipRow[]> {
  return (await db.execute(sql`
    SELECT lc.id, lc.lead_id, lc.campaign_id, lc.brand_ids, lc.status, lower(canonical.value) AS email
    FROM leads_campaigns lc
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) canonical ON true
    WHERE lc.org_id = ${orgId}
      AND lc.brand_ids[1] = ${brandId}
      AND lc.status = 'served'
  `)) as unknown as MembershipRow[];
}

export async function readBrandColdLeads(brandId: string): Promise<BrandColdRead> {
  const eligibility: BrandColdRead["eligibility"] = [];
  const leads: BrandColdLead[] = [];

  for (const orgId of await crmPairedOrgs(brandId)) {
    const e = await loadCrmColdEligibility(orgId, brandId);
    eligibility.push({ orgId, ...e });
    if (!e.eligible) continue;

    const rows = await servedRows(orgId, brandId);
    const evidence = await readDeliveryEvidence(
      rows.filter((r) => r.email).map((r) => ({ brandId, email: r.email! })),
      {
        orgId,
        campaignId: undefined,
        acceptFetchedSince: new Date(Date.now() - COLD_EVIDENCE_MAX_AGE_MS),
        context: { orgId },
      },
    );

    const resolver = createLeadStandingResolver({
      orgId,
      userId: null,
      runId: null,
      brandId,
      deliveryQueried: true,
    });
    for (let i = 0; i < rows.length; i += STANDING_RESOLVE_CHUNK_SIZE) {
      const chunk = rows.slice(i, i + STANDING_RESOLVE_CHUNK_SIZE);
      const standingRows: StandingRow[] = chunk.map((r) => {
        const result = r.email ? evidence.get(r.email) : undefined;
        return {
          id: r.id,
          leadId: r.lead_id,
          campaignId: r.campaign_id,
          brandIds: r.brand_ids,
          status: r.status,
          delivery: standingDelivery(result ? flattenBrandStatus(result) : DEFAULT_STATUS),
        };
      });
      const facts = await resolver.resolve(standingRows);
      for (const r of chunk) {
        const wentCold = facts.get(r.id)?.standing.wentCold ?? null;
        if (!wentCold) continue;
        leads.push({
          leadId: r.lead_id,
          leadCampaignId: r.id,
          campaignId: r.campaign_id,
          email: r.email,
          wentCold,
        });
      }
    }
  }
  return { eligibility, leads };
}

/**
 * Whether ONE lead row went cold, for the lead panel. Brand-scope delivery evidence, asked of the
 * gateway directly (one address), exactly as the panel's measured-visit check asks it. A gateway
 * failure throws; the caller answers 502 rather than guess.
 */
export async function readLeadRowCold(
  row: { id: string; leadId: string; campaignId: string; brandIds: string[]; email: string | null },
  orgId: string,
  brandId: string,
): Promise<{ wentCold: WentCold | null; eligibility: CrmColdEligibility }> {
  const eligibility = await loadCrmColdEligibility(orgId, brandId);
  if (!eligibility.eligible) return { wentCold: null, eligibility };

  let delivery = DEFAULT_STATUS;
  if (row.email) {
    const response = await checkDeliveryStatus(brandId, undefined, [{ email: row.email }], {
      orgId,
      brandId,
    });
    const result = response.results.find(
      (r) => r.email.trim().toLowerCase() === row.email!.trim().toLowerCase(),
    );
    if (result) delivery = flattenBrandStatus(result);
  }

  const facts = await createLeadStandingResolver({
    orgId,
    userId: null,
    runId: null,
    brandId,
    deliveryQueried: true,
  }).resolve([
    {
      id: row.id,
      leadId: row.leadId,
      campaignId: row.campaignId,
      // The panel names its brand: the rule reads that brand's CRM.
      brandIds: [brandId, ...row.brandIds.filter((b) => b !== brandId)],
      status: "served",
      delivery: standingDelivery(delivery),
    },
  ]);
  return { wentCold: facts.get(row.id)?.standing.wentCold ?? null, eligibility };
}
