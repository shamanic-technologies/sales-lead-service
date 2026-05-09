import { describe, it, expect, vi, beforeEach } from "vitest";

const insertReturning = vi.fn().mockResolvedValue([{ id: "new-org-id" }]);
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const findFirstOrg = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
    query: {
      organizations: { findFirst: (...a: unknown[]) => findFirstOrg(...a) },
    },
  },
}));

const FULL_APOLLO_ORG_PAYLOAD = {
  id: "person-1",
  organizationId: "apollo-org-1",
  organizationName: "Casco Bay",
  organizationDomain: "cascobay.com",
  organizationWebsiteUrl: "https://cascobay.com",
  organizationIndustry: "marketing",
  organizationLogoUrl: "https://logo.com/x.png",
  organizationShortDescription: "boutique",
  organizationLinkedinUrl: "https://linkedin.com/company/cascobay",
  organizationTwitterUrl: "https://twitter.com/cb",
  organizationFacebookUrl: "https://facebook.com/cb",
  organizationBlogUrl: "https://cascobay.com/blog",
  organizationCrunchbaseUrl: "https://crunchbase.com/cb",
  organizationFoundedYear: 2018,
  organizationCity: "Portland",
  organizationState: "ME",
  organizationCountry: "USA",
  organizationStreetAddress: "123 Main St",
  organizationPostalCode: "04101",
  organizationSize: "12",
  organizationRevenueUsd: "1000000",
  organizationTechnologyNames: ["GA4"],
  organizationIndustries: ["marketing"],
  organizationSecondaryIndustries: ["digital-marketing"],
  // 14 new fields
  organizationLatestFundingStage: "series_a",
  organizationLatestFundingRoundDate: "2024-06-01",
  organizationTotalFunding: "5000000",
  organizationTotalFundingPrinted: "$5M",
  organizationFundingEvents: [
    {
      id: "fund-1",
      date: "2024-06-01",
      type: "Series A",
      investors: "Acme VC",
      amount: 5000000,
      currency: "USD",
      news_url: "https://example.com/news/1",
    },
  ],
  organizationRetailLocationCount: 3,
  organizationPubliclyTradedSymbol: "CSCO",
  organizationPubliclyTradedExchange: "NASDAQ",
  organizationPrimaryPhone: "+15555550100",
  organizationSeoDescription: "Boutique marketing.",
  organizationAngellistUrl: "https://angel.co/cb",
  organizationNumSuborganizations: 2,
  organizationAlexaRanking: 250000,
  organizationKeywords: ["marketing", "branding"],
};

describe("pickOrgFields (via upsertOrganizationFromPerson) populates 14 new columns", () => {
  beforeEach(() => {
    insertValues.mockClear();
    insertReturning.mockClear();
    findFirstOrg.mockClear();
    findFirstOrg.mockResolvedValue(undefined);
  });

  it("maps all 14 new Apollo fields onto NewOrganization", async () => {
    const { upsertOrganizationFromPerson } = await import("../../src/lib/leads-registry.js");

    await upsertOrganizationFromPerson(FULL_APOLLO_ORG_PAYLOAD as never);

    expect(insertValues).toHaveBeenCalledOnce();
    const payload = insertValues.mock.calls[0][0] as Record<string, unknown>;

    // Existing mappings still work
    expect(payload.name).toBe("Casco Bay");
    expect(payload.primaryDomain).toBe("cascobay.com");

    // 14 new mappings
    expect(payload.latestFundingStage).toBe("series_a");
    expect(payload.latestFundingRoundDate).toBe("2024-06-01");
    expect(payload.totalFunding).toBe("5000000");
    expect(payload.totalFundingPrinted).toBe("$5M");
    expect(payload.fundingEvents).toEqual([
      {
        id: "fund-1",
        date: "2024-06-01",
        type: "Series A",
        investors: "Acme VC",
        amount: 5000000,
        currency: "USD",
        news_url: "https://example.com/news/1",
      },
    ]);
    expect(payload.retailLocationCount).toBe(3);
    expect(payload.publiclyTradedSymbol).toBe("CSCO");
    expect(payload.publiclyTradedExchange).toBe("NASDAQ");
    expect(payload.primaryPhone).toBe("+15555550100");
    expect(payload.seoDescription).toBe("Boutique marketing.");
    expect(payload.angellistUrl).toBe("https://angel.co/cb");
    expect(payload.numSuborganizations).toBe(2);
    expect(payload.alexaRanking).toBe(250000);
    expect(payload.keywords).toEqual(["marketing", "branding"]);
  });

  it("omits new columns when Apollo fields are absent", async () => {
    const { upsertOrganizationFromPerson } = await import("../../src/lib/leads-registry.js");

    await upsertOrganizationFromPerson({
      id: "person-2",
      organizationId: "apollo-org-2",
      organizationName: "Minimal Co",
    } as never);

    expect(insertValues).toHaveBeenCalledOnce();
    const payload = insertValues.mock.calls[0][0] as Record<string, unknown>;

    expect(payload.name).toBe("Minimal Co");
    expect(payload.latestFundingStage).toBeUndefined();
    expect(payload.fundingEvents).toBeUndefined();
    expect(payload.keywords).toBeUndefined();
    expect(payload.publiclyTradedSymbol).toBeUndefined();
  });
});
