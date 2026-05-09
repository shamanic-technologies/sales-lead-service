import { describe, it, expect, vi, beforeEach } from "vitest";

const findFirstLead = vi.fn();
const findFirstLeadOrg = vi.fn();
const findFirstOrg = vi.fn();
const findManyContacts = vi.fn();

const empWhere = vi.fn();
const empLeftJoin = vi.fn(() => ({ where: empWhere }));
const empFrom = vi.fn(() => ({ leftJoin: empLeftJoin }));
const dbSelect = vi.fn(() => ({ from: empFrom }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      leads: { findFirst: (...a: unknown[]) => findFirstLead(...a) },
      leadsOrganizations: { findFirst: (...a: unknown[]) => findFirstLeadOrg(...a) },
      organizations: { findFirst: (...a: unknown[]) => findFirstOrg(...a) },
      leadContactMethods: { findMany: (...a: unknown[]) => findManyContacts(...a) },
    },
    select: (...a: unknown[]) => dbSelect(...a),
  },
}));

describe("buildFullLead", () => {
  beforeEach(() => {
    findFirstLead.mockReset();
    findFirstLeadOrg.mockReset();
    findFirstOrg.mockReset();
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
    findFirstLeadOrg.mockResolvedValue({ organizationId: "org-1", title: "Founder" });
    findFirstOrg.mockResolvedValue({
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
    });
    findManyContacts.mockResolvedValue([
      { channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
      { channel: "phone", value: "+15555555555", status: null, source: "apollo" },
    ]);
    empWhere.mockResolvedValue([
      {
        organizationId: "org-1",
        organizationName: "Casco Bay",
        title: "Founder",
        startDate: "2018-01-01",
        endDate: null,
        current: true,
        description: null,
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
  });

  it("returns organization: null when no current employment row", async () => {
    findFirstLead.mockResolvedValue({
      id: "lead-2",
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
    });
    findFirstLeadOrg.mockResolvedValue(undefined);
    findManyContacts.mockResolvedValue([]);
    empWhere.mockResolvedValue([]);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    const result = await buildFullLead("lead-2");

    expect(result.organization).toBeNull();
    expect(result.contacts).toEqual([]);
    expect(result.employmentHistory).toEqual([]);
  });

  it("throws when leadId is not found", async () => {
    findFirstLead.mockResolvedValue(undefined);

    const { buildFullLead } = await import("../../src/lib/lead-shape.js");
    await expect(buildFullLead("missing-lead-id")).rejects.toThrow(/not found/);
  });
});
