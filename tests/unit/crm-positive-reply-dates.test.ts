import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn() }));

import { crmPositiveReplyAtFor } from "../../src/lib/crm-positive-reply-dates.js";

describe("crmPositiveReplyAtFor", () => {
  const dates = new Map([
    ["brand-a:lead-1", "2026-09-21T13:45:00.000Z"],
    ["brand-b:lead-1", "2026-09-10T08:00:00.000Z"],
    ["brand-a:lead-2", "2026-09-22T09:00:00.000Z"],
  ]);

  it("answers the row's own brand and lead", () => {
    expect(crmPositiveReplyAtFor(dates, { leadId: "lead-2", brandIds: ["brand-a"] })).toBe("2026-09-22T09:00:00.000Z");
  });

  it("takes the earliest across a row's brands", () => {
    expect(crmPositiveReplyAtFor(dates, { leadId: "lead-1", brandIds: ["brand-a", "brand-b"] })).toBe("2026-09-10T08:00:00.000Z");
  });

  it("never lends one brand's reply to another brand's row", () => {
    expect(crmPositiveReplyAtFor(dates, { leadId: "lead-2", brandIds: ["brand-b"] })).toBeNull();
  });

  it("is null for a person the CRM says nothing about", () => {
    expect(crmPositiveReplyAtFor(dates, { leadId: "lead-9", brandIds: ["brand-a"] })).toBeNull();
  });
});
