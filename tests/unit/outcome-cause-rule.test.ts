import { describe, expect, it } from "vitest";
import { outcomeCauseRule } from "../../src/lib/outcome-cause.js";

const LEAD = "11111111-1111-1111-1111-111111111111";
const DELIVERED = "2026-05-10T00:00:00.000Z";

describe("outcomeCauseRule — the owner's whose-win rule, for any source", () => {
  it("answers ours when the outcome happened after our first delivered email", () => {
    const r = outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-05-20T00:00:00.000Z" }, DELIVERED);
    expect(r).toMatchObject({ causedByOutreach: true, reason: "after_first_delivery", leadId: LEAD });
  });

  it("answers not ours when it happened before, or at the same instant", () => {
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-05-01T00:00:00.000Z" }, DELIVERED)
      .causedByOutreach).toBe(false);
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: DELIVERED }, DELIVERED).causedByOutreach).toBe(false);
  });

  it("never defaults to ours: unmatched, undated and never-delivered stay undecided", () => {
    expect(outcomeCauseRule({ leadId: null, occurredAt: "2026-05-20T00:00:00.000Z" }, DELIVERED))
      .toMatchObject({ causedByOutreach: null, reason: "not_matched", firstDeliveredAt: null });
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: null }, DELIVERED))
      .toMatchObject({ causedByOutreach: null, reason: "event_undated" });
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-05-20T00:00:00.000Z" }, null))
      .toMatchObject({ causedByOutreach: null, reason: "never_delivered" });
  });
});

describe("outcomeCauseRule — read across the person's steps", () => {
  it("a sale after a step of theirs that was not ours is not ours", () => {
    const r = outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-06-01T00:00:00.000Z" }, DELIVERED, {
      key: "sale",
      event: "sale",
      steps: [{ key: "mb", event: "meeting_booked", occurredAt: "2026-04-01T00:00:00.000Z", personCause: null }],
    });
    expect(r).toMatchObject({ causedByOutreach: false, reason: "after_step_not_ours", leadId: LEAD });
  });
});
