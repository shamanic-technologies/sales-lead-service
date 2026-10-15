import { describe, expect, it } from "vitest";
import { canonicalE164 } from "../../src/lib/e164-phone.js";

describe("canonicalE164 (REPLY-PHONE-ONLY-1015)", () => {
  it("strips separators and reads 00 as +", () => {
    expect(canonicalE164("+33 6 12-34.56(78)")).toBe("+33612345678");
    expect(canonicalE164(" 0033612345678 ")).toBe("+33612345678");
    expect(canonicalE164("+1 (415) 555-0100")).toBe("+14155550100");
  });
  it("refuses a national number, garbage, a too-short or empty value: never a guessed country", () => {
    for (const v of ["06 12 34 56 78", "+0612345678", "+12", "phone", "", null, undefined]) expect(canonicalE164(v)).toBeNull();
  });
});
