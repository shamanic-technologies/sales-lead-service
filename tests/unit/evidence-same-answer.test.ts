import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn() }));
const { sameAnswer } = await import("../../src/lib/lead-delivery-evidence.js");

describe("sameAnswer — is a re-asked delivery answer the one already stored?", () => {
  it("ignores key order, which jsonb does not keep", () => {
    expect(sameAnswer({ a: 1, b: { c: true, d: "x" } }, { b: { d: "x", c: true }, a: 1 })).toBe(true);
  });
  it("sees any changed, added or removed value", () => {
    expect(sameAnswer({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameAnswer({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(sameAnswer({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(sameAnswer({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameAnswer({ a: "true" }, { a: true })).toBe(false);
  });
  it("treats a stored NULL (asked, nothing known) as different from any answer", () => {
    expect(sameAnswer(null, null)).toBe(true);
    expect(sameAnswer(null, {})).toBe(false);
    expect(sameAnswer({}, null)).toBe(false);
  });
});
