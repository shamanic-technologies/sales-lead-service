import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: async () => [] } }));
const { buildReplyLatencyDistribution, REPLY_LATENCY_BUCKETS } = await import("../../src/lib/reply-latency.js");

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
});
