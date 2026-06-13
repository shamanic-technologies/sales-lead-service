import { describe, it, expect, vi, beforeEach } from "vitest";

const insertReturning = vi.fn().mockResolvedValue([{ id: "new-org-id" }]);
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const findFirstOrg = vi.fn().mockResolvedValue(undefined);
const updateWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
    update: () => ({ set: (...a: unknown[]) => updateSet(...a) }),
    query: {
      organizations: { findFirst: (...a: unknown[]) => findFirstOrg(...a) },
    },
  },
}));

// A neutral gateway Person carrying a fully-populated organization.
const PERSON_WITH_ORG = {
  providerPersonId: "person-1",
  organization: {
    name: "Casco Bay",
    domain: "cascobay.com",
    websiteUrl: "https://cascobay.com",
    industry: "marketing",
    estimatedNumEmployees: 12,
    linkedinUrl: "https://linkedin.com/company/cascobay",
    logoUrl: "https://logo.com/x.png",
    city: "Portland",
    state: "ME",
    country: "USA",
  },
};

describe("pickOrgFields (via upsertOrganizationFromPerson) maps the neutral organization", () => {
  beforeEach(() => {
    insertValues.mockClear();
    insertReturning.mockClear();
    findFirstOrg.mockClear();
    findFirstOrg.mockResolvedValue(undefined);
  });

  it("maps all neutral organization fields onto NewOrganization", async () => {
    const { upsertOrganizationFromPerson } = await import("../../src/lib/leads-registry.js");

    await upsertOrganizationFromPerson(PERSON_WITH_ORG as never);

    expect(insertValues).toHaveBeenCalledOnce();
    const payload = insertValues.mock.calls[0][0] as Record<string, unknown>;

    expect(payload.name).toBe("Casco Bay");
    expect(payload.primaryDomain).toBe("cascobay.com");
    expect(payload.websiteUrl).toBe("https://cascobay.com");
    expect(payload.industry).toBe("marketing");
    expect(payload.estimatedNumEmployees).toBe(12);
    expect(payload.linkedinUrl).toBe("https://linkedin.com/company/cascobay");
    expect(payload.logoUrl).toBe("https://logo.com/x.png");
    expect(payload.city).toBe("Portland");
    expect(payload.state).toBe("ME");
    expect(payload.country).toBe("USA");
  });

  it("omits columns when the neutral org fields are absent", async () => {
    const { upsertOrganizationFromPerson } = await import("../../src/lib/leads-registry.js");

    await upsertOrganizationFromPerson({
      providerPersonId: "person-2",
      organization: { name: "Minimal Co", domain: null, websiteUrl: null, industry: null },
    } as never);

    expect(insertValues).toHaveBeenCalledOnce();
    const payload = insertValues.mock.calls[0][0] as Record<string, unknown>;

    expect(payload.name).toBe("Minimal Co");
    expect(payload.primaryDomain).toBeUndefined();
    expect(payload.websiteUrl).toBeUndefined();
    expect(payload.industry).toBeUndefined();
    expect(payload.estimatedNumEmployees).toBeUndefined();
  });

  it("returns null when the person has no organization", async () => {
    const { upsertOrganizationFromPerson } = await import("../../src/lib/leads-registry.js");

    const result = await upsertOrganizationFromPerson({
      providerPersonId: "person-3",
      organization: null,
    } as never);

    expect(result).toBeNull();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
