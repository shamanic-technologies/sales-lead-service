import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: {} }));

const { sameNamedScope } = await import("../../src/lib/lead-change-feed.js");

const base = {
  orgId: "org-1",
  brandId: "brand-1",
  campaignIds: ["a", "x"],
  statuses: ["buffered", "claimed", "served"],
  queryOrgId: null,
  userId: null,
  workflowSlug: null,
  deliveryQueried: true,
};

describe("sameNamedScope", () => {
  it("is the same scope when only what the read RESOLVED moved (campaign identity, delivery)", () => {
    expect(sameNamedScope(base, { ...base, campaignIds: ["a"] })).toBe(true);
    expect(sameNamedScope(base, { ...base, campaignIds: ["b"], deliveryQueried: false })).toBe(true);
  });

  it("is a different scope when anything the caller NAMED differs", () => {
    expect(sameNamedScope(base, { ...base, orgId: "org-2" })).toBe(false);
    expect(sameNamedScope(base, { ...base, brandId: "brand-2" })).toBe(false);
    expect(sameNamedScope(base, { ...base, brandId: null })).toBe(false);
    expect(sameNamedScope(base, { ...base, statuses: ["served"] })).toBe(false);
    expect(sameNamedScope(base, { ...base, workflowSlug: "w" })).toBe(false);
    expect(sameNamedScope(base, { ...base, userId: "u" })).toBe(false);
  });
});
