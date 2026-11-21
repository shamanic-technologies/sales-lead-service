import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import { completeServedCompanyName, type CompanyNameDeps } from "../../src/lib/company-name-fill.js";

function lead(name: string | null, domain: string | null = "bruggen-apotheke.ch") {
  return {
    leadId: "e8d7dd5e-3f8f-44c2-969c-de3b62624309",
    organization: { id: "fb5096d1-8256-41c5-ae51-c06acd5602b9", name, primaryDomain: domain } as never,
    employmentHistory: [{ organizationId: "fb5096d1-8256-41c5-ae51-c06acd5602b9", organizationName: name, title: null, startDate: null, endDate: null, current: true, description: null }],
  };
}

function deps(over: Partial<CompanyNameDeps> = {}): CompanyNameDeps & { writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    getCompanies: vi.fn(async (ids: string[]) => ids.map((brandId) => ({ brandId, domain: "bruggen-apotheke.ch", name: "Bruggen Apotheke", facts: {} }))),
    resolveCompanies: vi.fn(async () => [{ index: 0, ref: null, brandId: "b11d79c9-98c1-486a-a347-84704ab2e001", domain: "bruggen-apotheke.ch", matchedBy: "domain" as const, created: false, unresolvedReason: null }]),
    readCompanyIds: vi.fn(async () => ({ orgCompanyId: null, leadCompanyId: "b11d79c9-98c1-486a-a347-84704ab2e001" })),
    writeName: vi.fn(async (id: string, name: string) => { writes.push([id, name]); }),
    ...over,
  };
}

describe("completeServedCompanyName (COLD-NO-COMPANY-1121)", () => {
  it("fills a nameless employer from brand-service, persists it, and serves it", async () => {
    const l = lead(null);
    const d = deps();
    expect(await completeServedCompanyName(l, d)).toBe("Bruggen Apotheke");
    expect((l.organization as { name: string }).name).toBe("Bruggen Apotheke");
    expect(l.employmentHistory[0].organizationName).toBe("Bruggen Apotheke");
    expect(d.writes).toEqual([["fb5096d1-8256-41c5-ae51-c06acd5602b9", "Bruggen Apotheke"]]);
    expect(d.getCompanies).toHaveBeenCalledWith(["b11d79c9-98c1-486a-a347-84704ab2e001"]);
  });

  it("asks nothing when the employer already has a name", async () => {
    const d = deps();
    expect(await completeServedCompanyName(lead("Vitalis Apotheke"), d)).toBeNull();
    expect(d.readCompanyIds).not.toHaveBeenCalled();
    expect(d.getCompanies).not.toHaveBeenCalled();
  });

  it("treats a blank name as missing", async () => {
    const d = deps();
    expect(await completeServedCompanyName(lead("  "), d)).toBe("Bruggen Apotheke");
  });

  it("prefers the employer row's own company over the lead's", async () => {
    const d = deps({ readCompanyIds: vi.fn(async () => ({ orgCompanyId: "org-co", leadCompanyId: "lead-co" })) });
    await completeServedCompanyName(lead(null), d);
    expect(d.getCompanies).toHaveBeenCalledWith(["org-co"]);
  });

  it("resolves the domain at brand-service when no company id is known yet", async () => {
    const d = deps({ readCompanyIds: vi.fn(async () => ({ orgCompanyId: null, leadCompanyId: null })) });
    expect(await completeServedCompanyName(lead(null), d)).toBe("Bruggen Apotheke");
    expect(d.resolveCompanies).toHaveBeenCalledWith([{ domain: "bruggen-apotheke.ch" }]);
  });

  it("never invents a name: brand-service nameless leaves it null, nothing written", async () => {
    const l = lead(null);
    const d = deps({ getCompanies: vi.fn(async () => [{ brandId: "x", domain: "bruggen-apotheke.ch", name: null, facts: {} }]) });
    expect(await completeServedCompanyName(l, d)).toBeNull();
    expect((l.organization as { name: string | null }).name).toBeNull();
    expect(d.writes).toEqual([]);
  });

  it("brand-service down never fails the serve", async () => {
    const l = lead(null);
    const d = deps({ getCompanies: vi.fn(async () => { throw new Error("502"); }) });
    expect(await completeServedCompanyName(l, d)).toBeNull();
    expect((l.organization as { name: string | null }).name).toBeNull();
  });

  it("no organization = nothing to do", async () => {
    const d = deps();
    expect(await completeServedCompanyName({ leadId: "x", organization: null, employmentHistory: [] }, d)).toBeNull();
    expect(d.readCompanyIds).not.toHaveBeenCalled();
  });
});
