import { describe, expect, it } from "vitest";
import { widestEmailPolicy } from "../../src/lib/source-email-demand.js";

describe("widestEmailPolicy (CATCHALL-NEVER-SOURCED-1014)", () => {
  it("catch-all from any pipe wins", () => {
    expect(widestEmailPolicy(["valid_only", "valid_and_catch_all"])).toBe("valid_and_catch_all");
    expect(widestEmailPolicy([null, "valid_and_catch_all"])).toBe("valid_and_catch_all");
  });
  it("valid only stays valid only; nothing stated is null", () => {
    expect(widestEmailPolicy(["valid_only", undefined])).toBe("valid_only");
    expect(widestEmailPolicy([null, undefined])).toBeNull();
    expect(widestEmailPolicy([])).toBeNull();
  });
});
