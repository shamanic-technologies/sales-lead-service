import { sql } from "../db/index.js";
import {
  campaignScopeIds,
  leadCampaignBaseRelation,
  leadCursorTimestampParam,
  leadRowIdScope,
  leadStatusScope,
  UNBOUNDED_LEAD_PAGE,
  type LeadListCursor,
  type LeadListPage,
  type LeadListScope,
} from "./lead-list-query.js";

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
  // Additive firmographic fields (#327) — same names/types as FullLead.
  // Still excludes the heavy stuff (subdepartments, twitter/github/etc, full
  // employmentHistory) to keep basic ~10x smaller than full.
  seniority: string | null;
  departments: string[] | null;
  functions: string[] | null;
  // Current-employer job title (#336) — same name/type as FullLead.currentTitle.
  // Sourced from the current employment row (leads_organizations.title), NOT nested
  // inside organization, matching the full lead shape.
  currentTitle: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organization: {
    id: string;
    name: string | null;
    logoUrl: string | null;
    primaryDomain: string | null;
    websiteUrl: string | null;
    // Additive firmographic fields (#327) — same names/types as OrganizationView.
    // Excludes the heavy arrays (technologyNames, secondaryIndustries) and
    // funding events to keep basic lean.
    industry: string | null;
    industries: string[] | null;
    estimatedNumEmployees: number | null;
    annualRevenue: string | null;
    foundedYear: number | null;
    shortDescription: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
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
  /** `created_at::text` — what a cursor is built from; keeps the microseconds a Date drops. */
  cursorCreatedAt: string;
  leadApolloPersonId: string | null;
  lead: BasicSlimLead | null;
  email: { value: string; status: string | null } | null;
}

// The basic-view filters are exactly the shared list scope.
export type BasicLeadFilters = LeadListScope;

// Date OR string: postgres.js hands a timestamptz back either way depending on the path, and a
// cursor is built straight off a raw row. See LeadListCursor.
export type BasicLeadCursor = LeadListCursor;

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
  // Full-precision text of the same column, for the keyset cursor (see LeadListCursor).
  created_at_cursor: string;
  l_id: string | null;
  apollo_person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  headline: string | null;
  linkedin_url: string | null;
  photo_url: string | null;
  seniority: string | null;
  departments: string[] | null;
  functions: string[] | null;
  current_title: string | null;
  l_city: string | null;
  l_state: string | null;
  l_country: string | null;
  org_id_inner: string | null;
  org_name: string | null;
  logo_url: string | null;
  primary_domain: string | null;
  website_url: string | null;
  industry: string | null;
  industries: string[] | null;
  estimated_num_employees: number | null;
  annual_revenue: string | null;
  founded_year: number | null;
  short_description: string | null;
  org_city: string | null;
  org_state: string | null;
  org_country: string | null;
  email_value: string | null;
  email_status: string | null;
}

export function toIsoTimestamp(value: RawTimestamp): string | null {
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
        seniority: r.seniority,
        departments: r.departments,
        functions: r.functions,
        currentTitle: r.current_title,
        city: r.l_city,
        state: r.l_state,
        country: r.l_country,
        organization: r.org_id_inner
          ? {
              id: r.org_id_inner,
              name: r.org_name,
              logoUrl: r.logo_url,
              primaryDomain: r.primary_domain,
              websiteUrl: r.website_url,
              industry: r.industry,
              industries: r.industries,
              estimatedNumEmployees: r.estimated_num_employees,
              annualRevenue: r.annual_revenue,
              foundedYear: r.founded_year,
              shortDescription: r.short_description,
              city: r.org_city,
              state: r.org_state,
              country: r.org_country,
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
    cursorCreatedAt: r.created_at_cursor,
    leadApolloPersonId: r.apollo_person_id,
    lead,
    email: r.email_value != null ? { value: r.email_value, status: r.email_status } : null,
  };
}

// THE PAGE IS CHOSEN BEFORE ANYTHING IS JOINED ONTO IT. The scope filter, the keyset position and
// the LIMIT/OFFSET all live in the inner subquery, so the per-lead lookups below (the person, the
// current employer, the primary email) run once per row that is RETURNED, not once per row in the
// brand. With them on the outer query instead, Postgres joined all three onto the brand's whole
// deduped population and only then sorted and cut it: measured in production on a 49,792-row brand,
// every 500-row chunk cost ~1.2 s, of which ~1.05 s was lookups for rows the LIMIT then threw away.
// Same rows, same order, same columns — only where the cut happens moved.
function basicLeadQuery(
  f: BasicLeadFilters,
  cursor: BasicLeadCursor | null,
  limit: number | null,
  offset: number | null = null,
) {
  return sql<RawBasicRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.org_id, lc.user_id, lc.brand_ids,
      lc.status, lc.status_reason, lc.status_details, lc.parent_run_id, lc.run_id,
      lc.served_at, lc.workflow_slug, lc.feature_slug,
      lc.goal, lc.active_goal_id, lc.brand_profile_id, lc.audience_id,
      lc.created_at,
      lc.created_at::text AS created_at_cursor,
      l.id AS l_id, l.apollo_person_id, l.first_name, l.last_name, l.name,
      l.headline, l.linkedin_url, l.photo_url,
      l.seniority, l.departments, l.functions,
      l.city AS l_city, l.state AS l_state, l.country AS l_country,
      org.current_title,
      org.org_id AS org_id_inner, org.org_name, org.logo_url, org.primary_domain, org.website_url,
      org.industry, org.industries, org.estimated_num_employees, org.annual_revenue,
      org.founded_year, org.short_description,
      org.org_city, org.org_state, org.org_country,
      em.value AS email_value, em.status AS email_status
    FROM (
      SELECT lc.*
      FROM ${leadCampaignBaseRelation(f)}
      WHERE lc.org_id = ${f.orgId}
        ${f.brandId ? sql`AND ${f.brandId} = ANY(lc.brand_ids)` : sql``}
        ${campaignScopeIds(f) ? sql`AND lc.campaign_id = ANY(${campaignScopeIds(f)!})` : sql``}
        ${leadStatusScope(f) ? sql`AND lc.status = ANY(${leadStatusScope(f)!})` : sql``}
        ${f.queryOrgId ? sql`AND lc.org_id = ${f.queryOrgId}` : sql``}
        ${f.userId ? sql`AND lc.user_id = ${f.userId}` : sql``}
        ${f.workflowSlug ? sql`AND lc.workflow_slug = ${f.workflowSlug}` : sql``}
        ${leadRowIdScope(f) ? sql`AND lc.id = ANY(${leadRowIdScope(f)!}::uuid[])` : sql``}
        ${f.leadIds ? sql`AND lc.lead_id = ANY(${[...f.leadIds]}::uuid[])` : sql``}
        ${cursor ? sql`AND (lc.created_at, lc.id) > (${leadCursorTimestampParam(cursor)}, ${cursor.id})` : sql``}
      ORDER BY lc.created_at ASC, lc.id ASC
      ${limit == null ? sql`` : sql`LIMIT ${limit}`}
      ${offset == null || offset === 0 ? sql`` : sql`OFFSET ${offset}`}
    ) lc
    LEFT JOIN leads l ON l.id = lc.lead_id
    LEFT JOIN LATERAL (
      SELECT lo.title AS current_title,
             o.id AS org_id, o.name AS org_name, o.logo_url, o.primary_domain, o.website_url,
             o.industry, o.industries, o.estimated_num_employees, o.annual_revenue,
             o.founded_year, o.short_description,
             o.city AS org_city, o.state AS org_state, o.country AS org_country
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
    ORDER BY lc.created_at ASC, lc.id ASC
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

/**
 * Stream the scoped population in chunks of at most `chunkSize`.
 *
 * ONE statement per read, streamed through a server-side `.cursor()`, whether or not the read is
 * bounded. A bounded read carries its `limit` / keyset `cursor` / `offset` INTO that statement, so
 * it never fetches more rows than the caller asked for — the delivery overlay and the JSON
 * serialization stay per-returned-row, which is what makes a `limit=50` read cheap.
 *
 * It used to issue a SEPARATE statement per chunk of a bounded page, and each one re-ran the brand's
 * whole-population dedup (see leadCampaignBaseRelation) just to cut the next 500 rows off it: a
 * 5,000-row page of a 49,792-row brand paid that dedup ten times. One statement pays it once.
 */
export async function* streamBasicLeadChunks(
  f: BasicLeadFilters,
  chunkSize: number,
  page: LeadListPage = UNBOUNDED_LEAD_PAGE,
): AsyncGenerator<BasicLeadRow[]> {
  const size = Math.max(1, chunkSize);
  for await (const rows of basicLeadQuery(f, page.cursor, page.limit, page.offset).cursor(size)) {
    if (rows.length === 0) continue;
    yield rows.map(mapRow);
  }
}
