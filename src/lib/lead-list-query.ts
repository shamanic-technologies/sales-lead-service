import { sql } from "../db/index.js";

// Shared scope for the two `GET /orgs/leads` code paths (slim `?view=basic` and the
// default full path). Mirrors the headers/query the route reads. `leads_campaigns`
// holds one row per (person × campaign-membership/serve), so a person engaged across
// N campaigns for a brand otherwise appears N times in a brand/org-scoped list.
export interface LeadListScope {
  orgId: string;
  brandId?: string;
  campaignId?: string;
  queryOrgId?: string;
  userId?: string;
  workflowSlug?: string;
}

// Brand/org-scoped reads must be ONE row per PERSON, not one per campaign-membership.
// Campaign-scoped reads (`campaignId` present) are already ~1 row per person, so we
// keep them flat — that also guarantees a genuine per-campaign membership row is never
// silently collapsed (AC: campaign-scope unchanged).
export function shouldDedupeLeadList(f: LeadListScope): boolean {
  return !f.campaignId;
}

// Base relation aliased as `lc` for the list queries.
//
// For brand/org scope, collapse `leads_campaigns` to the single winning membership per
// `lead_id` via DISTINCT ON. The winner is the most-advanced lifecycle row (served >
// claimed > buffered > skipped) so the kept row fires the served-only delivery overlay
// whenever the person was served under ANY campaign; ties break on latest served_at,
// latest created_at, then stable id. The delivery overlay is keyed by EMAIL at brand
// scope and is identical across a person's rows, so whichever membership wins carries
// the person's full brand-level engagement (clicked/opened/replied OR-merged inherently).
//
// The DISTINCT ON must be GLOBAL (computed over the whole filtered set), so it lives in
// a subquery; the outer query then keyset-paginates / orders the DEDUPED relation by
// (created_at, id). Scope filters are applied here AND on the outer WHERE — duplicate
// predicates on the deduped relation are a harmless no-op, but they are REQUIRED on the
// outer query for the non-deduped (campaign) path.
export function leadCampaignBaseRelation(f: LeadListScope) {
  if (!shouldDedupeLeadList(f)) {
    return sql`leads_campaigns lc`;
  }
  return sql`(
    SELECT DISTINCT ON (lc0.lead_id) lc0.*
    FROM leads_campaigns lc0
    WHERE lc0.org_id = ${f.orgId}
      ${f.brandId ? sql`AND ${f.brandId} = ANY(lc0.brand_ids)` : sql``}
      ${f.queryOrgId ? sql`AND lc0.org_id = ${f.queryOrgId}` : sql``}
      ${f.userId ? sql`AND lc0.user_id = ${f.userId}` : sql``}
      ${f.workflowSlug ? sql`AND lc0.workflow_slug = ${f.workflowSlug}` : sql``}
    ORDER BY lc0.lead_id,
      CASE lc0.status
        WHEN 'served' THEN 3
        WHEN 'claimed' THEN 2
        WHEN 'buffered' THEN 1
        ELSE 0
      END DESC,
      lc0.served_at DESC NULLS LAST,
      lc0.created_at DESC,
      lc0.id DESC
  ) lc`;
}
