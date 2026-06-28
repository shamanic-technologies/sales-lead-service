import { beforeEach, describe, expect, it, vi } from "vitest";

let rawRows: Array<Record<string, unknown>> = [];

const sqlMock = vi.fn((strings: TemplateStringsArray) => {
  if (String(strings[0]).includes("SELECT")) {
    return Promise.resolve(rawRows);
  }
  return { fragment: strings.join("") };
});

vi.mock("../../src/db/index.js", () => ({
  sql: sqlMock,
}));

function rawRow(servedAt: unknown) {
  return {
    id: "lc-1",
    lead_id: "lead-1",
    campaign_id: "campaign-1",
    org_id: "org-1",
    user_id: null,
    brand_ids: ["brand-1"],
    status: "served",
    status_reason: null,
    status_details: null,
    parent_run_id: null,
    run_id: null,
    served_at: servedAt,
    workflow_slug: null,
    feature_slug: null,
    goal: null,
    active_goal_id: null,
    brand_profile_id: null,
    audience_id: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    l_id: "lead-1",
    apollo_person_id: "apollo-1",
    first_name: "Jane",
    last_name: "Doe",
    name: "Jane Doe",
    headline: "CEO",
    linkedin_url: null,
    photo_url: null,
    seniority: "founder",
    departments: ["c_suite"],
    functions: ["entrepreneurship"],
    l_city: "Portland",
    l_state: "ME",
    l_country: "USA",
    org_id_inner: "org-inner-1",
    org_name: "Acme",
    logo_url: null,
    primary_domain: "acme.com",
    website_url: "https://acme.com",
    industry: "marketing",
    industries: ["marketing", "advertising"],
    estimated_num_employees: 12,
    annual_revenue: "1000000",
    founded_year: 2018,
    short_description: "Boutique agency.",
    org_city: "Portland",
    org_state: "ME",
    org_country: "USA",
    email_value: "jane@example.com",
    email_status: "valid",
  };
}

describe("fetchBasicLeadRows", () => {
  beforeEach(() => {
    rawRows = [];
    sqlMock.mockClear();
  });

  it("normalizes postgres timestamp strings for servedAt", async () => {
    rawRows = [rawRow("2026-06-17 01:44:59.123456+00")];
    const { fetchBasicLeadChunk } = await import("../../src/lib/basic-leads.js");

    const rows = await fetchBasicLeadChunk({ orgId: "org-1", brandId: "brand-1" }, null, 500);

    expect(rows[0].servedAt).toBe("2026-06-17T01:44:59.123Z");
    expect(rows[0].audienceId).toBeNull();
  });

  it("keeps Date timestamps compatible with the full path", async () => {
    rawRows = [rawRow(new Date("2026-06-17T01:44:59.000Z"))];
    const { fetchBasicLeadChunk } = await import("../../src/lib/basic-leads.js");

    const rows = await fetchBasicLeadChunk({ orgId: "org-1" }, null, 500);

    expect(rows[0].servedAt).toBe("2026-06-17T01:44:59.000Z");
  });

  it("projects the additive firmographic fields (#327) on the slim lead + org", async () => {
    rawRows = [rawRow(new Date("2026-06-17T01:44:59.000Z"))];
    const { fetchBasicLeadChunk } = await import("../../src/lib/basic-leads.js");

    const rows = await fetchBasicLeadChunk({ orgId: "org-1", brandId: "brand-1" }, null, 500);
    const lead = rows[0].lead!;

    // Person-level firmographics, same names/types as FullLead.
    expect(lead.seniority).toBe("founder");
    expect(lead.departments).toEqual(["c_suite"]);
    expect(lead.functions).toEqual(["entrepreneurship"]);
    expect(lead.city).toBe("Portland");
    expect(lead.state).toBe("ME");
    expect(lead.country).toBe("USA");

    // Org-level firmographics, same names/types as OrganizationView.
    const org = lead.organization!;
    expect(org.industry).toBe("marketing");
    expect(org.industries).toEqual(["marketing", "advertising"]);
    expect(org.estimatedNumEmployees).toBe(12);
    expect(org.annualRevenue).toBe("1000000");
    expect(org.foundedYear).toBe(2018);
    expect(org.shortDescription).toBe("Boutique agency.");
    expect(org.city).toBe("Portland");
    expect(org.state).toBe("ME");
    expect(org.country).toBe("USA");

    // Basic stays lean — the heavy fields are NOT projected into basic.
    expect(lead).not.toHaveProperty("subdepartments");
    expect(lead).not.toHaveProperty("employmentHistory");
    expect(org).not.toHaveProperty("technologyNames");
    expect(org).not.toHaveProperty("secondaryIndustries");
    expect(org).not.toHaveProperty("fundingEvents");
  });
});
