import { describe, it, expect } from "vitest";
import { uniboxScopeCampaignIds } from "../../src/lib/unibox-scope.js";

// DEALS-LIFECYCLE-1021: which campaign ids an offer / campaign scope of the Unibox reads (campaign-service rows only).
const base = { orgId: "o", brandId: "b", acquisitionChannel: "cold-email", featureSlug: "sales-cold-email" };
const rows = [
  { ...base, id: "sfc-unit-a", offerId: "offer-1", legKey: "start_to_email_sent" },
  { ...base, id: "sfc-unit-b", offerId: "offer-1", legKey: "email_sent_to_conversation", acquisitionChannel: "reply" },
  // A stopped row of unit A's identity (an older workflow): the same campaign to the customer.
  { ...base, id: "old-unit-a", offerId: "offer-1", legKey: "start_to_email_sent" },
  { ...base, id: "other-offer", offerId: "offer-2", legKey: "start_to_email_sent" },
  { ...base, id: "no-offer", offerId: null, legKey: "start_to_email_sent", acquisitionChannel: "webinar" },
];

describe("uniboxScopeCampaignIds", () => {
  it("offer = every campaign row naming it", () => {
    expect(uniboxScopeCampaignIds(rows, { offerId: "offer-1" })).toEqual(["old-unit-a", "sfc-unit-a", "sfc-unit-b"]);
    expect(uniboxScopeCampaignIds(rows, { offerId: "offer-unknown" })).toEqual([]);
  });

  it("a sales funnel campaign = itself + its pipes + each pipe's identity rows", () => {
    expect(uniboxScopeCampaignIds(rows, { campaignId: "sfc-1" }, ["sfc-unit-a", "sfc-unit-b"])).toEqual(["old-unit-a", "sfc-1", "sfc-unit-a", "sfc-unit-b"]);
  });

  it("a plain campaign = its identity; one campaign-service does not know = itself", () => {
    expect(uniboxScopeCampaignIds(rows, { campaignId: "sfc-unit-a" })).toEqual(["old-unit-a", "sfc-unit-a"]);
    expect(uniboxScopeCampaignIds(rows, { campaignId: "ghost" })).toEqual(["ghost"]);
  });

  it("offer + campaign = the campaign's ids selling the offer; another offer's campaign = nobody", () => {
    expect(uniboxScopeCampaignIds(rows, { offerId: "offer-1", campaignId: "sfc-1" }, ["sfc-unit-a", "sfc-unit-b"])).toEqual(["old-unit-a", "sfc-unit-a", "sfc-unit-b"]);
    expect(uniboxScopeCampaignIds(rows, { offerId: "offer-1", campaignId: "sfc-2" }, ["other-offer"])).toEqual([]);
  });
});
