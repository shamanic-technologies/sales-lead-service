import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: async () => [] } }));
const { buildReplyLatencyDistribution, REPLY_LATENCY_BUCKETS, REPLY_LATENCY_DAY_BUCKETS } = await import("../../src/lib/reply-latency.js");

/** TTFPR-DISTRIBUTION-1021: the delay buckets are contiguous, readable, and the running count is the cumulative curve. */
describe("reply latency distribution", () => {
  it("buckets are contiguous from 0, the last open-ended", () => {
    expect(REPLY_LATENCY_BUCKETS[0].fromMs).toBe(0);
    for (let i = 1; i < REPLY_LATENCY_BUCKETS.length; i++) expect(REPLY_LATENCY_BUCKETS[i].fromMs).toBe(REPLY_LATENCY_BUCKETS[i - 1].toMs);
    expect(REPLY_LATENCY_BUCKETS.at(-1)!.toMs).toBeNull();
    for (const b of REPLY_LATENCY_BUCKETS) expect(b.label).not.toMatch(/[—–]/);
  });

  it("serves every bucket with its count and running count", () => {
    const d = buildReplyLatencyDistribution(new Map([[0, 2], [4, 1], [14, 3]]));
    expect(d).toHaveLength(REPLY_LATENCY_BUCKETS.length);
    expect(d.map((b) => b.count)).toEqual([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
    expect(d.map((b) => b.cumulativeCount)).toEqual([2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 6]);
  });

  it("day bins (TTFPR-DAY-BINS-1021): Day 1 .. Day 21 of 24 h each, then 21 days or more", () => {
    const D = 24 * 3_600_000;
    expect(REPLY_LATENCY_DAY_BUCKETS).toHaveLength(22);
    expect(REPLY_LATENCY_DAY_BUCKETS[0]).toEqual({ key: "day_1", label: "Day 1", fromMs: 0, toMs: D });
    expect(REPLY_LATENCY_DAY_BUCKETS[20]).toEqual({ key: "day_21", label: "Day 21", fromMs: 20 * D, toMs: 21 * D });
    expect(REPLY_LATENCY_DAY_BUCKETS[21]).toEqual({ key: "day_21_plus", label: "21 days or more", fromMs: 21 * D, toMs: null });
    for (let i = 1; i < REPLY_LATENCY_DAY_BUCKETS.length; i++) expect(REPLY_LATENCY_DAY_BUCKETS[i].fromMs).toBe(REPLY_LATENCY_DAY_BUCKETS[i - 1].toMs);
    const d = buildReplyLatencyDistribution(new Map([[1, 2], [21, 1]]), REPLY_LATENCY_DAY_BUCKETS);
    expect(d).toHaveLength(22);
    expect(d[1]).toMatchObject({ key: "day_2", count: 2, cumulativeCount: 2 });
    expect(d[21]).toMatchObject({ key: "day_21_plus", count: 1, cumulativeCount: 3 });
  });
});
