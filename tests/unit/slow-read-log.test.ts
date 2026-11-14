import { describe, expect, it } from "vitest";
import { slowReadQuery } from "../../src/lib/slow-read-log.js";

describe("slow-read log query (MON-PAGE-SPEED-1114)", () => {
  it("keeps parameter names and ids", () => {
    expect(slowReadQuery("/orgs/leads/x?brandId=b1&scope=brand")).toBe("brandId=b1&scope=brand");
  });
  it("never prints an email address", () => {
    expect(slowReadQuery("/orgs/brands/b/won-leads?email=jane%40acme.com")).toBe("email=<address>");
  });
  it("says - when there is no query", () => {
    expect(slowReadQuery("/orgs/leads/x")).toBe("-");
    expect(slowReadQuery("/orgs/leads/x?")).toBe("-");
  });
});
