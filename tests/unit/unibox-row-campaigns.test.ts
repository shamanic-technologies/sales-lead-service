import { describe, expect, it } from "vitest";
import { foldRowCampaigns } from "../../src/lib/unibox-model.js";

const displays = new Map([
  ["pipe-a", { id: "sfc-1", name: "Cold email to meeting" }],
  ["pipe-b", { id: "sfc-1", name: "Cold email to meeting" }],
  ["camp-w", { id: "camp-w", name: "Webinar" }],
  ["camp-x", { id: "camp-x", name: "Expo" }],
]);

describe("foldRowCampaigns (DEALS-LIFECYCLE-1021)", () => {
  it("folds pipes into the customer's campaign once, first serve kept, most recent first, undated last, no-campaign filings dropped", () => {
    expect(
      foldRowCampaigns(
        [
          { campaignId: "pipe-b", servedAt: "2026-10-03T00:00:00.000Z" },
          { campaignId: "pipe-a", servedAt: "2026-10-02T00:00:00.000Z" },
          { campaignId: "camp-x", servedAt: null },
          { campaignId: "signups:brand", servedAt: "2026-10-09T00:00:00.000Z" },
          { campaignId: "camp-w", servedAt: "2026-10-05T00:00:00.000Z" },
        ],
        displays,
      ),
    ).toEqual([
      { campaignId: "camp-w", name: "Webinar", pipeCampaignIds: ["camp-w"], servedAt: "2026-10-05T00:00:00.000Z" },
      { campaignId: "sfc-1", name: "Cold email to meeting", pipeCampaignIds: ["pipe-a", "pipe-b"], servedAt: "2026-10-02T00:00:00.000Z" },
      { campaignId: "camp-x", name: "Expo", pipeCampaignIds: ["camp-x"], servedAt: null },
    ]);
  });

  it("a lead of no campaign = []", () => {
    expect(foldRowCampaigns([], displays)).toEqual([]);
  });
});
