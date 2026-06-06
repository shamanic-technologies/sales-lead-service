import { describe, it, expect, vi, beforeEach } from "vitest";
import { leads, leadContactMethods, leadsOrganizations } from "../../src/db/schema.js";

const leadsSelect = vi.fn();
const contactsSelect = vi.fn();
const empSelect = vi.fn();

const dbSelect = vi.fn((_selection?: unknown) => ({
  from: (table: unknown) => {
    if (table === leads) {
      return { where: (...a: unknown[]) => leadsSelect(...a) };
    }
    if (table === leadContactMethods) {
      return {
        where: (...a: unknown[]) => ({
          orderBy: () => contactsSelect(...a),
        }),
      };
    }
    if (table === leadsOrganizations) {
      return {
        leftJoin: () => ({
          where: (...a: unknown[]) => empSelect(...a),
        }),
      };
    }
    throw new Error("unexpected table in mock");
  },
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
  },
}));

describe("buildFullLeadsBatch", () => {
  beforeEach(() => {
    leadsSelect.mockReset();
    contactsSelect.mockReset();
    empSelect.mockReset();
    dbSelect.mockClear();
  });

  it("returns empty Map for empty input and makes no DB calls", async () => {
    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch([]);
    expect(result.size).toBe(0);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it("assembles FullLead per leadId from 3 batched queries", async () => {
    const enrichedAt = new Date("2026-01-01T00:00:00Z");
    leadsSelect.mockResolvedValue([
      {
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
        enrichedAt,
      },
      {
        id: "lead-2",
        apolloPersonId: "apollo-2",
        firstName: "Bob",
        lastName: "Marley",
        name: "Bob Marley",
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
      },
    ]);
    contactsSelect.mockResolvedValue([
      { leadId: "lead-1", channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
      { leadId: "lead-1", channel: "phone", value: "+15555555555", status: null, source: "apollo" },
      { leadId: "lead-2", channel: "email", value: "bob@example.com", status: null, source: "apollo" },
    ]);
    empSelect.mockResolvedValue([
      {
        leadId: "lead-1",
        organizationId: "org-1",
        title: "Founder",
        startDate: "2018-01-01",
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: {
          id: "org-1",
          apolloOrganizationId: "apollo-org-1",
          name: "Casco Bay",
          primaryDomain: "cascobay.com",
          websiteUrl: "https://cascobay.com",
          industry: "marketing",
          estimatedNumEmployees: 12,
          annualRevenue: "1000000",
          logoUrl: null,
          shortDescription: null,
          linkedinUrl: null,
          twitterUrl: null,
          facebookUrl: null,
          blogUrl: null,
          crunchbaseUrl: null,
          foundedYear: 2018,
          city: "Portland",
          state: "ME",
          country: "USA",
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
        },
      },
      {
        leadId: "lead-2",
        organizationId: "org-2",
        title: "Singer",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: {
          id: "org-2",
          apolloOrganizationId: null,
          name: "Tuff Gong",
          primaryDomain: "tuffgong.com",
          websiteUrl: null,
          industry: "music",
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
        },
      },
    ]);

    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch(["lead-1", "lead-2"]);

    expect(dbSelect).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(2);

    const sara = result.get("lead-1");
    expect(sara).toBeDefined();
    expect(sara?.leadId).toBe("lead-1");
    expect(sara?.firstName).toBe("Sara");
    expect(sara?.lastName).toBe("Freshley");
    expect(sara?.organization?.name).toBe("Casco Bay");
    expect(sara?.organization?.primaryDomain).toBe("cascobay.com");
    expect(sara?.organization?.industry).toBe("marketing");
    expect(sara?.contacts).toHaveLength(2);
    expect(sara?.contacts[0]).toMatchObject({ channel: "email", value: "sara@cascobay.com" });
    expect(sara?.employmentHistory).toHaveLength(1);
    expect(sara?.employmentHistory[0]).toMatchObject({
      organizationName: "Casco Bay",
      title: "Founder",
      current: true,
    });
    expect(sara?.enrichedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(sara?.currentTitle).toBe("Founder");

    const bob = result.get("lead-2");
    expect(bob?.organization?.name).toBe("Tuff Gong");
    expect(bob?.contacts).toHaveLength(1);
    expect(bob?.currentTitle).toBe("Singer");
  });

  it("currentTitle is null + organization is null when no current employment", async () => {
    leadsSelect.mockResolvedValue([
      {
        id: "lead-x",
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
      },
    ]);
    contactsSelect.mockResolvedValue([]);
    empSelect.mockResolvedValue([]);

    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch(["lead-x"]);
    const lead = result.get("lead-x");
    expect(lead?.organization).toBeNull();
    expect(lead?.currentTitle).toBeNull();
    expect(lead?.contacts).toEqual([]);
    expect(lead?.employmentHistory).toEqual([]);
  });

  const dupLeadRow = {
    id: "lead-dup",
    apolloPersonId: null,
    firstName: "Dup",
    lastName: "Lead",
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
  const orgBase = {
    apolloOrganizationId: null,
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
  };

  it("multiple current=true, no org enriched → most-recent current (createdAt DESC)", async () => {
    leadsSelect.mockResolvedValue([dupLeadRow]);
    contactsSelect.mockResolvedValue([]);
    empSelect.mockResolvedValue([
      {
        leadId: "lead-dup",
        organizationId: "org-late",
        title: "Newer Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-06-01T00:00:00Z"),
        org: { id: "org-late", name: "Newer Co", ...orgBase },
      },
      {
        leadId: "lead-dup",
        organizationId: "org-early",
        title: "Earlier Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: { id: "org-early", name: "Earlier Co", ...orgBase },
      },
    ]);

    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch(["lead-dup"]);
    const lead = result.get("lead-dup");
    expect(lead?.organization?.name).toBe("Newer Co");
    expect(lead?.currentTitle).toBe("Newer Title");
    expect(lead?.employmentHistory).toHaveLength(2);
  });

  it("multiple current=true, older bare + newer enriched → enriched org", async () => {
    leadsSelect.mockResolvedValue([dupLeadRow]);
    contactsSelect.mockResolvedValue([]);
    empSelect.mockResolvedValue([
      {
        leadId: "lead-dup",
        organizationId: "org-bare",
        title: "Bare Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: { id: "org-bare", name: "Bare Co", ...orgBase },
      },
      {
        leadId: "lead-dup",
        organizationId: "org-rich",
        title: "Enriched Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-06-01T00:00:00Z"),
        org: { id: "org-rich", name: "Enriched Co", ...orgBase, logoUrl: "https://logo.dev/enriched.png", primaryDomain: "enriched.com" },
      },
    ]);

    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch(["lead-dup"]);
    const lead = result.get("lead-dup");
    expect(lead?.organization?.name).toBe("Enriched Co");
    expect(lead?.organization?.logoUrl).toBe("https://logo.dev/enriched.png");
    expect(lead?.currentTitle).toBe("Enriched Title");
  });

  it("multiple current=true, older ENRICHED + newer bare → enriched wins over recency", async () => {
    leadsSelect.mockResolvedValue([dupLeadRow]);
    contactsSelect.mockResolvedValue([]);
    empSelect.mockResolvedValue([
      {
        leadId: "lead-dup",
        organizationId: "org-rich",
        title: "Enriched Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-01-01T00:00:00Z"),
        org: { id: "org-rich", name: "Enriched Co", ...orgBase, primaryDomain: "enriched.com" },
      },
      {
        leadId: "lead-dup",
        organizationId: "org-bare",
        title: "Bare Title",
        startDate: null,
        endDate: null,
        current: true,
        description: null,
        empCreatedAt: new Date("2025-06-01T00:00:00Z"),
        org: { id: "org-bare", name: "Bare Co", ...orgBase },
      },
    ]);

    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch(["lead-dup"]);
    const lead = result.get("lead-dup");
    expect(lead?.organization?.name).toBe("Enriched Co");
    expect(lead?.currentTitle).toBe("Enriched Title");
  });

  it("requested leadId missing from leads table is omitted from result Map", async () => {
    leadsSelect.mockResolvedValue([]);
    contactsSelect.mockResolvedValue([]);
    empSelect.mockResolvedValue([]);

    const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLeadsBatch(["missing-lead"]);
    expect(result.size).toBe(0);
    expect(result.has("missing-lead")).toBe(false);
  });
});
