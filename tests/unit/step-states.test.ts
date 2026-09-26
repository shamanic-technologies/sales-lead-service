import { describe, it, expect } from "vitest";
import { resolveStepStates, type StatedNever, type StatedOutcome } from "../../src/lib/step-states.js";
import {
  STEP_ORDER,
  entryOfLeg,
  legOf,
  stepsOnlyThrough,
  stepsRequiredBefore,
} from "../../src/lib/step-graph.js";
import { LEAD_STEP_OUTCOMES, type LeadStepOutcomeName } from "../../src/lib/step-statements.js";

function outcome(partial: Partial<StatedOutcome> = {}): StatedOutcome {
  return {
    source: "manual",
    valueCents: null,
    costCents: null,
    causedByOutreach: null,
    note: null,
    statedByUserId: "user-1",
    at: "2026-08-20T10:00:00.000Z",
    ...partial,
  };
}
function never(partial: Partial<StatedNever> = {}): StatedNever {
  return { costCents: null, note: null, statedByUserId: "user-1", at: "2026-08-20T10:00:00.000Z", ...partial };
}

function states(
  outcomes: Array<[LeadStepOutcomeName, StatedOutcome]> = [],
  nevers: Array<[LeadStepOutcomeName, StatedNever]> = [],
) {
  const resolved = resolveStepStates({
    allSteps: LEAD_STEP_OUTCOMES,
    outcomes: new Map(outcomes),
    nevers: new Map(nevers),
  });
  return Object.fromEntries(resolved.map((s) => [s.step, s]));
}

describe("the leg graph", () => {
  it("derives what every path to a step goes through from the legs alone", () => {
    expect(stepsRequiredBefore("meeting_attended")).toEqual(["meeting_booked"]);
    expect(stepsRequiredBefore("signup")).toEqual(["website_visit"]);
    // A reply can close on its own, so paying goes through nothing in particular.
    expect(stepsRequiredBefore("sale")).toEqual([]);
    // An ad can deliver a booked meeting or a form, so neither needs a site visit.
    expect(stepsRequiredBefore("meeting_booked")).toEqual([]);
    expect(stepsRequiredBefore("form_submission")).toEqual([]);
    expect(stepsOnlyThrough("meeting_booked")).toEqual(["meeting_attended"]);
    expect(stepsOnlyThrough("website_visit")).toEqual(["signup"]);
    expect(stepsOnlyThrough("sale")).toEqual([]);
  });

  it("knows exactly the statable step vocabulary, and nothing else", () => {
    expect([...STEP_ORDER].sort()).toEqual([...LEAD_STEP_OUTCOMES].sort());
  });

  it("orders steps shallowest first", () => {
    expect(STEP_ORDER[0]).toBe("website_visit");
    expect(STEP_ORDER[STEP_ORDER.length - 1]).toBe("sale");
    expect(STEP_ORDER.indexOf("meeting_booked")).toBeLessThan(STEP_ORDER.indexOf("meeting_attended"));
  });

  it("looks a leg up by its key, legacy spellings included, and never parses one", () => {
    expect(legOf("start_to_conversation")).toMatchObject({ from: null, to: "conversation" });
    expect(legOf("website_visit_to_form_filled")?.legKey).toBe("website_visit_to_form_submitted");
    expect(legOf("website_visit_to_nowhere")).toBeNull();
    expect(legOf(null)).toBeNull();
  });

  it("says where a campaign's leads enter, and what is reachable from there", () => {
    const reply = entryOfLeg(legOf("start_to_conversation")!);
    expect(reply).toMatchObject({ step: "conversation_reply", measure: "positive_reply" });
    expect(reply.reachableSteps).toEqual(["meeting_booked", "meeting_attended", "sale"]);

    const visit = entryOfLeg(legOf("start_to_website_visit")!);
    expect(visit).toMatchObject({ step: "website_visit", measure: "delivery_click" });
    expect(visit.reachableSteps).toContain("website_visit");
    expect(visit.reachableSteps).toContain("signup");

    // An internal leg picks leads up at its FROM step.
    expect(entryOfLeg(legOf("conversation_to_meeting_booked")!)).toMatchObject({
      step: "conversation_reply",
      measure: "positive_reply",
    });
    // An ad-delivered entry is observed by nothing here.
    expect(entryOfLeg(legOf("start_to_meeting_booked")!).measure).toBeNull();
  });
});

describe("a never constrains every step only reachable through it", () => {
  it("a lead that will never book will never attend — and may still pay off a reply", () => {
    const s = states([], [["meeting_booked", never()]]);
    expect(s.meeting_booked).toMatchObject({ state: "never", origin: "stated" });
    expect(s.meeting_attended).toMatchObject({
      state: "never",
      origin: "implied",
      impliedBy: "meeting_booked",
      statedByUserId: null,
      note: null,
      at: null,
      costCents: null,
    });
    expect(s.sale.state).toBe("pending");
  });

  it("reaches nothing BEFORE it", () => {
    const s = states([], [["signup", never()]]);
    expect(s.website_visit.state).toBe("pending");
    expect(s.sale.state).toBe("pending");
  });

  it("a never on the site visit closes the signup, which only a visit leads to", () => {
    const s = states([], [["website_visit", never()]]);
    expect(s.signup).toMatchObject({ state: "never", origin: "implied", impliedBy: "website_visit" });
    expect(s.form_submission.state).toBe("pending");
  });
});

describe("an outcome constrains every step all paths to it go through", () => {
  it("a lead that attended booked", () => {
    const s = states([["meeting_attended", outcome()]]);
    expect(s.meeting_booked).toMatchObject({
      state: "outcome",
      origin: "implied",
      impliedBy: "meeting_attended",
      source: null,
      statedByUserId: null,
      at: null,
    });
  });

  it("a sale implies nothing, because a reply can close on its own", () => {
    const s = states([["sale", outcome()]]);
    expect(s.meeting_booked.state).toBe("pending");
    expect(s.meeting_attended.state).toBe("pending");
    expect(s.website_visit.state).toBe("pending");
  });

  it("an outcome beats a never it contradicts, and the never is still readable", () => {
    const s = states([["meeting_attended", outcome()]], [["meeting_booked", never()]]);
    expect(s.meeting_booked).toMatchObject({
      state: "outcome",
      origin: "implied",
      statedState: "never",
    });
  });

  it("a contradicted never does not propagate", () => {
    const s = states([["signup", outcome()]], [["website_visit", never()]]);
    expect(s.website_visit).toMatchObject({ state: "outcome", origin: "implied" });
    expect(s.signup).toMatchObject({ state: "outcome", origin: "stated" });
  });
});

describe("a step nobody spoke about", () => {
  it("is pending and carries nothing", () => {
    const s = states();
    for (const step of LEAD_STEP_OUTCOMES) {
      expect(s[step]).toMatchObject({ state: "pending", origin: null, impliedBy: null, statedState: null });
    }
  });

  it("answers every step, in the fixed vocabulary order", () => {
    const resolved = resolveStepStates({ allSteps: LEAD_STEP_OUTCOMES, outcomes: new Map(), nevers: new Map() });
    expect(resolved.map((r) => r.step)).toEqual([...LEAD_STEP_OUTCOMES]);
  });
});
