import { describe, expect, it } from "vitest";
import { groupPastEmployers, profileDate, readProfileRoles, type EmploymentRow } from "../../src/lib/client-past-employers.js";
import { clientsToLookUp } from "../../src/lib/client-past-employers-read.js";

const row = (over: Partial<EmploymentRow>): EmploymentRow => ({
  clientLeadId: "a", leadId: "a", organizationId: "o", companyId: null, name: "Acme", domain: null, logoUrl: null,
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
  const c = (leadId: string, email: string | null = "x@y.com") => ({ leadId, name: null, email, linkedinUrl: null, paidAt: null });
  it("skips clients with history, no identity, or a recent lookup; retries an old non-finding one", () => {
    const out = clientsToLookUp(
      [c("has"), c("none", null), c("fresh"), c("recent"), c("old"), c("found")],
      new Set(["has"]),
      new Map([
        ["recent", { status: "no_linkedin" as const, lookedUpAt: "2026-11-01T00:00:00Z" }],
        ["old", { status: "no_experience" as const, lookedUpAt: "2026-07-01T00:00:00Z" }],
        ["found", { status: "history_found" as const, lookedUpAt: "2026-01-01T00:00:00Z" }],
      ]),
      now,
    );
    expect(out.map((x) => x.leadId)).toEqual(["fresh", "old"]);
  });
});
