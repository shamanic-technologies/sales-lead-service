import { describe, expect, it } from "vitest";
import { readBuyingSignal } from "../../src/lib/buying-signal.js";
import { ServedBuyingSignalSchema } from "../../src/schemas.js";

const signal = {
  type: "job_change",
  occurredOn: "2026-09-10",
  fact: "Dana Ruiz started as Head of Operations at Acme on September 10, 2026",
  source: "apollo:employment_history",
  sourceUrl: null,
};

describe("readBuyingSignal: carried, never derived", () => {
  it("absent and null are both no signal", () => {
    expect(readBuyingSignal(undefined)).toBeNull();
    expect(readBuyingSignal(null)).toBeNull();
  });

  it("carries a complete signal verbatim", () => {
    expect(readBuyingSignal(signal)).toEqual(signal);
  });

  it("an omitted sourceUrl reads as null, not as a guessed link", () => {
    const { sourceUrl: _omit, ...rest } = signal;
    expect(readBuyingSignal(rest)?.sourceUrl).toBeNull();
  });

  it.each([
    ["an unknown type", { ...signal, type: "press_mention" }],
    ["no date", { ...signal, occurredOn: undefined }],
    ["an empty fact", { ...signal, fact: "  " }],
    ["no source", { ...signal, source: undefined }],
    ["a non-object", "hiring"],
    ["an array", [signal]],
  ])("refuses %s rather than trimming it to what parses", (_label, raw) => {
    expect(() => readBuyingSignal(raw)).toThrow(/malformed buyingSignal/);
  });
});

describe("ServedBuyingSignal contract", () => {
  it("is exactly the signal readBuyingSignal returns", () => {
    expect(ServedBuyingSignalSchema.parse(readBuyingSignal(signal))).toEqual(signal);
  });

  it("names every signal type the producer serves, and only those", () => {
    for (const type of ["hiring", "job_change", "funding"]) {
      expect(ServedBuyingSignalSchema.safeParse({ ...signal, type }).success).toBe(true);
    }
    expect(ServedBuyingSignalSchema.safeParse({ ...signal, type: "press_mention" }).success).toBe(false);
  });
});
