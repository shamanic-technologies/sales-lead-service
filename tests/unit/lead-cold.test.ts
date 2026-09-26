import { describe, it, expect } from "vitest";
import {
  COLD_AFTER_DAYS,
  CRM_COLD_INELIGIBLE,
  deriveWentCold,
  earlierInstant,
  type CrmColdEligibility,
} from "../../src/lib/lead-cold.js";
import { resolveStepStates, type StatedNever, type StatedOutcome } from "../../src/lib/step-funnel-state.js";
import { LEAD_STEP_OUTCOMES, type LeadStepOutcomeName } from "../../src/lib/step-statements.js";

const FUNNEL: LeadStepOutcomeName[] = ["meeting_booked", "meeting_attended", "sale"];
const NOW = new Date("2026-09-26T12:00:00Z");
const USABLE: CrmColdEligibility = {
  eligible: true,
  reason: null,
  evidences: { meeting_booked: true, meeting_attended: true },
};

function outcome(at: string | null, source: StatedOutcome["source"] = "crm"): StatedOutcome {
  return {
    source,
    valueCents: null,
    costCents: null,
    causedByOutreach: null,
    note: null,
    statedByUserId: null,
    at,
  };
}
const never: StatedNever = { source: "manual", costCents: 0, note: null, statedByUserId: null, at: null };

function steps(
  outcomes: Partial<Record<LeadStepOutcomeName, StatedOutcome>> = {},
  nevers: Partial<Record<LeadStepOutcomeName, StatedNever>> = {},
) {
  return resolveStepStates({
    allSteps: LEAD_STEP_OUTCOMES,
    funnelSteps: FUNNEL,
    outcomes: new Map(Object.entries(outcomes) as [LeadStepOutcomeName, StatedOutcome][]),
    nevers: new Map(Object.entries(nevers) as [LeadStepOutcomeName, StatedNever][]),
  });
}

function derive(overrides: Partial<Parameters<typeof deriveWentCold>[0]> = {}) {
  return deriveWentCold({
    eligibility: USABLE,
    funnelSteps: FUNNEL,
    steps: steps(),
    positiveReplyAt: null,
    pairingUnconfirmed: false,
    now: NOW,
    ...overrides,
  });
}

describe("deriveWentCold — the owner's rule", () => {
  it("states the window once, as 30 days", () => {
    expect(COLD_AFTER_DAYS).toBe(30);
  });

  it("a positive reply before 2026-08-27 with no meeting goes cold at meeting_booked (Pennetti)", () => {
    const cold = derive({ positiveReplyAt: "2026-08-20T10:00:00.000Z" });
    expect(cold).toEqual({
      step: "meeting_booked",
      since: "2026-09-19T10:00:00.000Z",
      after: "positive_reply",
      stalledSince: "2026-08-20T10:00:00.000Z",
      afterDays: 30,
    });
  });

  it("a positive reply fewer than 30 days ago is still live", () => {
    expect(derive({ positiveReplyAt: "2026-09-01T00:00:00.000Z" })).toBeNull();
  });

  it("a meeting booked 2026-07-09 and not attended goes cold at meeting_attended (Al Simeone)", () => {
    const cold = derive({
      positiveReplyAt: "2026-07-09T13:34:19.290Z",
      steps: steps({ meeting_booked: outcome("2026-07-09T13:34:22.000Z") }),
    });
    expect(cold?.step).toBe("meeting_attended");
    expect(cold?.after).toBe("meeting_booked");
    expect(cold?.since).toBe("2026-08-08T13:34:22.000Z");
  });

  it("a meeting booked 2026-08-10 and not attended goes cold at meeting_attended (Daniel Bai)", () => {
    const cold = derive({ steps: steps({ meeting_booked: outcome("2026-08-10T18:46:14.000Z") }) });
    expect(cold?.step).toBe("meeting_attended");
  });

  it("an attended meeting never goes cold (Levi Curran, Brice Jackson)", () => {
    expect(
      derive({
        steps: steps({
          meeting_booked: outcome("2026-05-20T16:18:56.000Z"),
          meeting_attended: outcome("2026-05-30T13:03:01.946Z"),
        }),
      }),
    ).toBeNull();
    expect(
      derive({
        steps: steps({
          meeting_booked: outcome("2026-07-20T18:23:12.000Z"),
          meeting_attended: outcome("2026-09-26T06:51:11.169Z", "manual"),
        }),
      }),
    ).toBeNull();
  });

  it("a sale implies attendance, so a lead that paid never goes cold", () => {
    expect(derive({ steps: steps({ sale: outcome("2026-06-01T00:00:00.000Z") }) })).toBeNull();
  });

  it("a lead that progresses after going cold stops reading as cold", () => {
    const reply = "2026-07-01T00:00:00.000Z";
    expect(derive({ positiveReplyAt: reply })?.step).toBe("meeting_booked");
    // It books today: no longer cold at meeting_booked, and not yet cold at attendance.
    expect(
      derive({ positiveReplyAt: reply, steps: steps({ meeting_booked: outcome("2026-09-25T00:00:00.000Z") }) }),
    ).toBeNull();
    // And once it attends, never again.
    expect(
      derive({
        positiveReplyAt: reply,
        steps: steps({
          meeting_booked: outcome("2026-07-02T00:00:00.000Z"),
          meeting_attended: outcome("2026-09-25T00:00:00.000Z"),
        }),
      }),
    ).toBeNull();
  });

  it("a person's never on the step wins over the derivation", () => {
    expect(
      derive({ positiveReplyAt: "2026-06-01T00:00:00.000Z", steps: steps({}, { meeting_booked: never }) }),
    ).toBeNull();
    expect(
      derive({
        steps: steps({ meeting_booked: outcome("2026-06-01T00:00:00.000Z") }, { meeting_attended: never }),
      }),
    ).toBeNull();
  });

  it("a brand without a usable CRM: nothing goes cold", () => {
    for (const reason of ["no_crm_connection", "crm_unreadable", "crm_sync_stale", "crm_never_paired"] as const) {
      expect(
        derive({ eligibility: CRM_COLD_INELIGIBLE(reason), positiveReplyAt: "2026-05-01T00:00:00.000Z" }),
      ).toBeNull();
    }
  });

  it("a CRM that cannot evidence the missing step proves nothing about it", () => {
    const noBookingStages = { ...USABLE, evidences: { meeting_booked: false, meeting_attended: true } };
    expect(derive({ eligibility: noBookingStages, positiveReplyAt: "2026-05-01T00:00:00.000Z" })).toBeNull();
    const noAttendanceStages = { ...USABLE, evidences: { meeting_booked: true, meeting_attended: false } };
    expect(
      derive({
        eligibility: noAttendanceStages,
        steps: steps({ meeting_booked: outcome("2026-06-01T00:00:00.000Z") }),
      }),
    ).toBeNull();
  });

  it("a lead with an unconfirmed CRM pairing is held back", () => {
    expect(derive({ positiveReplyAt: "2026-05-01T00:00:00.000Z", pairingUnconfirmed: true })).toBeNull();
  });

  it("an undated booking has no silence to measure", () => {
    expect(derive({ steps: steps({ meeting_booked: outcome(null) }) })).toBeNull();
  });

  it("a funnel without a meeting step is never reached by the rule", () => {
    expect(
      derive({ funnelSteps: ["website_visit", "signup", "sale"], positiveReplyAt: "2026-05-01T00:00:00.000Z" }),
    ).toBeNull();
  });

  it("earlierInstant picks the earlier of two instants", () => {
    expect(earlierInstant(null, "2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(earlierInstant("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
  });
});
