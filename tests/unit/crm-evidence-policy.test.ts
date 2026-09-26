import { describe, expect, it } from "vitest";
import {
  crmCauseRule,
  effectiveCrmCause,
  evidenceFromEvents,
  crmOutcomeSignature,
} from "../../src/lib/crm-evidence.js";
import { resolveStepStates } from "../../src/lib/step-states.js";
import { closedDealFrom } from "../../src/lib/closed-deal.js";
import { LEAD_STEP_OUTCOMES, statementSourceOf } from "../../src/lib/step-statements.js";

const ev = (step: string, occurredAt: string | null, sourceId = "x") => ({
  step,
  occurredAt,
  dateBasis: "booked_at",
  source: "appointment",
  sourceId,
  detail: null,
});

describe("evidenceFromEvents", () => {
  it("maps crm-service's steps onto ours, a not-held meeting and a lost deal as nevers", () => {
    const out = evidenceFromEvents([
      ev("meeting_booked", "2026-01-01T00:00:00Z"),
      ev("meeting_attended", "2026-01-02T00:00:00Z"),
      ev("sale", "2026-01-03T00:00:00Z"),
      ev("meeting_not_held", "2026-01-04T00:00:00Z"),
      ev("deal_lost", "2026-01-05T00:00:00Z"),
      ev("something_new", "2026-01-06T00:00:00Z"),
    ]);
    const keys = out.map((e) => `${e.kind}:${e.step}:${e.crmStep}`).sort();
    expect(keys).toEqual([
      "never:meeting_attended:meeting_not_held",
      "never:sale:deal_lost",
      "outcome:meeting_attended:meeting_attended",
      "outcome:meeting_booked:meeting_booked",
      "outcome:sale:sale",
    ]);
  });

  it("keeps the EARLIEST dated event per step; an undated one stands only when nothing is dated", () => {
    const [sale] = evidenceFromEvents([
      ev("sale", null, "undated"),
      ev("sale", "2026-05-20T00:00:00Z", "late"),
      ev("sale", "2026-05-12T16:07:02.196Z", "early"),
    ]);
    expect(sale.sourceId).toBe("early");
    expect(sale.occurredAt).toBe("2026-05-12T16:07:02.196Z");
    const [undated] = evidenceFromEvents([ev("sale", null, "only")]);
    expect(undated.occurredAt).toBeNull();
  });
});

describe("crmCauseRule — the owner's default", () => {
  const delivered = "2026-05-11T00:26:36.799Z";
  it("after our first delivered email is ours", () => {
    expect(crmCauseRule("2026-05-14T18:02:28Z", delivered)).toMatchObject({
      causedByOutreach: true,
      reason: "after_first_delivery",
    });
  });
  it("at or before it is not ours", () => {
    expect(crmCauseRule(delivered, delivered).causedByOutreach).toBe(false);
    expect(crmCauseRule("2025-02-07T18:35:26Z", delivered)).toMatchObject({
      causedByOutreach: false,
      reason: "before_first_delivery",
    });
  });
  it("an undated event is NEVER ours, and neither is a lead we never delivered to", () => {
    expect(crmCauseRule(null, delivered)).toMatchObject({ causedByOutreach: null, reason: "event_undated" });
    expect(crmCauseRule("2026-05-14T00:00:00Z", null)).toMatchObject({
      causedByOutreach: null,
      reason: "never_delivered",
    });
  });
  it("a person's override outranks the rule; without one the rule stands", () => {
    const rule = crmCauseRule("2025-01-01T00:00:00Z", delivered);
    expect(effectiveCrmCause(rule, { causedByOutreach: true })).toEqual({ causedByOutreach: true, basis: "person" });
    expect(effectiveCrmCause(rule, null)).toEqual({ causedByOutreach: false, basis: "rule" });
  });
});

describe("a CRM-evidenced step", () => {
  it("reads as a stated outcome with source crm, and closes the deal with its whose-win", () => {
    const steps = resolveStepStates({
      allSteps: LEAD_STEP_OUTCOMES,
      outcomes: new Map([
        [
          "meeting_attended",
          {
            source: statementSourceOf("crm"),
            valueCents: null,
            costCents: null,
            causedByOutreach: false,
            note: null,
            statedByUserId: null,
            at: "2026-05-10T16:07:06.493Z",
          },
        ],
        [
          "sale",
          {
            source: statementSourceOf("crm"),
            valueCents: null,
            costCents: null,
            causedByOutreach: false,
            note: null,
            statedByUserId: null,
            at: "2026-05-12T16:07:06.493Z",
          },
        ],
      ]),
      nevers: new Map(),
    });
    expect(steps.find((s) => s.step === "sale")).toMatchObject({ state: "outcome", origin: "stated", source: "crm" });
    // An attended meeting implies the booking.
    expect(steps.find((s) => s.step === "meeting_booked")).toMatchObject({ state: "outcome", origin: "implied" });
    expect(closedDealFrom(steps)).toMatchObject({ source: "crm", causedByOutreach: false });
  });

  it("a CRM never carries source crm, and an outcome on the same step still beats it", () => {
    const base = {
      allSteps: LEAD_STEP_OUTCOMES,
      nevers: new Map([["meeting_attended" as const, { source: "crm" as const, costCents: null, note: null, statedByUserId: null, at: null }]]),
    };
    const dead = resolveStepStates({ ...base, outcomes: new Map() });
    expect(dead.find((s) => s.step === "meeting_attended")).toMatchObject({ state: "never", source: "crm" });
    // A sale can still close off a reply with no meeting, so a meeting not held closes nothing else.
    expect(dead.find((s) => s.step === "sale")).toMatchObject({ state: "pending" });
  });

  it("stored sources read back: manual, crm, anything else is the tracker", () => {
    expect(statementSourceOf("manual")).toBe("manual");
    expect(statementSourceOf("crm")).toBe("crm");
    expect(statementSourceOf("tracker")).toBe("tracker");
    expect(statementSourceOf(null)).toBe("tracker");
  });

  it("a CRM outcome signature is per person and step, disjoint from a person's m: one", () => {
    expect(crmOutcomeSignature("L", "sale")).toBe("crm:L:sale");
  });
});
