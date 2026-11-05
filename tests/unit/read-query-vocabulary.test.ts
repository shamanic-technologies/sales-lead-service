import { describe, it, expect } from "vitest";
import { READ_QUERY_PARAMS, type QueryCheckedRead } from "../../src/lib/read-query-vocabulary.js";
import { TARGET_QUERY_PARAMS } from "../../src/lib/query-params.js";

// LEADS-UNKNOWN-FILTER-1105: every query parameter a LIVE caller sends today (origin/main of each
// repo, inventoried 2026-11-05) stays accepted. Removing one from the vocabulary breaks that caller:
// this test fails first. A new caller param = add it to the vocabulary AND here.
const LIVE_CALLERS: Array<{ read: QueryCheckedRead; caller: string; params: string[] }> = [
  // GET /orgs/leads
  { read: "GET /orgs/leads", caller: "distribute.you dashboard (api.ts leadScopeQuery/listLeadsPage, data.ts, people/campaign/company pages)", params: ["brandId", "campaignId", "offerId", "view", "include", "bucket", "sort", "standing", "limit", "offset", "q", "format"] },
  { read: "GET /orgs/leads", caller: "distribute.you admin (api.ts, report-api.ts)", params: ["brandId", "campaignId", "view", "status"] },
  { read: "GET /orgs/leads", caller: "mcp tools/index.ts (list leads, compact walk) + withTarget", params: ["brandId", "campaignId", "limit", "cursor", "view", "status", "orgId"] },
  { read: "GET /orgs/leads", caller: "chat-service account-client.ts / Sophie skills", params: ["brandId", "offerId", "view", "bucket", "sort", "standing", "limit"] },
  { read: "GET /orgs/leads", caller: "features-service leads-client.ts", params: ["brandId", "campaignId", "view", "standing", "limit", "cursor"] },
  { read: "GET /orgs/leads", caller: "crm-service people/sources.ts + outcomes.ts", params: ["brandId", "campaignId", "offerId", "view", "status", "bucket", "sort", "limit", "offset", "cursor", "q"] },
  { read: "GET /orgs/leads", caller: "campaign-service lead-activity-client.ts", params: ["brandId", "campaignId", "offerId", "view"] },
  { read: "GET /orgs/leads", caller: "instantly-service lead-client.ts", params: ["brandId", "campaignId", "view", "status", "limit", "q"] },
  { read: "GET /orgs/leads", caller: "distribute CLI routes.ts", params: ["brandId", "campaignId", "view", "limit", "offset"] },
  // counts and feed
  { read: "GET /orgs/leads/bucket-counts", caller: "dashboard api.ts + features lead-bucket-counts-client.ts, view-facts.ts", params: ["brandId", "campaignId", "offerId", "q"] },
  { read: "GET /orgs/leads/standing-counts", caller: "dashboard api.ts + features view-facts.ts", params: ["brandId", "campaignId", "offerId", "q"] },
  { read: "GET /orgs/leads/changes", caller: "features-service leads-client.ts", params: ["brandId", "campaignId", "since"] },
  { read: "GET /orgs/leads/conversation-counts", caller: "dashboard api.ts", params: ["campaignId"] },
  // one lead
  { read: "GET /orgs/leads/:id", caller: "dashboard api.ts", params: ["brandId"] },
  { read: "GET /orgs/leads/:id", caller: "workflow-service DAGs (follow-up, ai-instant-call, ai-meeting-booking, cold-whatsapp, email-sending, form-meeting-booking)", params: ["campaignId"] },
  { read: "GET /orgs/leads/:id", caller: "mcp tools/index.ts + withTarget", params: ["brandId", "orgId"] },
  { read: "GET /orgs/campaigns/:campaignId/leads/by-lead/:leadId", caller: "mcp tools/index.ts + withTarget", params: ["brandId", "orgId"] },
  // Unibox
  { read: "GET /orgs/leads/unibox", caller: "dashboard unibox-leads.ts uniboxQuery", params: ["brandId", "offerId", "campaignId", "status", "role", "lifecycle", "interest", "conversation", "contactability", "fit", "limit", "q", "cursor", "sort"] },
  { read: "GET /orgs/leads/unibox", caller: "features-service leads-client.ts", params: ["brandId", "lifecycle", "limit", "cursor"] },
  { read: "GET /orgs/leads/unibox-lifecycle-counts", caller: "dashboard unibox-leads.ts uniboxCountsQuery", params: ["brandId", "offerId", "campaignId", "status", "role", "lifecycle", "interest", "conversation", "contactability", "fit"] },
  { read: "GET /orgs/leads/unibox-lead", caller: "dashboard api.ts uniboxCardQuery", params: ["brandId", "relationKey", "humanId"] },
  // brand reads
  { read: "GET /orgs/leads/awaiting-reply", caller: "dashboard api.ts", params: ["brandId"] },
  { read: "GET /orgs/leads/disqualifications", caller: "dashboard api.ts + features disqualification-marks.ts", params: ["brandId", "offerId"] },
  { read: "GET /orgs/followup-dates/scheduled", caller: "features-service campaign-next-steps-io.ts", params: ["campaignIds"] },
  { read: "GET /orgs/brands/:brandId/relationships/review", caller: "dashboard api.ts", params: [] },
  { read: "GET /orgs/leads/crm-pairings", caller: "dashboard api.ts", params: ["brandId", "limit", "offset", "state", "toConfirm"] },
  { read: "GET /orgs/leads/crm-pairing-counts", caller: "dashboard api.ts", params: ["brandId"] },
  // stats
  { read: "GET /orgs/stats", caller: "api-service routes/campaigns.ts", params: ["orgId", "brandId", "groupBy", "workflowSlug", "featureSlug", "workflowDynastySlug", "featureDynastySlug", "campaignId"] },
  { read: "GET /orgs/stats", caller: "features-service routes/stats.ts", params: ["groupBy", "workflowSlug", "workflowDynastySlug", "featureSlug", "brandId", "campaignId"] },
  { read: "GET /orgs/stats", caller: "distribute CLI routes.ts", params: ["brandId", "campaignId", "groupBy"] },
];

describe("every parameter a live caller sends is still accepted (LEADS-UNKNOWN-FILTER-1105)", () => {
  for (const { read, caller, params } of LIVE_CALLERS) {
    it(`${read} accepts what ${caller} sends`, () => {
      const accepted = new Set<string>([...READ_QUERY_PARAMS[read], ...TARGET_QUERY_PARAMS]);
      expect(params.filter((p) => !accepted.has(p))).toEqual([]);
    });
  }

  it("a staff key's target org is accepted on every checked read (MCP withTarget, api-service stats)", () => {
    expect(TARGET_QUERY_PARAMS).toContain("orgId");
  });

  it("the parameter that started it is NOT a filter of the leads list (no alias)", () => {
    expect(READ_QUERY_PARAMS["GET /orgs/leads"]).not.toContain("replyClassification");
  });
});
