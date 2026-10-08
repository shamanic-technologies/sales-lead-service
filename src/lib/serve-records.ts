import { sql } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";

/**
 * EVERY SERVE of a brand: which `lead-serve` run handed out which person, every campaign, no dedup.
 *
 * One row per `leads_campaigns` row of the (org, brand) that carries a serve run (`run_id`), whatever
 * its lifecycle status now (a serve the lifecycle later skipped was still paid for). Never collapsed
 * per person: a person served under three campaigns is three rows, one per serve run. That is what
 * features-service needs to attribute the cost subtree of each serve run to the person it bought
 * (staff "$ invested in sourcing"), and what `GET /orgs/leads` cannot give in one read: a brand scope
 * there is one row per PERSON, and a campaign scope answers for the campaign IDENTITY, so the
 * consumer used to walk it campaign by campaign (2,303 calls for one brand, 2026-10-08).
 *
 * The person's identity is read off the SAME projections `view=basic` uses (current employer:
 * enriched org first, newest employment row, lowest organization id; primary email: oldest contact
 * method, then value), so a field here equals the same field on a `view=basic` row of that person,
 * except that an unknown first/last name is null here (basic renders it "").
 *
 * ONE statement, streamed through a server-side cursor: the brand's serve rows are found once, the
 * per-person lookups run once per returned row, and nothing is re-scanned per chunk.
 */
export interface ServeRecord {
  /** The `lead-service:lead-serve` run that handed this person out (`leads_campaigns.run_id`). */
  runId: string;
  leadId: string;
  /** The campaign the lead row is filed under (the OUTREACH campaign that works the lead). */
  campaignId: string;
  audienceId: string | null;
  /** When the serve happened (`served_at`); null when the lifecycle never stamped it. */
  servedAt: string | null;
  apolloPersonId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: { name: string | null; primaryDomain: string | null; websiteUrl: string | null } | null;
}

interface RawServeRecord {
  run_id: string;
  lead_id: string;
  campaign_id: string;
  audience_id: string | null;
  served_at: RawTimestamp;
  l_id: string | null;
  apollo_person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  o_lead: string | null;
  org_name: string | null;
  primary_domain: string | null;
  website_url: string | null;
  email_value: string | null;
}

export function toServeRecord(r: RawServeRecord): ServeRecord {
  return {
    runId: r.run_id,
    leadId: r.lead_id,
    campaignId: r.campaign_id,
    audienceId: r.audience_id,
    servedAt: toIsoTimestamp(r.served_at),
    apolloPersonId: r.l_id ? r.apollo_person_id : null,
    email: r.email_value ? r.email_value : null,
    firstName: r.l_id ? r.first_name : null,
    lastName: r.l_id ? r.last_name : null,
    company:
      r.o_lead !== null
        ? { name: r.org_name, primaryDomain: r.primary_domain, websiteUrl: r.website_url }
        : null,
  };
}

function serveRecordQuery(orgId: string, brandId: string) {
  return sql<RawServeRecord[]>`
    SELECT
      lc.run_id, lc.lead_id, lc.campaign_id, lc.audience_id, lc.served_at,
      l.id AS l_id, l.apollo_person_id, l.first_name, l.last_name,
      org.o_lead, org.org_name, org.primary_domain, org.website_url,
      em.value AS email_value
    FROM leads_campaigns lc
    LEFT JOIN leads l ON l.id = lc.lead_id
    LEFT JOIN LATERAL (
      SELECT o.id AS o_lead, o.name AS org_name, o.primary_domain, o.website_url
      FROM leads_organizations lo
      LEFT JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.lead_id = lc.lead_id AND lo.current = true
      ORDER BY (CASE WHEN o.logo_url IS NOT NULL OR o.primary_domain IS NOT NULL THEN 1 ELSE 0 END) DESC,
               lo.created_at DESC NULLS LAST,
               lo.organization_id ASC
      LIMIT 1
    ) org ON true
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) em ON true
    WHERE lc.org_id = ${orgId}
      AND ${brandId} = ANY(lc.brand_ids)
      AND lc.run_id IS NOT NULL
    ORDER BY lc.created_at ASC, lc.id ASC
  `;
}

/** Stream the brand's serve records in chunks of at most `chunkSize`, one statement. */
export async function* streamServeRecords(
  orgId: string,
  brandId: string,
  chunkSize: number,
): AsyncGenerator<ServeRecord[]> {
  for await (const rows of serveRecordQuery(orgId, brandId).cursor(Math.max(1, chunkSize))) {
    if (rows.length === 0) continue;
    yield rows.map(toServeRecord);
  }
}
