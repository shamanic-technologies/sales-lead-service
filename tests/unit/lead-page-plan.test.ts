import { describe, it, expect } from "vitest";
import { parseLeadSort } from "../../src/lib/lead-page-plan.js";

describe("the order a caller names", () => {
  it("defaults to the order this endpoint has always answered in", () => {
    expect(parseLeadSort(undefined)).toBe("created");
    expect(parseLeadSort("activity")).toBe("activity");
    expect(() => parseLeadSort("relevance")).toThrow(/Unknown sort/);
  });
});
