/**
 * The query parameters each public read ACCEPTS (LEADS-UNKNOWN-FILTER-1105). Anything else is a 400
 * naming it and this list (`acceptQuery`, query-params.ts): a filter a read does not know is
 * refused, never silently dropped into an unfiltered answer. Each list is exactly what the route's
 * code reads, plus `orgId` (a staff key's target, added by `acceptQuery`).
 *
 * Adding a parameter to a route = add it here in the same change. A parameter a live caller sends is
 * pinned in tests/unit/read-query-vocabulary.test.ts: removing one from here fails that test.
 */

/** Which population a leads read is about (resolveLeadReadScope, routes/leads.ts). */
const LEAD_SCOPE = ["brandId", "campaignId", "offerId", "orgId", "userId", "workflowSlug"] as const;

/** The six Unibox dimensions + status/type and the scope (routes/unibox.ts filtersOf/scopeOf). */
const UNIBOX_FILTERS = [
  "brandId", "offerId", "campaignId",
  "status", "role", "type", "lifecycle", "interest", "conversation", "contactability", "fit", "q",
] as const;

export const READ_QUERY_PARAMS = {
  "GET /orgs/leads": [
    ...LEAD_SCOPE,
    "status", "q", "bucket", "standing", "stage", "sort", "format", "view", "include",
    "limit", "cursor", "offset",
  ],
  "GET /orgs/leads/bucket-counts": [...LEAD_SCOPE, "status", "q"],
  "GET /orgs/leads/standing-counts": [...LEAD_SCOPE, "status", "q", "breakdown"],
  // The page-shaping params the feed names in its own refusal (CHANGE_FEED_REFUSED_PARAMS) stay
  // accepted HERE so that refusal, which says why, answers them (never this generic one).
  "GET /orgs/leads/changes": [
    ...LEAD_SCOPE, "status", "since", "view",
    "q", "bucket", "standing", "stage", "sort", "format", "include", "limit", "offset", "cursor",
  ],
  // `brandId` here is the TARGET context the MCP's generic call appends (`distribute_call_api`);
  // the campaign already names the brand, so it narrows nothing and is not a filter of these reads.
  "GET /orgs/leads/conversation-counts": ["campaignId", "brandId"],
  "GET /orgs/leads/:id": ["brandId", "campaignId", "include"],
  // `campaignId` stays accepted so the route's own refusal ("campaignId is the path") answers it.
  "GET /orgs/campaigns/:campaignId/leads/by-lead/:leadId": ["brandId", "campaignId", "include"],
  "GET /orgs/leads/unibox": [...UNIBOX_FILTERS, "limit", "cursor", "sort"],
  "GET /orgs/leads/unibox-lifecycle-counts": [...UNIBOX_FILTERS],
  "GET /orgs/leads/unibox-lead": ["brandId", "humanId", "relationKey"],
  "GET /orgs/leads/awaiting-reply": ["brandId"],
  "GET /orgs/leads/disqualifications": ["brandId", "offerId"],
  "GET /orgs/leads/not-a-person": ["leadId"],
  "GET /orgs/brands/:brandId/conversions": ["event", "leadId", "email", "limit"],
  "GET /orgs/followup-dates/scheduled": ["campaignIds", "brandId"],
  "GET /orgs/brands/:brandId/prospect-followup": ["email"],
  "GET /orgs/brands/:brandId/relationships/review": [],
  "GET /orgs/brands/:brandId/won-leads": ["email"],
  "GET /orgs/brands/:brandId/never-cold-contact": ["email"],
  "GET /orgs/leads/crm-pairings": ["brandId", "limit", "offset", "state", "toConfirm"],
  "GET /orgs/leads/crm-pairing-counts": ["brandId"],
  "GET /orgs/stats": [
    "brandId", "campaignId", "orgId", "userId", "runIds", "goal", "activeGoalId", "brandProfileId", "audienceId",
    "workflowDynastySlug", "featureDynastySlug", "workflowSlug", "workflowSlugs", "featureSlug", "featureSlugs",
    "groupBy",
  ],
} as const satisfies Record<string, readonly string[]>;

export type QueryCheckedRead = keyof typeof READ_QUERY_PARAMS;
