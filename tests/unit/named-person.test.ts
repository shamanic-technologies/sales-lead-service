import { describe, expect, it } from "vitest";
import { campaignBrandOf, normalizeEmail, splitFullName } from "../../src/lib/named-person.js";

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
