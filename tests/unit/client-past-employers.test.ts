import { describe, expect, it } from "vitest";
import { groupPastEmployers, profileDate, readProfileRoles, type EmploymentRow } from "../../src/lib/client-past-employers.js";
import { DEEP_PROFILE_VERSION, LOOKUP_VERSION, clientsToLookUp } from "../../src/lib/client-past-employers-read.js";
import { companyKeyOf, companyPageOf, companyPageOfId } from "../../src/lib/client-past-employers.js";

const row = (over: Partial<EmploymentRow>): EmploymentRow => ({
  clientLeadId: "a", role: "paying_client", leadId: "a", organizationId: "o", companyId: null, name: "Acme", domain: null, logoUrl: null,
  linkedinUrl: null, title: null, startDate: null, endDate: null, current: false, ...over,
});

describe("groupPastEmployers", () => {
  it("keys on company id, then domain, then name; counts each client once; most clients first, then name", () => {
    const out = groupPastEmployers([
      row({ clientLeadId: "a", name: "Acme" }),
      row({ clientLeadId: "a", name: "ACME ", title: "CTO", startDate: "2020-01-01" }),
      row({ clientLeadId: "b", name: "acme", current: true }),
      row({ clientLeadId: "c", name: "Zeta Inc", domain: "www.zeta.io" }),
      row({ clientLeadId: "d", name: "Zeta", domain: "zeta.io" }),
      row({ clientLeadId: "e", name: "Other", companyId: "c1" }),
      row({ clientLeadId: "f", name: "Other renamed", companyId: "c1" }),
      row({ clientLeadId: "g", name: null, domain: null }),
    ]);
    expect(out.map((c) => [c.companyKey, c.clientCount])).toEqual([
      ["name:acme", 2],
      ["company:c1", 2],
      ["domain:zeta.io", 2],
    ]);
    const acme = out.find((c) => c.companyKey === "name:acme")!;
    expect(acme.currentForSome).toBe(true);
    expect(acme.clients.find((c) => c.leadId === "a")!.title).toBe("CTO");
  });
});

describe("profileDate", () => {
  it.each([
    ["2010", "2010-01-01"],
    ["Jan 2021", "2021-01-01"],
    ["September 2019", "2019-09-01"],
    ["2018-04", "2018-04-01"],
    ["2018-04-12", "2018-04-12"],
    [{ year: 2015, month: 7 }, "2015-07-01"],
    ["Present", null],
    ["", null],
  ])("%j -> %s", (input, expected) => expect(profileDate(input)).toBe(expected));
});

describe("readProfileRoles", () => {
  it("reads a raw experience list (snake_case shape)", () => {
    const roles = readProfileRoles({
      output: { full_name: "P" },
      raw: { experience: [
        { title: "CEO", start_date: "2010", end_date: "Present", company: "Stripe", url: "https://www.linkedin.com/company/stripe" },
        { title: "Cofounder", start_date: "2007", end_date: "2008", company: "Auctomatic" },
        { title: "No company" },
        { title: "Founder", company: "https://www.linkedin.com/redir/suspicious-page?url=distribute%2eyou" },
      ] },
    });
    expect(roles).toEqual([
      { organizationName: "Stripe", title: "CEO", startDate: "2010-01-01", endDate: null, current: true, companyLinkedinUrl: "https://www.linkedin.com/company/stripe" },
      { organizationName: "Auctomatic", title: "Cofounder", startDate: "2007-01-01", endDate: "2008-01-01", current: false, companyLinkedinUrl: null },
    ]);
  });

  it("reads a nested output.data experience list (camelCase shape)", () => {
    const roles = readProfileRoles({ output: { found: true, data: { experience: [
      { companyName: "Arc Institute", position: "Cofounder", startDate: "Jan 2021", endDate: "Present", companyLinkedinUrl: "https://x/arc" },
    ] } } });
    expect(roles[0]).toMatchObject({ organizationName: "Arc Institute", title: "Cofounder", startDate: "2021-01-01", current: true });
  });

  it("answers nothing for a profile with no experience", () => {
    expect(readProfileRoles({ output: { full_name: "x" }, raw: { name: "x" } })).toEqual([]);
    expect(readProfileRoles(null)).toEqual([]);
  });
});

describe("clientsToLookUp", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const c = (leadId: string, email: string | null = "x@y.com") => ({ leadId, memberLeadIds: [leadId], name: null, email, phone: null, linkedinUrl: null, paidAt: null });
  it("skips clients with history or a recent lookup; retries an old non-finding one; a never-attempted one is attempted", () => {
    const out = clientsToLookUp(
      [c("has"), c("none", null), c("fresh"), c("recent"), c("old"), c("found")],
      new Set(["has"]),
      new Map([
        ["recent", { status: "no_linkedin" as const, lookedUpAt: "2026-11-01T00:00:00Z", version: LOOKUP_VERSION }],
        ["old", { status: "no_experience" as const, lookedUpAt: "2026-07-01T00:00:00Z", version: LOOKUP_VERSION }],
        ["found", { status: "history_found" as const, lookedUpAt: "2026-01-01T00:00:00Z", version: LOOKUP_VERSION }],
      ]),
      now,
    );
    // « none » has nothing to look them up by: attempted anyway, the lookup records `no_identifier` (nothing spent).
    expect(out.map((x) => x.leadId)).toEqual(["none", "fresh", "old"]);
  });

  it("a `no_identifier` is asked again only once an identifier appears", () => {
    const stored = new Map([
      ["still", { status: "no_identifier" as const, lookedUpAt: "2026-11-20T00:00:00Z", version: LOOKUP_VERSION }],
      ["phone", { status: "no_identifier" as const, lookedUpAt: "2026-11-20T00:00:00Z", version: LOOKUP_VERSION }],
    ]);
    const out = clientsToLookUp([c("still", null), { ...c("phone", null), phone: "+16475550100" }], new Set(), stored, now);
    expect(out.map((x) => x.leadId)).toEqual(["phone"]);
  });

  it("a profile recorded career-less before the deep round is asked once more; after it, not before the retry window", () => {
    const li = "https://www.linkedin.com/in/imahboob";
    const out = clientsToLookUp(
      [{ ...c("before"), linkedinUrl: li }, { ...c("unreadable"), linkedinUrl: li }, { ...c("after"), linkedinUrl: li }, c("no-profile")],
      new Set(),
      new Map([
        ["before", { status: "no_experience" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: DEEP_PROFILE_VERSION - 1 }],
        ["unreadable", { status: "profile_unreadable" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: DEEP_PROFILE_VERSION - 1 }],
        ["after", { status: "no_experience" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: DEEP_PROFILE_VERSION }],
        ["no-profile", { status: "no_linkedin" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: DEEP_PROFILE_VERSION - 1 }],
      ]),
      now,
    );
    expect(out.map((x) => x.leadId)).toEqual(["before", "unreadable"]);
  });
});

describe("clientsToLookUp, lookup version", () => {
  const now = new Date("2026-11-21T00:00:00Z");
  const c = (leadId: string, linkedinUrl: string | null) => ({ leadId, memberLeadIds: [leadId], name: null, email: null, phone: null, linkedinUrl, paidAt: null });
  it("a career an older version found is read again once, even with history; the current version is not", () => {
    const out = clientsToLookUp(
      [c("old-found", "https://www.linkedin.com/in/a"), c("new-found", "https://www.linkedin.com/in/b"), c("old-miss", null)],
      new Set(["old-found", "new-found"]),
      new Map([
        ["old-found", { status: "history_found" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: 1 }],
        ["new-found", { status: "history_found" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: LOOKUP_VERSION }],
        ["old-miss", { status: "no_linkedin" as const, lookedUpAt: "2026-11-21T00:00:00Z", version: 1 }],
      ]),
      now,
    );
    expect(out.map((x) => x.leadId)).toEqual(["old-found"]);
  });
});

describe("companyPageOf", () => {
  it("one spelling for a company page; anything else is no page", () => {
    expect(companyPageOf("https://www.linkedin.com/company/SmarterClicks/")).toBe("https://www.linkedin.com/company/smarterclicks/");
    expect(companyPageOf("http://fr.linkedin.com/company/google?trk=x")).toBe("https://www.linkedin.com/company/google/");
    expect(companyPageOf("linkedin.com/school/essec-business-school")).toBe("https://www.linkedin.com/school/essec-business-school/");
    expect(companyPageOf("https://www.linkedin.com/in/someone/")).toBeNull();
    expect(companyPageOf("https://www.linkedin.com/redir/suspicious-page?url=x")).toBeNull();
    expect(companyPageOf(null)).toBeNull();
  });

  it("a company is keyed on its page before its name", () => {
    expect(companyKeyOf({ companyId: null, domain: null, name: "Arketi Group", linkedinUrl: "https://linkedin.com/company/arketi" }))
      .toBe("linkedin:https://www.linkedin.com/company/arketi/");
    expect(companyKeyOf({ companyId: null, domain: "arketi.com", name: "Arketi", linkedinUrl: "https://linkedin.com/company/arketi" })).toBe("domain:arketi.com");
  });

  it("a role's link fields: the company page wins over another link", () => {
    const [role] = readProfileRoles({ experience: [{ company: { name: "Google", url: "https://www.linkedin.com/company/google/" }, url: "https://www.linkedin.com/in/x/details/position/1" }] });
    expect(role.companyLinkedinUrl).toBe("https://www.linkedin.com/company/google/");
  });
});

describe("company page from a LinkedIn company id", () => {
  it("a positive numeric id names its page; a placeholder (negative/zero) names none; a stated page still wins", () => {
    expect(companyPageOfId(2217)).toBe("https://www.linkedin.com/company/2217/");
    expect(companyPageOfId("3505228")).toBe("https://www.linkedin.com/company/3505228/");
    expect(companyPageOfId("-12160977")).toBeNull();
    expect(companyPageOfId(0)).toBeNull();
    expect(companyPageOfId(null)).toBeNull();
  });

  it("reads a fiber-ai shaped profile (raw.output.profile.experiences, ISO dates, is_current, linkedin_company_id)", () => {
    const roles = readProfileRoles({
      output: { full_name: "M I" },
      raw: { output: { found: true, profile: { experiences: [
        { company_name: "Accuzar", title: "Technology Officer", start_date: "2023-10-01T00:00:00.000Z", end_date: null, is_current: true, linkedin_company_id: "-12160977" },
        { company_name: "Halliburton", title: null, start_date: "2020-09-01T00:00:00.000Z", end_date: "2021-10-31T00:00:00.000Z", is_current: false, linkedin_company_id: "2217" },
      ] } } },
    });
    expect(roles).toEqual([
      { organizationName: "Accuzar", title: "Technology Officer", startDate: "2023-10-01", endDate: null, current: true, companyLinkedinUrl: null },
      { organizationName: "Halliburton", title: null, startDate: "2020-09-01", endDate: "2021-10-31", current: false, companyLinkedinUrl: "https://www.linkedin.com/company/2217/" },
    ]);
  });
});
