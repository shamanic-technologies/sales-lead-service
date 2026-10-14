import { describe, it, expect } from "vitest";

const { wellFormedState } = await import("../../src/lib/qualification-judge.js");

describe("wellFormedState", () => {
  it("replaces half of a split emoji, wherever it sits, and leaves whole text alone", () => {
    const cut = "hi 😀".slice(0, 4); // ends on the high half of the pair
    const at = new Date("2026-10-14T00:00:00Z");
    const out = wellFormedState({ thread: [{ text: cut, at }], name: "Ann 😀", [`k${cut}`]: "\uDE00x" }) as Record<string, unknown>;
    expect(out).toEqual({ thread: [{ text: "hi �", at }], name: "Ann 😀", "khi �": "�x" });
    expect(JSON.stringify(out)).not.toMatch(/\\ud[89a-f]/i);
  });

  it("passes numbers, booleans and null through", () => {
    expect(wellFormedState({ a: 1, b: true, c: null })).toEqual({ a: 1, b: true, c: null });
  });
});
