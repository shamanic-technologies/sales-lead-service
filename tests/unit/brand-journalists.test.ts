import { describe, expect, it } from "vitest";
import { parseChannelKinds } from "../../src/lib/brand-journalists.js";
import { BUSINESS_ONLY_EXCLUDED, PURE_PROSPECT_EXCLUDED, policyAllows, pureProspectAllows, RELATIONSHIP_TAGS } from "../../src/lib/relationship-tags.js";

describe("journalist tag (JOURNALISTS-NOT-LEADS-1016)", () => {
  it("is its own relationship, never a lead under either pipe policy", () => {
    expect(RELATIONSHIP_TAGS).toContain("journalist");
    expect(BUSINESS_ONLY_EXCLUDED).toContain("journalist");
    expect(PURE_PROSPECT_EXCLUDED).toContain("journalist");
    const block = { subject: false, tags: ["journalist", "prospect"] as const, unsureTags: [] as const, judgedAt: "2026-10-16T00:00:00Z" };
    expect(pureProspectAllows({ ...block, tags: [...block.tags], unsureTags: [] })).toBe(false);
    expect(policyAllows("business_only", { tags: ["journalist"], unsureTags: [], judgedAt: "2026-10-16T00:00:00Z" })).toBe(false);
    expect(pureProspectAllows({ subject: false, tags: [], unsureTags: ["journalist"], judgedAt: null })).toBe(false);
    expect(pureProspectAllows({ subject: false, tags: ["prospect"], unsureTags: [], judgedAt: null })).toBe(true);
  });

  it("reads press and sales channels off the catalogue's channelType, never a slug list", () => {
    expect(
      parseChannelKinds({
        channels: [
          { slug: "pr-cold-email-outreach", channelType: "pr" },
          { slug: "press-placements", channelType: "pr" },
          { slug: "sales-cold-email-outreach", channelType: "outbound" },
          { slug: "ai-follow-up-email", channelType: "conversion" },
        ],
      }),
    ).toEqual({ press: ["pr-cold-email-outreach", "press-placements"], sales: ["sales-cold-email-outreach"] });
  });

  it("fails loud on an unreadable catalogue or one naming no press channel", () => {
    expect(() => parseChannelKinds({})).toThrow(/channels array/);
    expect(() => parseChannelKinds({ channels: [{ slug: "x", channelType: "outbound" }] })).toThrow(/no press channel/);
  });
});
