import { describe, expect, it } from "vitest";
import { combineReach } from "../../src/lib/channel-reach.js";

// LEAK-1012 (owner 2026-10-14): the workflow's lead strategy states WHO it finds; the channel states what it can write
// on. A serve requires both.
describe("combineReach", () => {
  it("adds the strategy's methods to the channel's, deduped and sorted", () => {
    expect(combineReach(["email"], ["phone"])).toEqual(["email", "phone"]);
    expect(combineReach(["phone"], ["phone"])).toEqual(["phone"]);
  });
  it("either side alone is the requirement; neither = none", () => {
    expect(combineReach(null, ["phone"])).toEqual(["phone"]);
    expect(combineReach(["email"], null)).toEqual(["email"]);
    expect(combineReach(null, null)).toBeNull();
  });
});
