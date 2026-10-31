/**
 * UNIBOX-REPLY-LAG-1031: the box check the lag measure posts. Red only past the line (a reply waiting a few seconds
 * is the fast lane doing its job), a value in minutes for the Monitoring chart, a reason in plain words.
 */
import { describe, expect, it } from "vitest";
import { LAG_CHECK_NAME, LAG_RED_AFTER_MINUTES, lagCheckRun } from "../../src/lib/unibox-fast-lane.js";

const now = new Date("2026-10-30T22:20:00.000Z");

describe("unibox reply lag check", () => {
  it("is normal when nothing waits", () => {
    const run = lagCheckRun({ lagMinutes: 0, waiting: 0, checked: 12, oldest: null }, now);
    expect(run).toMatchObject({ check: LAG_CHECK_NAME, ok: true, value: 0, unit: "minutes", cadenceMinutes: 5, ranAt: now.toISOString() });
    expect(run.reason).toMatch(/12 checked/);
  });

  it("is normal at the line, red just past it", () => {
    expect(lagCheckRun({ lagMinutes: LAG_RED_AFTER_MINUTES, waiting: 1, checked: 3, oldest: null }, now).ok).toBe(true);
    const red = lagCheckRun(
      { lagMinutes: LAG_RED_AFTER_MINUTES + 0.1, waiting: 2, checked: 3, oldest: { orgId: "o", brandId: "b", receivedAt: "2026-10-30T22:01:00.000Z", kind: "reply" } },
      now,
    );
    expect(red).toMatchObject({ ok: false, value: LAG_RED_AFTER_MINUTES + 0.1 });
    expect(String(red.reason)).toMatch(/waited/);
    expect((red.details as Record<string, unknown>).oldest).toMatchObject({ kind: "reply" });
  });
});
