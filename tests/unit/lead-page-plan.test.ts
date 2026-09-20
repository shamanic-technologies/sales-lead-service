import { describe, it, expect } from "vitest";
import { leadRowInRead, parseLeadSort, standingFilterSet } from "../../src/lib/lead-page-plan.js";
import type { EnrichedLeadIndexRow } from "../../src/lib/lead-engagement.js";
import type { LeadBucket } from "../../src/lib/lead-buckets.js";
import type { LeadStandingState } from "../../src/lib/lead-standing.js";

function row(
  i: number,
  buckets: LeadBucket[] = [],
  standing?: LeadStandingState,
): EnrichedLeadIndexRow {
  return {
    id: `lc-${String(i).padStart(3, "0")}`,
    leadId: `lead-${i}`,
    campaignId: "camp",
    brandIds: ["brand"],
    status: "served",
    email: `p${i}@example.test`,
    servedAt: null,
    // Postgres's own spelling, exactly as the index reads it back.
    createdAtText: `2026-01-01 00:00:00.${String(i).padStart(6, "0")}+00`,
    buckets: new Set(buckets),
    activityAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    ...(standing ? { standing } : {}),
  } as EnrichedLeadIndexRow;
}

describe("the order a caller names", () => {
  it("defaults to the order this endpoint has always answered in", () => {
    expect(parseLeadSort(undefined)).toBe("created");
    expect(parseLeadSort("activity")).toBe("activity");
    expect(() => parseLeadSort("relevance")).toThrow(/Unknown sort/);
  });
});

/**
 * The predicate is per ROW on purpose: it is what lets the population be walked a chunk at a time
 * rather than held (see src/lib/lead-plan-store.ts). The ORDER and the window live in SQL and are
 * covered against a real Postgres in tests/integration/lead-plan-store-sql.test.ts.
 */
describe("which rows belong to a filtered read", () => {
  it("keeps only the named bucket's own rows", () => {
    expect(leadRowInRead(row(0, ["contacted"]), "contacted", null)).toBe(true);
    expect(leadRowInRead(row(1, ["contacted"]), "website_visit", null)).toBe(false);
    // A row carrying no evidence at all is in no bucket, so no bucket filter can reach it.
    expect(leadRowInRead(row(2, []), "contacted", null)).toBe(false);
  });

  it("keeps every row when the caller named neither lens", () => {
    expect(leadRowInRead(row(2, []), null, null)).toBe(true);
  });

  it("reads several standings as ONE set, the way a board column holds two states", () => {
    const set = standingFilterSet(["opted_out", "disqualified"]);
    expect(leadRowInRead(row(0, [], "opted_out"), null, set)).toBe(true);
    expect(leadRowInRead(row(1, [], "disqualified"), null, set)).toBe(true);
    expect(leadRowInRead(row(2, [], "engaged"), null, set)).toBe(false);
  });

  it("counts a row nobody could resolve as `unresolved`, never as absent", () => {
    expect(leadRowInRead(row(0, []), null, standingFilterSet(["unresolved"]))).toBe(true);
  });

  it("narrows to the rows satisfying BOTH when a bucket and a standing are named", () => {
    const set = standingFilterSet(["sales_interest"]);
    expect(leadRowInRead(row(0, ["contacted"], "sales_interest"), "contacted", set)).toBe(true);
    expect(leadRowInRead(row(1, ["contacted"], "engaged"), "contacted", set)).toBe(false);
    expect(leadRowInRead(row(2, [], "sales_interest"), "contacted", set)).toBe(false);
  });

  it("an absent standing filter is not an empty one", () => {
    expect(standingFilterSet(null)).toBeNull();
    expect(standingFilterSet([])?.size).toBe(0);
  });
});
