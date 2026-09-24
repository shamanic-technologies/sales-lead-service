import { describe, it, expect } from "vitest";
import { FUNNEL_ENTRY, FUNNEL_KEYS, FUNNEL_STEPS } from "../../src/lib/funnel-steps.js";
import {
  parseSalesInterestStageFilter,
  resolveLeadStanding,
  salesInterestStage,
  salesInterestStagesOf,
  SALES_INTEREST_STAGES,
  type LeadStandingInput,
} from "../../src/lib/lead-standing.js";
import type { StepReadState } from "../../src/lib/step-funnel-state.js";

const delivery = {
  contacted: true,
  opened: true,
  clicked: false,
  replied: true,
  replyClassification: "positive" as const,
  disqualified: false,
  bounced: false,
  unsubscribed: false,
  globalBounced: false,
  globalUnsubscribed: false,
};

function input(outcomes: string[]): LeadStandingInput {
  const key = "sales_meetings_from_conversation";
  const steps = FUNNEL_STEPS[key];
  return {
    lifecycleStatus: "served",
    deliveryQueried: true,
    delivery,
    funnel: { key, steps, entry: FUNNEL_ENTRY[key] },
    funnelUnresolvedReason: null,
    steps: steps.map(
      (step) =>
        ({
          step,
          state: outcomes.includes(step) ? "outcome" : "pending",
          origin: "stated",
          source: "manual",
        }) as unknown as StepReadState,
    ),
  };
}

describe("salesInterestStage", () => {
  it("is the funnel's entry when only the positive reply was reached", () => {
    const standing = resolveLeadStanding(input([]));
    expect(standing.state).toBe("sales_interest");
    expect(salesInterestStage(standing)).toBe("conversation_reply");
  });

  it("is the deepest step reached, never an earlier one", () => {
    expect(salesInterestStage(resolveLeadStanding(input(["meeting_booked"])))).toBe("meeting_booked");
    expect(
      salesInterestStage(resolveLeadStanding(input(["meeting_booked", "meeting_attended"]))),
    ).toBe("meeting_attended");
  });

  it("is null outside sales_interest — a sale is a customer, not a stage", () => {
    const standing = resolveLeadStanding(input(["meeting_booked", "meeting_attended", "sale"]));
    expect(standing.state).toBe("customer");
    expect(salesInterestStage(standing)).toBeNull();
  });
});

describe("salesInterestStagesOf", () => {
  it("walks the conversation funnel entry-first, short of its last step", () => {
    const k = "sales_meetings_from_conversation";
    expect(salesInterestStagesOf(FUNNEL_ENTRY[k], FUNNEL_STEPS[k])).toEqual([
      "conversation_reply",
      "meeting_booked",
      "meeting_attended",
    ]);
  });

  it("names a visit-led funnel's entry once", () => {
    const k = "form_magnet";
    expect(salesInterestStagesOf(FUNNEL_ENTRY[k], FUNNEL_STEPS[k])).toEqual([
      "website_visit",
      "form_submission",
    ]);
  });

  it("leaves out an ad click nothing here can observe", () => {
    const k = "sales_meetings_from_ads";
    expect(salesInterestStagesOf(FUNNEL_ENTRY[k], FUNNEL_STEPS[k])).toEqual([
      "meeting_booked",
      "meeting_attended",
    ]);
  });

  it("only ever names stages the filter accepts", () => {
    for (const k of FUNNEL_KEYS) {
      for (const stage of salesInterestStagesOf(FUNNEL_ENTRY[k], FUNNEL_STEPS[k])) {
        expect(SALES_INTEREST_STAGES).toContain(stage);
      }
    }
  });
});

describe("parseSalesInterestStageFilter", () => {
  it("reads absent as no filter and a list as one set", () => {
    expect(parseSalesInterestStageFilter(undefined)).toBeNull();
    expect(parseSalesInterestStageFilter("meeting_booked, meeting_attended,meeting_booked")).toEqual([
      "meeting_booked",
      "meeting_attended",
    ]);
  });

  it("refuses an unknown or empty value", () => {
    expect(() => parseSalesInterestStageFilter("sale")).toThrow("Unknown stage");
    expect(() => parseSalesInterestStageFilter(" , ")).toThrow();
    expect(() => parseSalesInterestStageFilter(["a"])).toThrow();
  });
});
