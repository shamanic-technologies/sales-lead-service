import { describe, it, expect } from "vitest";
import { entryOfLeg, legOf, STEP_ORDER } from "../../src/lib/step-graph.js";
import {
  parseSalesInterestStageFilter,
  resolveLeadStanding,
  salesInterestStage,
  SALES_INTEREST_STAGES,
  type LeadStandingInput,
} from "../../src/lib/lead-standing.js";
import type { StepReadState } from "../../src/lib/step-states.js";

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
  return {
    lifecycleStatus: "served",
    deliveryQueried: true,
    delivery,
    entry: entryOfLeg(legOf("start_to_conversation")!),
    entryUnresolvedReason: null,
    steps: STEP_ORDER.map(
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
  it("is the campaign's entry when only the positive reply was reached", () => {
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

describe("SALES_INTEREST_STAGES", () => {
  it("lists the entries and every statable step short of the sale, shallowest first", () => {
    expect(SALES_INTEREST_STAGES[0]).toBe("conversation_reply");
    expect(SALES_INTEREST_STAGES).not.toContain("sale");
    expect(SALES_INTEREST_STAGES.indexOf("meeting_booked")).toBeLessThan(
      SALES_INTEREST_STAGES.indexOf("meeting_attended"),
    );
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
