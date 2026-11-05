/**
 * DIGEST-SALES-ATTRIB-1105 (owner 2026-11-05): "a sale downstream of a step that was not ours is not
 * ours either". The three Doc Dinners people of the 2026-11-04 daily email, as the rule sees them.
 */
import { describe, expect, it } from "vitest";
import { coherentCauseRule, type PersonStep } from "../../src/lib/outcome-cause-coherence.js";

const step = (key: string, event: string, occurredAt: string | null, personCause: boolean | null = null): PersonStep => ({
  key,
  event,
  occurredAt,
  personCause,
});

describe("coherentCauseRule", () => {
  it("Thomas Keogh: booked with the client in 2025, our first email 2026-07, Off Boarding card 2026-11-03 -> not ours", () => {
    const first = "2026-07-13T10:00:00.000Z";
    const sale = step("sale", "sale", "2026-11-03T19:44:44.019Z");
    const steps = [step("mb", "meeting_booked", "2025-03-19T02:09:28.000Z"), sale];
    expect(coherentCauseRule(sale, steps, first)).toEqual({
      causedByOutreach: false,
      reason: "after_step_not_ours",
      firstDeliveredAt: first,
      afterStep: { event: "meeting_booked", occurredAt: "2025-03-19T02:09:28.000Z" },
    });
    // The 2025 meeting itself keeps the date rule's answer.
    expect(coherentCauseRule(steps[0], steps, first)).toMatchObject({ causedByOutreach: false, reason: "before_first_delivery" });
  });

  it("Daniel Bai: booked after our email (ours); his sale stays ours, dated or not", () => {
    const first = "2026-08-10T13:24:00.000Z";
    const steps = [
      step("pr", "positive_reply", "2026-08-10T18:46:12.879Z"),
      step("mb", "meeting_booked", "2026-08-10T18:46:14.000Z"),
    ];
    const dated = step("sale", "sale", "2026-11-03T20:20:58.014Z");
    expect(coherentCauseRule(dated, [...steps, dated], first)).toMatchObject({ causedByOutreach: true, reason: "after_first_delivery" });
    const undated = step("sale", "sale", null);
    expect(coherentCauseRule(undated, [...steps, undated], first)).toEqual({
      causedByOutreach: true,
      reason: "undated_after_our_step",
      firstDeliveredAt: first,
      afterStep: { event: "positive_reply", occurredAt: "2026-08-10T18:46:12.879Z" },
    });
  });

  it("Keith Guthrie: one email from us, the sale is his only step -> the date rule alone; undated stays undecided", () => {
    const first = "2026-10-29T10:00:00.000Z";
    const dated = step("sale", "sale", "2026-11-03T20:50:56.798Z");
    expect(coherentCauseRule(dated, [dated], first)).toMatchObject({ causedByOutreach: true, reason: "after_first_delivery" });
    const undated = step("sale", "sale", null);
    expect(coherentCauseRule(undated, [undated], first)).toEqual({ causedByOutreach: null, reason: "event_undated", firstDeliveredAt: first });
  });

  it("a person's word that an earlier step was not ours counts like the date rule's; one that it WAS ours lifts it", () => {
    const first = "2026-05-10T00:00:00.000Z";
    const sale = step("sale", "sale", "2026-06-01T00:00:00.000Z");
    const statedNot = step("mb", "meeting_booked", "2026-05-20T00:00:00.000Z", false);
    expect(coherentCauseRule(sale, [statedNot, sale], first).causedByOutreach).toBe(false);
    const statedOurs = step("mb", "meeting_booked", "2025-01-01T00:00:00.000Z", true);
    expect(coherentCauseRule(sale, [statedOurs, sale], first)).toMatchObject({ causedByOutreach: true, reason: "after_first_delivery" });
  });

  it("only a step at or BEFORE it taints a step; a later 'not ours' step does not reach back", () => {
    const first = "2026-05-10T00:00:00.000Z";
    const booked = step("mb", "meeting_booked", "2026-05-20T00:00:00.000Z");
    const laterNot = step("x", "sale", "2026-06-01T00:00:00.000Z", false);
    expect(coherentCauseRule(booked, [booked, laterNot], first).causedByOutreach).toBe(true);
  });

  it("an undated step of a person with any step not ours, even undated, stays undecided", () => {
    const first = "2026-05-10T00:00:00.000Z";
    const sale = step("sale", "sale", null);
    const already = step("r", "sale_reply", null, false);
    const ours = step("mb", "meeting_booked", "2026-05-20T00:00:00.000Z");
    expect(coherentCauseRule(sale, [sale, already, ours], first)).toMatchObject({ causedByOutreach: null, reason: "event_undated" });
  });

  it("a positive reply answers OUR message: the date rule alone", () => {
    const first = "2026-05-10T00:00:00.000Z";
    const reply = step("pr", "positive_reply", "2026-05-20T00:00:00.000Z");
    const steps = [step("mb", "meeting_booked", "2025-01-01T00:00:00.000Z"), reply];
    expect(coherentCauseRule(reply, steps, first)).toMatchObject({ causedByOutreach: true, reason: "after_first_delivery" });
  });

  it("never turns a never-delivered or before-delivery answer into ours", () => {
    const sale = step("sale", "sale", "2026-06-01T00:00:00.000Z");
    const ours = step("mb", "meeting_booked", "2026-05-20T00:00:00.000Z", true);
    expect(coherentCauseRule(sale, [sale, ours], null)).toMatchObject({ causedByOutreach: null, reason: "never_delivered" });
    expect(coherentCauseRule(sale, [sale, ours], "2026-07-01T00:00:00.000Z")).toMatchObject({ causedByOutreach: false, reason: "before_first_delivery" });
  });
});
