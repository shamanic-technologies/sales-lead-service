import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

describe("foldScreeningCells", () => {
  it("partitions screened by verdict and by P(yes) bucket, per month and in total", async () => {
    const { foldScreeningCells } = await import("../../src/lib/candidate-screening-stats.js");
    const { totals, months } = foldScreeningCells([
      { month: "2026-11", bucket: "from_0_8", verdict: "pass", people: 4 },
      { month: "2026-10", bucket: "below_0_2", verdict: "reject", people: 10 },
      { month: "2026-10", bucket: "from_0_2_to_0_5", verdict: "reject", people: 3 },
      { month: "2026-10", bucket: "above_0_5_below_0_8", verdict: "pass", people: 2 },
    ]);
    expect(months.map((m) => m.month)).toEqual(["2026-10", "2026-11"]);
    expect(months[0]).toMatchObject({ screened: 15, passed: 2, declined: 13 });
    expect(months[0].byProbability.below_0_2).toEqual({ screened: 10, passed: 0, declined: 10 });
    expect(totals).toMatchObject({ screened: 19, passed: 6, declined: 13 });
    expect(totals.byProbability.from_0_8).toEqual({ screened: 4, passed: 4, declined: 0 });
    const bucketSum = Object.values(totals.byProbability).reduce((s, b) => s + b.screened, 0);
    expect(bucketSum).toBe(totals.screened);
  });

  it("throws on a verdict that is neither pass nor reject (never folded into a side)", async () => {
    const { foldScreeningCells } = await import("../../src/lib/candidate-screening-stats.js");
    expect(() => foldScreeningCells([{ month: "2026-10", bucket: "from_0_8", verdict: "maybe", people: 1 }])).toThrow(/neither pass nor reject/);
  });
});
