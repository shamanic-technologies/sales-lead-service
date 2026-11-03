import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Identity resolution: a person is ONE identity, keyed on the email that is
 * already registered. `idx_lcm_channel_value` makes "one email = one lead" a
 * hard invariant, so attributing a serve to any lead other than the email's
 * owner produces a lead whose delivery status can never resolve.
 */

const insertReturning = vi.fn();
const contactOnConflict = vi.fn();
const insertValues = vi.fn(() => ({
  returning: insertReturning,
  onConflictDoUpdate: contactOnConflict,
}));
const updateWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
const findFirstLead = vi.fn();
const findFirstContact = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
    update: () => ({ set: (...a: unknown[]) => updateSet(...a) }),
    query: {
      leads: { findFirst: (...a: unknown[]) => findFirstLead(...a) },
      leadContactMethods: { findFirst: (...a: unknown[]) => findFirstContact(...a) },
    },
  },
}));

const PERSON = {
  firstName: "Deborah",
  lastName: "Batchelor",
  name: "Deborah Batchelor",
  email: "deborah.batchelor@stirfood.co.uk",
  emailStatus: "verified",
  provider: "apollo",
  providerPersonId: "66f5ed1bd323cb0001439eb4",
  organization: null,
};

const EMAIL_OWNER = "baf6003c-fcb1-4365-9ec7-22ddb951111d";
const PROVIDER_ID_OWNER = "39ac5333-7083-421a-8cf1-9630eb0ba80d";

beforeEach(() => {
  vi.clearAllMocks();
  insertReturning.mockResolvedValue([{ id: "brand-new-lead" }]);
  contactOnConflict.mockResolvedValue(undefined);
  updateWhere.mockResolvedValue(undefined);
  findFirstLead.mockResolvedValue(undefined);
  findFirstContact.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("upsertLeadFromPerson identity precedence", () => {
  it("attributes to the lead that owns the email, even when another lead carries the provider person id", async () => {
    // The exact prod shape: an older backfill lead owns the email; a second lead
    // (minted by an earlier crawl) carries the provider person id and no email.
    findFirstContact.mockResolvedValue({ leadId: EMAIL_OWNER });
    findFirstLead.mockResolvedValue({ id: PROVIDER_ID_OWNER });

    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");
    const leadId = await upsertLeadFromPerson(PERSON as never, { enriched: true });

    expect(leadId).toBe(EMAIL_OWNER);
    // No second, email-less lead is minted.
    expect(insertValues).not.toHaveBeenCalled();
    // Person fields land on the identity that owns the email.
    expect(updateSet).toHaveBeenCalledOnce();
    expect(updateSet.mock.calls[0][0]).toMatchObject({ firstName: "Deborah" });
  });

  it("falls back to the provider person id when the email belongs to nobody", async () => {
    findFirstContact.mockResolvedValue(undefined);
    findFirstLead.mockResolvedValue({ id: PROVIDER_ID_OWNER });

    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");
    const leadId = await upsertLeadFromPerson(PERSON as never, { enriched: true });

    expect(leadId).toBe(PROVIDER_ID_OWNER);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("inserts a fresh lead when neither the email nor the provider person id is known", async () => {
    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");
    const leadId = await upsertLeadFromPerson(PERSON as never, { enriched: true });

    expect(leadId).toBe("brand-new-lead");
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      apolloPersonId: PERSON.providerPersonId,
    });
  });

  // GMAPS-SOURCE-1103: a business found on Google Maps has a phone and no email: the phone is its identity.
  it("a person with no email is the lead that owns their phone (canonical E.164), ahead of the provider id", async () => {
    findFirstContact.mockResolvedValue({ leadId: EMAIL_OWNER });
    findFirstLead.mockResolvedValue({ id: PROVIDER_ID_OWNER });

    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");
    const leadId = await upsertLeadFromPerson({ ...PERSON, email: null, phone: "+7 701 234-56-78" } as never, { enriched: true });

    expect(leadId).toBe(EMAIL_OWNER);
    expect(insertValues).not.toHaveBeenCalled();
    expect(findFirstContact).toHaveBeenCalledOnce();
  });

  it("fails loud when the person carries neither an email, a provider person id nor a phone", async () => {
    const { upsertLeadFromPerson } = await import("../../src/lib/leads-registry.js");

    await expect(
      upsertLeadFromPerson(
        { ...PERSON, email: null, providerPersonId: null, phone: null } as never,
        { enriched: true },
      ),
    ).rejects.toThrow(/no providerPersonId, no email and no phone/);
  });
});

describe("registerServedEmail", () => {
  it("returns the same lead when the email registers cleanly", async () => {
    const { registerServedEmail } = await import("../../src/lib/leads-registry.js");

    const owner = await registerServedEmail({
      leadId: EMAIL_OWNER,
      email: PERSON.email,
      status: "verified",
      source: "apollo",
    });

    expect(owner).toBe(EMAIL_OWNER);
  });

  it("re-attributes to the owning lead when a concurrent serve took the email first", async () => {
    contactOnConflict.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "idx_lcm_channel_value",
      }),
    );
    findFirstContact.mockResolvedValue({ leadId: EMAIL_OWNER });

    const { registerServedEmail } = await import("../../src/lib/leads-registry.js");

    const owner = await registerServedEmail({
      leadId: PROVIDER_ID_OWNER,
      email: PERSON.email,
      status: "verified",
      source: "apollo",
    });

    expect(owner).toBe(EMAIL_OWNER);
  });

  it("fails loud when the email collides but no owning lead can be found", async () => {
    contactOnConflict.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "idx_lcm_channel_value",
      }),
    );
    findFirstContact.mockResolvedValue(undefined);

    const { registerServedEmail } = await import("../../src/lib/leads-registry.js");

    await expect(
      registerServedEmail({
        leadId: PROVIDER_ID_OWNER,
        email: PERSON.email,
        status: "verified",
        source: "apollo",
      }),
    ).rejects.toThrow(/no owning lead could be found/);
  });
});
