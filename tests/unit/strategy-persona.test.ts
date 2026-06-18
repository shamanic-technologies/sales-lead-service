import { beforeEach, describe, expect, it, vi } from "vitest";

// buildStrategyContext only awaits fetchCampaign + extractBrandFields +
// listActivePersonas. Mock those three clients; no other deps are exercised.
const fetchCampaign = vi.fn();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: (...args: unknown[]) => fetchCampaign(...args),
}));

const extractBrandFields = vi.fn();
const listActivePersonas = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: (...args: unknown[]) => extractBrandFields(...args),
  listActivePersonas: (...args: unknown[]) => listActivePersonas(...args),
}));

import { buildStrategyContext } from "../../src/lib/buffer.js";

const baseParams = {
  orgId: "org-1",
  campaignId: "camp-1",
  brandIdCsv: "brand-1",
  provider: "apollo" as const,
};

describe("buildStrategyContext persona injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCampaign.mockResolvedValue({ targetAudience: "Developer tools buyers" });
    extractBrandFields.mockResolvedValue([{ key: "brand_name", value: "Acme", cached: false, extractedAt: "", expiresAt: null, sourceUrls: null }]);
  });

  it("AC1: appends active persona names + structured filters to the description", async () => {
    listActivePersonas.mockResolvedValue([
      {
        name: "Product & Engineering Leads",
        filters: {
          jobTitles: ["Product Manager", "VP of Product", "CTO"],
          seniority: ["director", "vp", "c_suite"],
          department: ["engineering", "product"],
        },
      },
    ]);

    const ctx = await buildStrategyContext(baseParams);

    expect(listActivePersonas).toHaveBeenCalledWith("brand-1", "org-1", expect.anything());
    expect(ctx.brandCampaignDescription).toContain("Active customer personas (prioritize matching these):");
    expect(ctx.brandCampaignDescription).toContain("Product & Engineering Leads");
    expect(ctx.brandCampaignDescription).toContain("jobTitles=[Product Manager, VP of Product, CTO]");
    expect(ctx.brandCampaignDescription).toContain("seniority=[director, vp, c_suite]");
    expect(ctx.brandCampaignDescription).toContain("department=[engineering, product]");
  });

  it("AC1 multi-brand: fetches personas per brand and appends all", async () => {
    listActivePersonas
      .mockResolvedValueOnce([{ name: "Persona A", filters: { jobTitles: ["CEO"] } }])
      .mockResolvedValueOnce([{ name: "Persona B", filters: { industry: ["fintech"] } }]);

    const ctx = await buildStrategyContext({ ...baseParams, brandIdCsv: "brand-1, brand-2" });

    expect(listActivePersonas).toHaveBeenCalledTimes(2);
    expect(listActivePersonas).toHaveBeenNthCalledWith(1, "brand-1", "org-1", expect.anything());
    expect(listActivePersonas).toHaveBeenNthCalledWith(2, "brand-2", "org-1", expect.anything());
    expect(ctx.brandCampaignDescription).toContain("- Persona A: jobTitles=[CEO]");
    expect(ctx.brandCampaignDescription).toContain("- Persona B: industry=[fintech]");
  });

  it("AC2: empty persona list leaves the description unchanged (no persona lines)", async () => {
    listActivePersonas.mockResolvedValue([]);

    const ctx = await buildStrategyContext(baseParams);

    expect(ctx.brandCampaignDescription).not.toContain("Active customer personas");
    expect(ctx.brandCampaignDescription).toContain("Campaign target audience: Developer tools buyers");
    expect(ctx.brandCampaignDescription).toContain("Brand Name: Acme");
  });

  it("AC3: a thrown persona fetch (5xx) propagates — not swallowed", async () => {
    listActivePersonas.mockRejectedValue(new Error("[brand-client] list personas failed for brand brand-1: 500"));

    await expect(buildStrategyContext(baseParams)).rejects.toThrow(/list personas failed/);
  });
});
