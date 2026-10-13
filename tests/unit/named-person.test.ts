import { describe, expect, it } from "vitest";
import { campaignBrandOf, normalizeEmail, senderSuppression, splitFullName } from "../../src/lib/named-person.js";

describe("named person helpers", () => {
  it("reads the campaign's brand: brandId first, else the first legacy brandIds entry, else none", () => {
    expect(campaignBrandOf({ brandId: "b1", brandIds: ["b2"] })).toBe("b1");
    expect(campaignBrandOf({ brandId: null, brandIds: ["", "b2"] })).toBe("b2");
    expect(campaignBrandOf({ brandId: " ", brandIds: [] })).toBeNull();
    expect(campaignBrandOf({})).toBeNull();
  });

  it("case-folds and trims the address", () => {
    expect(normalizeEmail("  Marie@Example.COM ")).toBe("marie@example.com");
  });

  it("splits a full name at the first space, a single word is a first name, nothing stays nothing", () => {
    expect(splitFullName("Jane  van Dyke")).toEqual({ name: "Jane van Dyke", firstName: "Jane", lastName: "van Dyke" });
    expect(splitFullName("Cher")).toEqual({ name: "Cher", firstName: "Cher", lastName: null });
    expect(splitFullName("  ")).toEqual({ name: null, firstName: null, lastName: null });
    expect(splitFullName(null)).toEqual({ name: null, firstName: null, lastName: null });
  });
});

describe("senderSuppression: what the brand's sender says about a stated person", () => {
  const scoped = (over: Record<string, unknown>) => ({ unsubscribed: false, bounced: false, ...over }) as never;
  it("names an unsubscribe at any scope (global, brand, this campaign), never another campaign's", () => {
    expect(senderSuppression({ email: "a@x.com", broadcast: { global: { email: { bounced: false, unsubscribed: true } } } }, "c1")).toBe("unsubscribed");
    expect(senderSuppression({ email: "a@x.com", broadcast: { brand: scoped({ unsubscribed: true }) } }, "c1")).toBe("unsubscribed");
    expect(senderSuppression({ email: "a@x.com", transactional: { byCampaign: { c1: scoped({ unsubscribed: true }) } } }, "c1")).toBe("unsubscribed");
    expect(senderSuppression({ email: "a@x.com", transactional: { byCampaign: { c2: scoped({ unsubscribed: true }) } } }, "c1")).toBeNull();
  });
  it("names a fleet-wide hard bounce, an unsubscribe outranks it", () => {
    expect(senderSuppression({ email: "a@x.com", broadcast: { global: { email: { bounced: true, unsubscribed: false } } } }, "c1")).toBe("bounced");
    expect(
      senderSuppression(
        { email: "a@x.com", broadcast: { global: { email: { bounced: true, unsubscribed: false } } }, transactional: { brand: scoped({ unsubscribed: true }) } },
        "c1",
      ),
    ).toBe("unsubscribed");
  });
  it("says nothing for an address the sender never saw", () => {
    expect(senderSuppression(undefined, "c1")).toBeNull();
    expect(senderSuppression({ email: "a@x.com" }, "c1")).toBeNull();
  });
});
