import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirstLead = vi.fn();
const findManyContacts = vi.fn();

const empWhere = vi.fn();
const empLeftJoin = vi.fn(() => ({ where: empWhere }));
const empFrom = vi.fn(() => ({ leftJoin: empLeftJoin }));
const dbSelect = vi.fn(() => ({ from: empFrom }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      leads: { findFirst: (...a: unknown[]) => findFirstLead(...a) },
      leadContactMethods: { findMany: (...a: unknown[]) => findManyContacts(...a) },
    },
    select: (...a: unknown[]) => dbSelect(...a),
  },
}));

// Every organizations.$inferSelect field, all null — spread + override per test.
const orgNulls = {
  apolloOrganizationId: null,
  name: null,
  primaryDomain: null,
  websiteUrl: null,
  industry: null,
  estimatedNumEmployees: null,
  annualRevenue: null,
  logoUrl: null,
  shortDescription: null,
  linkedinUrl: null,
  twitterUrl: null,
  facebookUrl: null,
  blogUrl: null,
  crunchbaseUrl: null,
  foundedYear: null,
  city: null,
  state: null,
  country: null,
  streetAddress: null,
  postalCode: null,
  technologyNames: null,
  industries: null,
  secondaryIndustries: null,
  latestFundingStage: null,
  latestFundingRoundDate: null,
  totalFunding: null,
  totalFundingPrinted: null,
  fundingEvents: null,
  retailLocationCount: null,
  publiclyTradedSymbol: null,
  publiclyTradedExchange: null,
  primaryPhone: null,
  seoDescription: null,
  angellistUrl: null,
  numSuborganizations: null,
  alexaRanking: null,
  keywords: null,
  metadata: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

const baseLead = {
  apolloPersonId: null,
  firstName: "X",
  lastName: "Y",
  name: null,
  headline: null,
  linkedinUrl: null,
  photoUrl: null,
  city: null,
  state: null,
  country: null,
  seniority: null,
  departments: null,
  subdepartments: null,
  functions: null,
  twitterUrl: null,
  githubUrl: null,
  facebookUrl: null,
  enrichedAt: null,
};

describe("buildFullLead", () => {
  beforeEach(() => {
    findFirstLead.mockReset();
    findManyContacts.mockReset();
    empWhere.mockReset();
    empLeftJoin.mockClear();
    empFrom.mockClear();
    dbSelect.mockClear();
  });

  it("returns canonical shape with current org, contacts, and employment history", async () => {
    findFirstLead.mockResolvedValue({
      id: "lead-1",
      apolloPersonId: "apollo-1",
      firstName: "Sara",
      lastName: "Freshley",
      name: "Sara Freshley",
      headline: "Founder",
      linkedinUrl: "https://linkedin.com/in/sara",
      photoUrl: null,
      city: "Portland",
      state: "ME",
      country: "USA",
      seniority: "founder",
      departments: ["c_suite"],
      subdepartments: null,
      functions: null,
      twitterUrl: null,
      githubUrl: null,
      facebookUrl: null,
      enrichedAt: new Date("2026-01-01T00:00:00Z"),
    });
    findManyContacts.mockResolvedValue([
      { channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
      { channel: "phone", value: "+15555555555", status: null, source: "apollo" },
    ]);
    empWhere.mockResolvedValue([
      {
        organizationId: "org-1",
        title: "Founder",
        startDate: "2018-01-01",
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: {
          ...orgNulls,
          id: "org-1",
          apolloOrganizationId: "apollo-org-1",
          name: "Casco Bay",
          primaryDomain: "cascobay.com",
          websiteUrl: "https://cascobay.com",
          industry: "marketing",
          estimatedNumEmployees: 12,
          annualRevenue: "1000000",
          logoUrl: null,
          shortDescription: "boutique agency",
          foundedYear: 2018,
          city: "Portland",
          state: "ME",
          country: "USA",
          technologyNames: ["GA4"],
          industries: ["marketing"],
          latestFundingStage: "series_a",
          latestFundingRoundDate: "2024-06-01",
          totalFunding: "5000000",
          totalFundingPrinted: "$5M",
          fundingEvents: [
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
          retailLocationCount: 3,
          primaryPhone: "+15555550100",
          seoDescription: "Boutique marketing agency.",
          numSuborganizations: 0,
          alexaRanking: 250000,
          keywords: ["marketing", "branding"],
        },
      },
    ]);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLead("lead-1");

    expect(result.leadId).toBe("lead-1");
    expect(result.firstName).toBe("Sara");
    expect(result.lastName).toBe("Freshley");
    expect(result.name).toBe("Sara Freshley");
    expect(result.headline).toBe("Founder");
    expect(result.organization).not.toBeNull();
    expect(result.organization?.name).toBe("Casco Bay");
    expect(result.organization?.primaryDomain).toBe("cascobay.com");
    expect(result.organization?.industry).toBe("marketing");
    expect(result.contacts).toHaveLength(2);
    expect(result.contacts[0]).toMatchObject({
      channel: "email",
      value: "sara@cascobay.com",
      status: "verified",
      source: "apollo",
    });
    expect(result.employmentHistory).toHaveLength(1);
    expect(result.employmentHistory[0]).toMatchObject({
      organizationName: "Casco Bay",
      title: "Founder",
      current: true,
    });
    expect(result.enrichedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.currentTitle).toBe("Founder");
    expect(result.organization?.latestFundingStage).toBe("series_a");
    expect(result.organization?.latestFundingRoundDate).toBe("2024-06-01");
    expect(result.organization?.totalFunding).toBe("5000000");
    expect(result.organization?.totalFundingPrinted).toBe("$5M");
    expect(result.organization?.fundingEvents).toEqual([
      {
        id: "fund-1",
        date: "2024-06-01",
        type: "Series A",
        investors: "Acme VC",
        amount: 5000000,
        currency: "USD",
        newsUrl: "https://example.com/news/1",
      },
    ]);
    expect(result.organization?.retailLocationCount).toBe(3);
    expect(result.organization?.publiclyTradedSymbol).toBeNull();
    expect(result.organization?.publiclyTradedExchange).toBeNull();
    expect(result.organization?.primaryPhone).toBe("+15555550100");
    expect(result.organization?.seoDescription).toBe("Boutique marketing agency.");
    expect(result.organization?.angellistUrl).toBeNull();
    expect(result.organization?.numSuborganizations).toBe(0);
    expect(result.organization?.alexaRanking).toBe(250000);
    expect(result.organization?.keywords).toEqual(["marketing", "branding"]);
  });

  it("currentTitle is null when no current employment row", async () => {
    findFirstLead.mockResolvedValue({ id: "lead-3", ...baseLead });
    findManyContacts.mockResolvedValue([]);
    empWhere.mockResolvedValue([]);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLead("lead-3");
    expect(result.currentTitle).toBeNull();
  });

  it("currentTitle is null when current employment row has no title", async () => {
    findFirstLead.mockResolvedValue({ id: "lead-4", ...baseLead });
    findManyContacts.mockResolvedValue([]);
    empWhere.mockResolvedValue([
      {
        organizationId: "org-x",
        title: null,
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: { ...orgNulls, id: "org-x", name: "X Co" },
      },
    ]);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLead("lead-4");
    expect(result.currentTitle).toBeNull();
    expect(result.organization?.fundingEvents).toEqual([]);
  });

  it("returns organization: null when no current employment row", async () => {
    findFirstLead.mockResolvedValue({ id: "lead-2", ...baseLead });
    findManyContacts.mockResolvedValue([]);
    empWhere.mockResolvedValue([]);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLead("lead-2");

    expect(result.organization).toBeNull();
    expect(result.contacts).toEqual([]);
    expect(result.employmentHistory).toEqual([]);
  });

  it("multiple current=true: enriched older wins over bare newer (agrees with batch path)", async () => {
    findFirstLead.mockResolvedValue({ id: "lead-dup", ...baseLead });
    findManyContacts.mockResolvedValue([]);
    empWhere.mockResolvedValue([
      {
        organizationId: "org-rich",
        title: "Enriched Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: { ...orgNulls, id: "org-rich", name: "Enriched Co", primaryDomain: "enriched.com" },
      },
      {
        organizationId: "org-bare",
        title: "Bare Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-06-01T00:00:00Z"),
        org: { ...orgNulls, id: "org-bare", name: "Bare Co" },
      },
    ]);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLead("lead-dup");
    expect(result.organization?.name).toBe("Enriched Co");
    expect(result.currentTitle).toBe("Enriched Title");
    expect(result.employmentHistory).toHaveLength(2);
  });

  it("throws when leadId is not found", async () => {
    findFirstLead.mockResolvedValue(undefined);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    await expect(buildFullLead("missing-lead-id")).rejects.toThrow(/not found/);
  });
});
