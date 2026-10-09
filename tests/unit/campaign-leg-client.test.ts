import { describe, it, expect, afterEach, vi } from "vitest";

const { fetchOrgCampaignLegs } = await import("../../src/lib/campaign-leg-client.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchOrgCampaignLegs (outbound leg rename, wave 2)", () => {
  it("serves an outbound leg in its new spelling whichever one campaign-service stored", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          campaigns: [
            { id: "legacy", legKey: "start_to_conversation", featureSlug: "sales-cold-email-outreach" },
            { id: "renamed", legKey: "lead_found_to_website_visit", featureSlug: "cold-linkedin-outreach" },
            { id: "ads", legKey: "start_to_website_visit", featureSlug: "google-ads" },
            { id: "source", legKey: "start_to_lead_found", featureSlug: "apollo-cold-filters" },
            { id: "none", legKey: null, featureSlug: "sales-cold-email-outreach" },
          ],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const legs = await fetchOrgCampaignLegs({ orgId: "o" });
    expect(Object.fromEntries(legs)).toEqual({
      legacy: "lead_found_to_conversation",
      renamed: "lead_found_to_website_visit",
      ads: "start_to_website_visit",
      source: "start_to_lead_found",
      none: null,
    });
  });
});
