import { describe, it, expect, vi } from "vitest";
import { createInFlightHolds } from "../../src/lib/in-flight-holds.js";

describe("in-flight holds (SERVE-LOCK-STUCK-1126)", () => {
  it("refuses a second hold on the same key until the first is released", () => {
    const holds = createInFlightHolds(1_000, () => 0);
    const first = holds.tryHold("c1");
    expect(first.held).toBe(true);
    expect(holds.tryHold("c1")).toEqual({ held: false, heldSinceMs: 0 });
    expect(holds.tryHold("c2").held).toBe(true);
    if (first.held) first.release();
    expect(holds.tryHold("c1").held).toBe(true);
  });

  it("a late release never frees another request's hold", () => {
    let t = 0;
    const holds = createInFlightHolds(1_000, () => t);
    const orphan = holds.tryHold("c1");
    t = 2_000;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = holds.tryHold("c1");
    expect(next.held).toBe(true);
    if (orphan.held) orphan.release();
    expect(holds.tryHold("c1").held).toBe(false);
    if (next.held) next.release();
    expect(holds.size()).toBe(0);
  });

  it("an orphan older than the stale window refuses nobody, a younger one still does", () => {
    let t = 0;
    const holds = createInFlightHolds(1_000, () => t);
    holds.tryHold("c1");
    t = 1_000;
    expect(holds.tryHold("c1").held).toBe(false);
    t = 1_001;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(holds.tryHold("c1").held).toBe(true);
  });

  it("refuses an unusable stale window", () => {
    expect(() => createInFlightHolds(Number.NaN)).toThrow();
    expect(() => createInFlightHolds(0)).toThrow();
  });
});
