import { describe, expect, it } from "vitest";
import { isInteractiveRead } from "../../src/request-routing.js";

describe("which HTTP thread answers a request", () => {
  it.each([
    "/orgs/leads?brandId=b&offerId=o&view=basic&bucket=contacted&sort=activity&limit=50&offset=0",
    "/orgs/leads?brandId=b&view=basic&standing=customer&limit=20",
    "/orgs/leads?brandId=b&q=acme&limit=50",
    "/orgs/leads/bucket-counts?brandId=b&offerId=o",
    "/orgs/leads/standing-counts?brandId=b",
    "/orgs/leads/conversation-counts?campaignId=c",
    "/orgs/leads/0c718f70-108b-46b7-9ec8-1e58c4dbabf5?brandId=b",
    "/orgs/leads/0c718f70-108b-46b7-9ec8-1e58c4dbabf5/history?brandId=b&scope=campaign",
    "/orgs/leads/0c718f70-108b-46b7-9ec8-1e58c4dbabf5/step-statements",
    "/orgs/leads/0c718f70-108b-46b7-9ec8-1e58c4dbabf5/timeline?brandId=b&offerId=o",
  ])("a dashboard read goes to the interactive thread: %s", (url) => {
    expect(isInteractiveRead("GET", url)).toBe(true);
  });

  it.each([
    // whole-population walks
    "/orgs/leads?brandId=b&view=compact&limit=5000",
    "/orgs/leads?brandId=b&view=basic",
    "/orgs/leads?brandId=b&format=csv&limit=50",
    "/orgs/leads?brandId=b&include=campaigns&limit=50",
    "/orgs/leads/changes?brandId=b",
    // other surfaces
    "/orgs/leads/crm-pairings?brandId=b",
    "/orgs/leads/crm-pairing-counts?brandId=b",
    "/internal/brands/b/step-disqualifications",
    "/health",
    "/orgs/leads/x/step-statements/sale",
  ])("everything else stays on the general thread: %s", (url) => {
    expect(isInteractiveRead("GET", url)).toBe(false);
  });

  it("never routes a write to the interactive thread", () => {
    expect(isInteractiveRead("POST", "/orgs/leads/x/step-statements")).toBe(false);
    expect(isInteractiveRead("DELETE", "/orgs/leads/x/step-statements/sale")).toBe(false);
    expect(isInteractiveRead("POST", "/orgs/buffer/next")).toBe(false);
  });
});
