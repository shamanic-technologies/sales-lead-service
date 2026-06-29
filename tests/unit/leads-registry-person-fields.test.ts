import { describe, it, expect, vi, beforeEach } from "vitest";

const insertReturning = vi.fn().mockResolvedValue([{ id: "new-lead-id" }]);
const insertValues = vi.fn(() => ({ returning: insertReturning }));
const findFirstLead = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
    query: {
      leads: { findFirst: (...a: unknown[]) => findFirstLead(...a) },
    },
  },
}));

// Neutral gateway Person carrying a recipient IANA timezone.
const PERSON = {
  firstName: "Sara",
  lastName: "Lee",
  name: "Sara Lee",
  linkedinUrl: null,
  photoUrl: null,
  headline: null,
  city: "Portland",
  state: "ME",
  country: "USA",
  seniority: "founder",
  timezone: "America/New_York",
  email: "sara@cascobay.com",
  emailStatus: "verified",
  provider: "apollo",
  providerPersonId: "person-1",
  organization: null,
};

describe("upsertLeadFromPerson maps the recipient timezone onto the lead", () => {
  beforeEach(() => {
    insertValues.mockClear();
    insertReturning.mockClear();
    findFirstLead.mockClear();
    findFirstLead.mockResolvedValue(undefined);
  });

  it("persists person.timezone onto NewLead.timezone", async () => {
    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");

    const leadId = await upsertLeadFromPerson(PERSON as never, { enriched: true });

    expect(leadId).toBe("new-lead-id");
    expect(insertValues).toHaveBeenCalledOnce();
    const payload = insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.timezone).toBe("America/New_York");
    // sanity: other mapped person fields still flow through unchanged.
    expect(payload.firstName).toBe("Sara");
    expect(payload.city).toBe("Portland");
  });

  it("omits timezone when the person has none (backward-compatible)", async () => {
    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");

    await upsertLeadFromPerson(
      { ...PERSON, timezone: null } as never,
      { enriched: true },
    );

    const payload = insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.timezone).toBeUndefined();
  });
});
