import { describe, it, expect } from "vitest";

// The TAG is the label a conversation carries (the Unibox shows it). It is lead-service's to give
// (owner 2026-10-08) and it says what the person actually did. It is not the standing STATE: a
// website visit stays a degree of `sales_interest` in every count and board, and only the tag
// names it for what it is.

import { entryOfLeg, legOf, type LegEntry } from "../../src/lib/step-graph.js";
import { resolveStepStates } from "../../src/lib/step-states.js";
import {
  LEAD_STANDING_STATES,
  LEAD_STANDING_TAGS,
  resolveLeadStanding,
  type LeadStandingDelivery,
} from "../../src/lib/lead-standing.js";
import { LEAD_STEP_OUTCOMES, type LeadStepOutcomeName } from "../../src/lib/step-statements.js";
import { LeadStandingSchema } from "../../src/schemas.js";

const QUIET: LeadStandingDelivery = {
  contacted: true,
  opened: false,
  clicked: false,
  replied: false,
  replyClassification: null,
  bounced: false,
  unsubscribed: false,
  globalBounced: false,
  globalUnsubscribed: false,
};
const CLICKED_AT = "2026-10-06T15:46:51.451Z";
const STATED_AT = "2026-02-02T00:00:00.000Z";

function stand(args: {
  leg: string;
  delivery?: Partial<LeadStandingDelivery>;
  outcomes?: Partial<Record<LeadStepOutcomeName, "manual" | "tracker">>;
}) {
  const entry: LegEntry = entryOfLeg(legOf(args.leg)!);
  const outcomes = new Map(
    Object.entries(args.outcomes ?? {}).map(([step, source]) => [
      step as LeadStepOutcomeName,
      { source: source as "manual" | "tracker", valueCents: null, costCents: null, note: null, statedByUserId: null, at: STATED_AT },
    ]),
  );
  return resolveLeadStanding({
    lifecycleStatus: "served",
    deliveryQueried: true,
    delivery: { ...QUIET, ...args.delivery },
    entry,
    entryUnresolvedReason: null,
    steps: resolveStepStates({ allSteps: LEAD_STEP_OUTCOMES, outcomes, nevers: new Map() }),
  });
}

describe("the tag a conversation carries", () => {
  it("names a click-only lead a website visit, dated by the click, on a campaign entering at the site", () => {
    const s = stand({ leg: "start_to_website_visit", delivery: { clicked: true, firstClickedAt: CLICKED_AT } });
    expect(s.state).toBe("sales_interest");
    expect(s.tag).toBe("website_visit");
    expect(s.at).toBe(CLICKED_AT);
  });

  it("names a click-only lead a website visit, dated by the click, on a campaign working replies", () => {
    const s = stand({ leg: "start_to_conversation", delivery: { clicked: true, firstClickedAt: CLICKED_AT } });
    expect(s.state).toBe("sales_interest");
    expect(s.tag).toBe("website_visit");
    expect(s.at).toBe(CLICKED_AT);
  });

  it("names a hand-stated visit a website visit, dated by the statement", () => {
    const s = stand({ leg: "start_to_conversation", outcomes: { website_visit: "manual" } });
    expect(s.state).toBe("sales_interest");
    expect(s.tag).toBe("website_visit");
    expect(s.at).toBe(STATED_AT);
  });

  it("keeps sales_interest for a positive reply, even beside a click", () => {
    const s = stand({
      leg: "start_to_conversation",
      delivery: { clicked: true, firstClickedAt: CLICKED_AT, replied: true, replyClassification: "positive" },
    });
    expect(s.tag).toBe("sales_interest");
  });

  it("keeps sales_interest for a step deeper than the visit", () => {
    const s = stand({ leg: "start_to_website_visit", delivery: { clicked: true }, outcomes: { meeting_booked: "manual" } });
    expect(s.state).toBe("sales_interest");
    expect(s.tag).toBe("sales_interest");
  });

  it("is the state itself for every other state", () => {
    expect(stand({ leg: "start_to_conversation" }).tag).toBe("contacted");
    expect(stand({ leg: "start_to_conversation", delivery: { unsubscribed: true, clicked: true } }).tag).toBe("opted_out");
    expect(stand({ leg: "start_to_conversation", outcomes: { sale: "manual" } }).tag).toBe("customer");
  });

  it("serves a closed vocabulary: every state plus website_visit", () => {
    expect([...LEAD_STANDING_TAGS].sort()).toEqual([...LEAD_STANDING_STATES, "website_visit"].sort());
    const s = stand({ leg: "start_to_website_visit", delivery: { clicked: true, firstClickedAt: CLICKED_AT } });
    expect(LeadStandingSchema.parse({ ...s, wentCold: null, replies: null }).tag).toBe("website_visit");
  });
});
