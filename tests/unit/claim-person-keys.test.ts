import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));

const { claimPersonKeys } = await import("../../src/lib/followup-queue.js");

describe("claimPersonKeys (CLAIM-OCCURRENCE-PERSON-1025)", () => {
  it("absent, null, a non-object or nothing usable = no person (the claim is unchanged)", () => {
    expect(claimPersonKeys(undefined)).toBeNull();
    expect(claimPersonKeys(null)).toBeNull();
    expect(claimPersonKeys("a@b.c")).toBeNull();
    expect(claimPersonKeys({ email: "", phone: "abc", leadId: "not-a-uuid" })).toBeNull();
  });
  it("folds the email, canonicalizes the phone, keeps a uuid lead id", () => {
    expect(claimPersonKeys({ email: " Ana@Client.COM ", phone: "0033 6 12 34 56 78", leadId: "14DEF1DE-7EED-4D36-B853-B36954EA3EF8" })).toEqual({
      email: "ana@client.com",
      phone: "+33612345678",
      leadId: "14DEF1DE-7EED-4D36-B853-B36954EA3EF8",
    });
  });
});
