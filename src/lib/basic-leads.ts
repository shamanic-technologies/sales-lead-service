import { sql } from "../db/index.js";

// Slim per-lead shape for `?view=basic` — the SAME object the route's toSlimLead
// produced, but assembled in ONE flat SQL pass instead of hydrating the full lead
// graph per chunk and discarding ~90% of it. See src/routes/leads.ts for the
// (locked) wire contract the dashboard parses.
export interface BasicSlimLead {
  leadId: string;
  apolloPersonId: string | null;
  firstName: string;
  lastName: string;
  name: string | null;
  headline: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  organization: {
    id: string;
    name: string | null;
    logoUrl: string | null;
    primaryDomain: string | null;
    websiteUrl: string | null;
  } | null;
}

// One row of the basic-view query: the leads_campaigns lifecycle fields (top-level
// leadOut) + the slim lead + the primary email contact.
export interface BasicLeadRow {
  id: string;
  leadId: string;
  campaignId: string;
  orgId: string;
  userId: string | null;
  brandIds: string[];
  status: string;
  statusReason: string | null;
  statusDetails: string | null;
  parentRunId: string | null;
  runId: string | null;
  servedAt: string | null;
  workflowSlug: string | null;
  featureSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
  audienceId: string | null;
  createdAt: Date;
  leadApolloPersonId: string | null;
  lead: BasicSlimLead | null;
  email: { value: string; status: string | null } | null;
}

export interface BasicLeadFilters {
  orgId: string;
  brandId?: string;
  campaignId?: string;
  queryOrgId?: string;
  userId?: string;
  workflowSlug?: string;
}

export interface BasicLeadCursor {
  createdAt: Date;
  id: string;
}

type RawTimestamp = Date | string | null;

interface RawBasicRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  org_id: string;
  user_id: string | null;
  brand_ids: string[];
  status: string;
  status_reason: string | null;
  status_details: string | null;
  parent_run_id: string | null;
  run_id: string | null;
  served_at: RawTimestamp;
  workflow_slug: string | null;
  feature_slug: string | null;
  goal: string | null;
  active_goal_id: string | null;
  brand_profile_id: string | null;
  audience_id: string | null;
  created_at: Date | string;
  l_id: string | null;
  apollo_person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  headline: string | null;
  linkedin_url: string | null;
  photo_url: string | null;
  org_id_inner: string | null;
  org_name: string | null;
  logo_url: string | null;
  primary_domain: string | null;
  website_url: string | null;
  email_value: string | null;
  email_status: string | null;
}

function toIsoTimestamp(value: RawTimestamp): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`[lead-service] invalid served_at timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function toDateTimestamp(value: Date | string): Date {
  if (value instanceof Date) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`[lead-service] invalid created_at timestamp: ${value}`);
  }
  return parsed;
}

function mapRow(r: RawBasicRow): BasicLeadRow {
  // Current-employer org selection mirrors lead-shape.ts pickCurrentEmployment:
  // among `current = true` employment rows, prefer enriched (logo OR primaryDomain),
  // then most-recently-created, then lowest organizationId — done in SQL ORDER BY.
  // null l_id => the lead row is gone (left join miss) => same as the full path's
  // `fullLeadByLeadId.get(...) ?? null`.
  const lead: BasicSlimLead | null = r.l_id
    ? {
        leadId: r.l_id,
        apolloPersonId: r.apollo_person_id,
        firstName: r.first_name ?? "",
        lastName: r.last_name ?? "",
        name: r.name,
        headline: r.headline,
        linkedinUrl: r.linkedin_url,
        photoUrl: r.photo_url,
        organization: r.org_id_inner
          ? {
              id: r.org_id_inner,
              name: r.org_name,
              logoUrl: r.logo_url,
              primaryDomain: r.primary_domain,
              websiteUrl: r.website_url,
            }
          : null,
      }
    : null;

  return {
    id: r.id,
    leadId: r.lead_id,
    campaignId: r.campaign_id,
    orgId: r.org_id,
    userId: r.user_id,
    brandIds: r.brand_ids,
    status: r.status,
    statusReason: r.status_reason,
    statusDetails: r.status_details,
    parentRunId: r.parent_run_id,
    runId: r.run_id,
    servedAt: toIsoTimestamp(r.served_at),
    workflowSlug: r.workflow_slug,
    featureSlug: r.feature_slug,
    goal: r.goal,
    activeGoalId: r.active_goal_id,
    brandProfileId: r.brand_profile_id,
    audienceId: r.audience_id,
    createdAt: toDateTimestamp(r.created_at),
    leadApolloPersonId: r.apollo_person_id,
    lead,
    email: r.email_value != null ? { value: r.email_value, status: r.email_status } : null,
  };
}

function basicLeadQuery(
  f: BasicLeadFilters,
  cursor: BasicLeadCursor | null,
  limit: number | null,
) {
  return sql<RawBasicRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.org_id, lc.user_id, lc.brand_ids,
      lc.status, lc.status_reason, lc.status_details, lc.parent_run_id, lc.run_id,
      lc.served_at, lc.workflow_slug, lc.feature_slug,
      lc.goal, lc.active_goal_id, lc.brand_profile_id, lc.audience_id,
      lc.created_at,
      l.id AS l_id, l.apollo_person_id, l.first_name, l.last_name, l.name,
      l.headline, l.linkedin_url, l.photo_url,
      org.org_id AS org_id_inner, org.org_name, org.logo_url, org.primary_domain, org.website_url,
      em.value AS email_value, em.status AS email_status
    FROM leads_campaigns lc
    LEFT JOIN leads l ON l.id = lc.lead_id
    LEFT JOIN LATERAL (
      SELECT o.id AS org_id, o.name AS org_name, o.logo_url, o.primary_domain, o.website_url
      FROM leads_organizations lo
      LEFT JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.lead_id = lc.lead_id AND lo.current = true
      ORDER BY (CASE WHEN o.logo_url IS NOT NULL OR o.primary_domain IS NOT NULL THEN 1 ELSE 0 END) DESC,
               lo.created_at DESC NULLS LAST,
               lo.organization_id ASC
      LIMIT 1
    ) org ON true
    LEFT JOIN LATERAL (
      SELECT cm.value, cm.status
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) em ON true
    WHERE lc.org_id = ${f.orgId}
      ${f.brandId ? sql`AND ${f.brandId} = ANY(lc.brand_ids)` : sql``}
      ${f.campaignId ? sql`AND lc.campaign_id = ${f.campaignId}` : sql``}
      ${f.queryOrgId ? sql`AND lc.org_id = ${f.queryOrgId}` : sql``}
      ${f.userId ? sql`AND lc.user_id = ${f.userId}` : sql``}
      ${f.workflowSlug ? sql`AND lc.workflow_slug = ${f.workflowSlug}` : sql``}
      ${cursor ? sql`AND (lc.created_at, lc.id) > (${cursor.createdAt}, ${cursor.id})` : sql``}
    ORDER BY lc.created_at ASC, lc.id ASC
    ${limit == null ? sql`` : sql`LIMIT ${limit}`}
  `;
}

// Single flat query for the basic view: leads_campaigns ⋈ leads ⋈ current-employer
// org (5 cols) ⋈ primary email — no per-lead loop, no full-lead hydration.
export async function fetchBasicLeadChunk(
  f: BasicLeadFilters,
  cursor: BasicLeadCursor | null,
  limit: number,
): Promise<BasicLeadRow[]> {
  const rows = await basicLeadQuery(f, cursor, limit);
  return rows.map(mapRow);
}

export async function fetchBasicLeadRows(f: BasicLeadFilters): Promise<BasicLeadRow[]> {
  const rows: BasicLeadRow[] = [];
  const limit = Math.max(1, Number(process.env.LEADS_STREAM_CHUNK_SIZE) || 500);

  for await (const chunk of streamBasicLeadChunks(f, limit)) {
    rows.push(...chunk);
  }

  return rows;
}

export async function* streamBasicLeadChunks(
  f: BasicLeadFilters,
  limit: number,
): AsyncGenerator<BasicLeadRow[]> {
  for await (const rows of basicLeadQuery(f, null, null).cursor(Math.max(1, limit))) {
    if (rows.length === 0) continue;
    yield rows.map(mapRow);
  }
}
