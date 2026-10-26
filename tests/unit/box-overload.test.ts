// BOX-OVERLOAD-1026: the pure halves of the load cuts. Each states the SAME answer as before, read with less work.
import { describe, expect, it, vi } from "vitest";

const executed: string[] = [];
const dbRows: unknown[][] = [];
vi.mock("../../src/db/index.js", () => ({
  db: { execute: async (q: { queryChunks?: unknown[] }) => (executed.push(JSON.stringify(q).slice(0, 200)), dbRows.shift() ?? []) },
  sql: Object.assign((..._a: unknown[]) => ({}), { unsafe: () => ({}) }),
}));

const { ensureWindow, FULL_ENSURE_EVERY_MS, ENSURE_OVERLAP_MS } = await import("../../src/lib/lead-followup-date.js");
const { rememberWindow } = await import("../../src/lib/lead-read-model.js");
const { crmPairedOrgs, clearCrmPairedOrgsMemo, PAIRED_ORGS_TTL_MS } = await import("../../src/lib/crm-cold-eligibility.js");
const { memoryLine } = await import("../../src/lib/memory-report.js");

describe("follow-up dates intake window", () => {
  const NOW = Date.parse("2026-10-26T18:00:00Z");
  it("reads every row on the first pass and once an hour", () => {
    expect(ensureWindow(NOW, null, null)).toBeUndefined();
    expect(ensureWindow(NOW, NOW - FULL_ENSURE_EVERY_MS, NOW - 120_000)).toBeUndefined();
  });
  it("between full passes reads rows filed since the previous pass, with an overlap", () => {
    const last = NOW - 120_000;
    expect(ensureWindow(NOW, NOW - 10 * 60_000, last)?.getTime()).toBe(last - ENSURE_OVERLAP_MS);
  });
});

describe("read-model applied-change memory", () => {
  it("keeps exactly the window's seqs, never what left it", () => {
    expect([...rememberWindow([{ seq: "5" }, { seq: "6" }])]).toEqual(["5", "6"]);
    expect(rememberWindow([]).size).toBe(0);
  });
  it("is capped at 20k (the newest kept: a dropped seq is re-applied, never skipped)", () => {
    const window = Array.from({ length: 20_005 }, (_, i) => ({ seq: String(i) }));
    const kept = rememberWindow(window);
    expect(kept.size).toBe(20_000);
    expect(kept.has("20004")).toBe(true);
    expect(kept.has("0")).toBe(false);
  });
});

describe("crmPairedOrgs memo", () => {
  it("asks the database once per brand per 5 min and answers the same orgs", async () => {
    clearCrmPairedOrgsMemo();
    executed.length = 0;
    dbRows.push([{ org_id: "o1" }, { org_id: "o2" }]);
    const t = Date.parse("2026-10-26T18:00:00Z");
    expect(await crmPairedOrgs("b1", t)).toEqual(["o1", "o2"]);
    expect(await crmPairedOrgs("b1", t + PAIRED_ORGS_TTL_MS - 1)).toEqual(["o1", "o2"]);
    expect(executed).toHaveLength(1);
    dbRows.push([{ org_id: "o3" }]);
    expect(await crmPairedOrgs("b1", t + PAIRED_ORGS_TTL_MS)).toEqual(["o3"]);
    expect(executed).toHaveLength(2);
  });
});

describe("memory report line", () => {
  it("names the thread and its heap", () => {
    expect(memoryLine("background", 3600, 300 * 1_048_576, 400 * 1_048_576, 900 * 1_048_576, 10 * 1_048_576)).toBe(
      "[memory] thread=background uptimeMin=60 heapUsedMb=300 heapTotalMb=400 rssMb=900 externalMb=10",
    );
  });
});
