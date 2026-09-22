/**
 * Our half of a CRM pairing row: who the lead is, and where they stand.
 *
 * Bounded to the leads a PAGE names. This service has already taken itself down once by holding a
 * brand's whole lead population in one read, so nothing here takes a list of leads it did not
 * receive, and the summary path never calls in at all.
 *
 * Where a lead stands is resolved by the SAME machinery every other surface uses
 * (`createLeadStandingResolver` over the delivery overlay) — the policy is authored once, in
 * lead-standing.ts, and everything else renders it.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { DEFAULT_STATUS, flattenBrandStatus, type FlattenedStatus } from "./delivery-flatten.js";
import { standingDelivery } from "./lead-standing-index.js";
import type { LeadStanding } from "./lead-standing.js";
import type { LeadStandingResolver } from "./lead-standing-resolver.js";
import type { ServiceContext } from "../middleware/auth.js";

/** The lead behind one pairing, as the surface shows it and as the judgment reads it. */
export interface PairedLeadFacts {
  leadId: string;
  /** `leads_campaigns.id` — the row a consumer opens the lead detail panel with. */
  leadCampaignId: string;
  campaignId: string;
  brandIds: string[];
  status: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  jobTitle: string | null;
  company: string | null;
  companyDomain: string | null;
  location: string | null;
}

interface LeadFactsRow {
  lead_campaign_id: string;
  lead_id: string;
  campaign_id: string;
  brand_ids: string[];
  status: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  headline: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  email: string | null;
  job_title: string | null;
  company: string | null;
  company_domain: string | null;
}

function joinLocation(row: LeadFactsRow): string | null {
  const parts = [row.city, row.state, row.country].filter((p): p is string => !!p && p.length > 0);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The facts for the leads a page paired with, one row per lead.
 *
 * A person can hold several `leads_campaigns` rows for one brand, so the winner is picked the same
 * way every list read picks it: most-advanced lifecycle first, then the latest serve. The panel a
 * consumer opens from this surface therefore shows the same row this surface named.
 */
export async function fetchPairedLeadFacts(
  brandId: string,
  leadIds: string[],
): Promise<Map<string, PairedLeadFacts>> {
  const out = new Map<string, PairedLeadFacts>();
  if (leadIds.length === 0) return out;

  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (lc.lead_id)
      lc.id   AS lead_campaign_id,
      lc.lead_id,
      lc.campaign_id,
      lc.brand_ids,
      lc.status,
      l.first_name, l.last_name, l.name, l.headline, l.city, l.state, l.country,
      (SELECT cm.value
         FROM lead_contact_methods cm
        WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC, cm.id ASC
        LIMIT 1) AS email,
      emp.title AS job_title,
      emp.org_name AS company,
      emp.org_domain AS company_domain
    FROM leads_campaigns lc
    JOIN leads l ON l.id = lc.lead_id
    LEFT JOIN LATERAL (
      SELECT lo.title, o.name AS org_name, o.primary_domain AS org_domain
      FROM leads_organizations lo
      JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.lead_id = lc.lead_id
      ORDER BY lo.current DESC, lo.start_date DESC NULLS LAST, lo.organization_id ASC
      LIMIT 1
    ) emp ON true
    WHERE lc.lead_id = ANY(${sql.param(leadIds)}::uuid[])
      AND ${brandId} = ANY(lc.brand_ids)
    ORDER BY lc.lead_id,
      CASE lc.status
        WHEN 'served' THEN 0 WHEN 'claimed' THEN 1 WHEN 'buffered' THEN 2 ELSE 3
      END,
      lc.served_at DESC NULLS LAST,
      lc.created_at DESC,
      lc.id
  `)) as unknown as LeadFactsRow[];

  for (const row of rows) {
    out.set(row.lead_id, {
      leadId: row.lead_id,
      leadCampaignId: row.lead_campaign_id,
      campaignId: row.campaign_id,
      brandIds: row.brand_ids ?? [],
      status: row.status,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: row.name,
      email: row.email,
      jobTitle: row.job_title ?? row.headline,
      company: row.company,
      companyDomain: row.company_domain,
      location: joinLocation(row),
    });
  }
  return out;
}

/**
 * Where each of these leads stands, at BRAND scope.
 *
 * One batched delivery call for the page, then the shared resolver. A lead we hold no email for is
 * never asked about (the overlay keys on the registered email), and keeps the all-false default —
 * the same rule the lead list follows.
 */
export async function resolveStandingsForLeads(
  brandId: string,
  leads: PairedLeadFacts[],
  resolver: LeadStandingResolver,
  ctx: ServiceContext,
): Promise<Map<string, LeadStanding>> {
  const out = new Map<string, LeadStanding>();
  if (leads.length === 0) return out;

  const emails = Array.from(
    new Set(leads.filter((l) => l.status === "served" && l.email).map((l) => l.email as string)),
  );

  const byEmail = new Map<string, StatusResult>();
  if (emails.length > 0) {
    const response = await checkDeliveryStatus(
      brandId,
      undefined,
      emails.map((email) => ({ email })),
      ctx,
    );
    for (const result of response.results) byEmail.set(result.email, result);
  }

  const deliveryByLead = new Map<string, FlattenedStatus>();
  for (const lead of leads) {
    const result = lead.email ? byEmail.get(lead.email) : undefined;
    deliveryByLead.set(lead.leadId, result ? flattenBrandStatus(result) : DEFAULT_STATUS);
  }

  const facts = await resolver.resolve(
    leads.map((lead) => ({
      id: lead.leadCampaignId,
      leadId: lead.leadId,
      campaignId: lead.campaignId,
      brandIds: lead.brandIds,
      status: lead.status,
      delivery: standingDelivery(deliveryByLead.get(lead.leadId) ?? DEFAULT_STATUS),
    })),
  );

  for (const lead of leads) {
    const resolved = facts.get(lead.leadCampaignId);
    if (resolved) out.set(lead.leadId, resolved.standing);
  }
  return out;
}
