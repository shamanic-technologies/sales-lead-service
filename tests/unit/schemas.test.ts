import { describe, it, expect } from "vitest";
import {
  BufferNextRequestSchema,
  FullLeadSchema,
  BufferNextResponseSchema,
} from "../../src/schemas.js";

describe("BufferNextRequestSchema", () => {
  it("accepts empty body", () => {
    expect(BufferNextRequestSchema.safeParse({}).success).toBe(true);
  });

  it("strips unknown fields silently", () => {
    expect(
      BufferNextRequestSchema.safeParse({ sourceType: "apollo" }).success,
    ).toBe(true);
  });
});

const LEAD_UUID = "11111111-2222-4333-8444-555555555555";
const ORG_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const minimalLead = {
  leadId: LEAD_UUID,
  apolloPersonId: null,
  firstName: "Sara",
  lastName: "Freshley",
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
  currentTitle: null,
  organization: null,
  contacts: [],
  employmentHistory: [],
};

describe("FullLeadSchema", () => {
  it("accepts a minimal lead with all-null nullable fields", () => {
    expect(FullLeadSchema.safeParse(minimalLead).success).toBe(true);
  });

  it("accepts a lead with full nested organization view including 14 new fields", () => {
    const orgInput = {
      id: ORG_UUID,
      apolloOrganizationId: "apollo-org-1",
      name: "Casco Bay",
      primaryDomain: "cascobay.com",
      websiteUrl: "https://cascobay.com",
      industry: "marketing",
      estimatedNumEmployees: 12,
      annualRevenue: "1000000",
      logoUrl: null,
      shortDescription: "boutique",
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
      technologyNames: ["GA4"],
      industries: ["marketing"],
      secondaryIndustries: null,
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
          newsUrl: "https://example.com/news/1",
        },
      ],
      retailLocationCount: 3,
      publiclyTradedSymbol: null,
      publiclyTradedExchange: null,
      primaryPhone: "+15555550100",
      seoDescription: "Casco Bay - Boutique marketing.",
      angellistUrl: null,
      numSuborganizations: 0,
      alexaRanking: 250000,
      keywords: ["marketing", "branding"],
    };
    const result = FullLeadSchema.safeParse({
      ...minimalLead,
      organization: orgInput,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const org = result.data.organization as Record<string, unknown>;
      expect(org.latestFundingStage).toBe("series_a");
      expect(org.latestFundingRoundDate).toBe("2024-06-01");
      expect(org.totalFunding).toBe("5000000");
      expect(org.totalFundingPrinted).toBe("$5M");
      expect(org.fundingEvents).toEqual(orgInput.fundingEvents);
      expect(org.retailLocationCount).toBe(3);
      expect(org.publiclyTradedSymbol).toBeNull();
      expect(org.publiclyTradedExchange).toBeNull();
      expect(org.primaryPhone).toBe("+15555550100");
      expect(org.seoDescription).toBe("Casco Bay - Boutique marketing.");
      expect(org.angellistUrl).toBeNull();
      expect(org.numSuborganizations).toBe(0);
      expect(org.alexaRanking).toBe(250000);
      expect(org.keywords).toEqual(["marketing", "branding"]);
    }
  });

  it("accepts currentTitle as string and as null", () => {
    expect(
      FullLeadSchema.safeParse({ ...minimalLead, currentTitle: "Founder" }).success,
    ).toBe(true);
    expect(
      FullLeadSchema.safeParse({ ...minimalLead, currentTitle: null }).success,
    ).toBe(true);
  });

  it("requires currentTitle field (use null for unknown)", () => {
    const without = { ...minimalLead };
    delete (without as Record<string, unknown>).currentTitle;
    expect(FullLeadSchema.safeParse(without).success).toBe(false);
  });

  it("accepts an organization with empty fundingEvents array", () => {
    const result = FullLeadSchema.safeParse({
      ...minimalLead,
      organization: {
        id: ORG_UUID,
        apolloOrganizationId: null,
        name: "X",
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
        fundingEvents: [],
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
    });
    expect(result.success).toBe(true);
  });

  it("accepts a lead with contact methods and employment history", () => {
    const result = FullLeadSchema.safeParse({
      ...minimalLead,
      contacts: [
        { channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
        { channel: "phone", value: "+15555555555", status: null, source: "apollo" },
      ],
      employmentHistory: [
        {
          organizationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          organizationName: "Casco Bay",
          title: "Founder",
          startDate: "2018-01-01",
          endDate: null,
          current: true,
          description: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires leadId", () => {
    const without = { ...minimalLead };
    delete (without as Record<string, unknown>).leadId;
    expect(FullLeadSchema.safeParse(without).success).toBe(false);
  });

  it("requires firstName", () => {
    expect(
      FullLeadSchema.safeParse({ ...minimalLead, firstName: undefined }).success,
    ).toBe(false);
  });

  it("requires lastName", () => {
    expect(
      FullLeadSchema.safeParse({ ...minimalLead, lastName: undefined }).success,
    ).toBe(false);
  });

  it("requires contacts array", () => {
    const without = { ...minimalLead };
    delete (without as Record<string, unknown>).contacts;
    expect(FullLeadSchema.safeParse(without).success).toBe(false);
  });

  it("requires employmentHistory array", () => {
    const without = { ...minimalLead };
    delete (without as Record<string, unknown>).employmentHistory;
    expect(FullLeadSchema.safeParse(without).success).toBe(false);
  });

  it("strips legacy raw/metadata fields if passed in (no longer part of contract)", () => {
    const result = FullLeadSchema.safeParse({
      ...minimalLead,
      metadata: { foo: "bar" },
      raw: { first_name: "Sara" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.metadata).toBeUndefined();
      expect(data.raw).toBeUndefined();
    }
  });
});

describe("BufferNextResponseSchema", () => {
  it("accepts found:true with FullLead", () => {
    const result = BufferNextResponseSchema.safeParse({
      found: true,
      lead: {
        leadId: LEAD_UUID,
        email: "sara@cascobay.com",
        data: minimalLead,
        brandIds: ["brand-1"],
        orgId: "org-1",
        userId: "user-1",
        apolloPersonId: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts found:false without lead", () => {
    expect(BufferNextResponseSchema.safeParse({ found: false }).success).toBe(true);
  });
});
