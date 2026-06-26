import { describe, it, expect, vi } from "vitest";

// Capture the fragments `leadCampaignBaseRelation` builds so we can assert the
// brand/org-scope collapse vs the campaign-scope flat path without a live DB.
let mockSqlCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    mockSqlCalls.push({ strings, values });
    return { __fragment: true };
  },
}));

const { leadCampaignBaseRelation, shouldDedupeLeadList } = await import(
  "../../src/lib/lead-list-query.js"
);

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";
const CAMPAIGN = "10000000-0000-0000-0000-000000000001";

function textOf(): string {
  return mockSqlCalls.map((c) => c.strings.join(" ")).join(" ");
}

describe("leadCampaignBaseRelation dedup", () => {
  it("shouldDedupeLeadList collapses brand/org scope, never campaign scope", () => {
    expect(shouldDedupeLeadList({ orgId: ORG })).toBe(true);
    expect(shouldDedupeLeadList({ orgId: ORG, brandId: BRAND })).toBe(true);
    expect(shouldDedupeLeadList({ orgId: ORG, campaignId: CAMPAIGN })).toBe(false);
    expect(shouldDedupeLeadList({ orgId: ORG, brandId: BRAND, campaignId: CAMPAIGN })).toBe(false);
  });

  it("brand scope (no campaignId) emits DISTINCT ON (lead_id) with the lifecycle winner ordering", () => {
    mockSqlCalls = [];
    leadCampaignBaseRelation({ orgId: ORG, brandId: BRAND });
    const sql = textOf();
    expect(sql).toContain("DISTINCT ON (lc0.lead_id)");
    // Winner: served > claimed > buffered > skipped, then served_at / created_at / id.
    expect(sql).toContain("WHEN 'served' THEN 3");
    expect(sql).toContain("WHEN 'claimed' THEN 2");
    expect(sql).toContain("WHEN 'buffered' THEN 1");
    expect(sql).toContain("lc0.served_at DESC NULLS LAST");
    expect(sql).toContain("lc0.created_at DESC");
    expect(sql).toContain("lc0.id DESC");
    // The brand filter must live INSIDE the dedup subquery so the winner is chosen
    // within scope, with the brandId bound as a parameter.
    const values = mockSqlCalls.flatMap((c) => c.values);
    expect(values).toContain(BRAND);
    expect(values).toContain(ORG);
  });

  it("org-only scope (no brandId, no campaignId) still collapses by lead_id", () => {
    mockSqlCalls = [];
    leadCampaignBaseRelation({ orgId: ORG });
    expect(textOf()).toContain("DISTINCT ON (lc0.lead_id)");
  });

  it("campaign scope stays a flat leads_campaigns scan (no DISTINCT ON)", () => {
    mockSqlCalls = [];
    leadCampaignBaseRelation({ orgId: ORG, brandId: BRAND, campaignId: CAMPAIGN });
    const sql = textOf();
    expect(sql).toContain("leads_campaigns lc");
    expect(sql).not.toContain("DISTINCT ON");
  });
});
