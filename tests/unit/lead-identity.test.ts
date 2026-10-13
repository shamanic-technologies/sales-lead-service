import { describe, expect, it } from "vitest";
import { companyFactsOf, companyInputOf, hasAnyKey, humanKeysOf, type OrganizationRow } from "../../src/lib/lead-identity.js";

describe("humanKeysOf: the keys a lead states to human-service as ONE contact", () => {
  it("sends every registered email, E.164 phones only, a profile URL and the provider id under its provider", () => {
    const k = humanKeysOf({
      lead_id: "l1",
      apollo_person_id: "5f2a3b4c5d6e7f8a9b0c1d2e",
      provider: "apify",
      linkedin_url: "https://www.linkedin.com/in/americo-vargas",
      emails: ["a@befco.com", "A@befco.com", "nope"],
      phones: ["+33612345678", "06 12 34 56 78"],
    });
    expect(k.emails).toEqual(["a@befco.com"]);
    expect(k.phones).toEqual(["+33612345678"]);
    expect(k.linkedinUrls).toEqual(["https://www.linkedin.com/in/americo-vargas"]);
    expect(k.providerPersonIds).toEqual([{ provider: "apify", id: "5f2a3b4c5d6e7f8a9b0c1d2e" }]);
  });

  it("reads a provider id with no recorded provider as Apollo's (pre-gateway rows), never a crm id", () => {
    expect(humanKeysOf({ lead_id: "l", apollo_person_id: "x1", provider: null, linkedin_url: null, emails: null, phones: null }).providerPersonIds)
      .toEqual([{ provider: "apollo", id: "x1" }]);
    expect(humanKeysOf({ lead_id: "l", apollo_person_id: "x1", provider: "crm", linkedin_url: null, emails: null, phones: null }).providerPersonIds)
      .toEqual([]);
  });

  it("drops a company page as a person's LinkedIn and says when nothing is left", () => {
    const k = humanKeysOf({ lead_id: "l", apollo_person_id: null, provider: null, linkedin_url: "https://linkedin.com/company/befco", emails: [], phones: [] });
    expect(k.linkedinUrls).toEqual([]);
    expect(hasAnyKey(k)).toBe(false);
  });
});

const org = (over: Partial<OrganizationRow> = {}): OrganizationRow =>
  ({
    id: "o1",
    name: " BeFCO ",
    primary_domain: null,
    website_url: "https://befco.com",
    linkedin_url: null,
    apollo_organization_id: "ap1",
    short_description: "",
    seo_description: null,
    logo_url: null,
    twitter_url: null,
    facebook_url: null,
    blog_url: null,
    crunchbase_url: null,
    angellist_url: null,
    industry: "construction",
    industries: [],
    secondary_industries: null,
    keywords: ["a", " ", "b"],
    technology_names: null,
    founded_year: 1990,
    estimated_num_employees: 12,
    annual_revenue: "1500000.5",
    latest_funding_stage: null,
    latest_funding_round_date: new Date("2024-03-01T00:00:00Z"),
    total_funding: "abc",
    total_funding_printed: null,
    funding_events: [{ a: 1 }, "bad"],
    retail_location_count: null,
    num_suborganizations: null,
    alexa_ranking: null,
    publicly_traded_symbol: null,
    publicly_traded_exchange: null,
    primary_phone: null,
    street_address: null,
    city: "Lisbon",
    state: null,
    postal_code: null,
    country: "Portugal",
    updated_at: new Date(),
    ...over,
  }) as OrganizationRow;

describe("companyInputOf / companyFactsOf: the employer row for brand-service", () => {
  it("states the domain (website when no primary domain), the Apollo org id and the name, keyed by the row id", () => {
    expect(companyInputOf(org())).toEqual({
      ref: "o1",
      domain: "https://befco.com",
      linkedinUrl: null,
      apolloOrganizationId: "ap1",
      name: "BeFCO",
    });
  });

  it("writes only keys with a value of the type brand-service accepts (a refused value refuses the batch)", () => {
    expect(companyFactsOf(org())).toEqual({
      name: "BeFCO",
      websiteUrl: "https://befco.com",
      industry: "construction",
      keywords: ["a", "b"],
      foundedYear: 1990,
      employeeCount: 12,
      annualRevenueUsd: 1500000.5,
      latestFundingRoundDate: "2024-03-01",
      city: "Lisbon",
      country: "Portugal",
    });
  });
});
