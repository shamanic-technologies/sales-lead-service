import { describe, it, expect } from "vitest";

// Where a lead stands is COMMERCIAL POLICY, and this is the whole of it. Everything here is about
// the ladder in src/lib/lead-standing.ts: which evidence outranks which, what a click means on a
// campaign that sells a visit versus one that sells a reply, and what is answered when a signal
// cannot be resolved at all.

import { entryOfLeg, legOf, type LegEntry } from "../../src/lib/step-graph.js";
import { resolveStepStates } from "../../src/lib/step-states.js";
import {
  resolveLeadStanding,
  type LeadStandingDelivery,
} from "../../src/lib/lead-standing.js";
import {
  LEAD_STEP_OUTCOMES,
  type LeadStepOutcomeName,
} from "../../src/lib/step-statements.js";

const QUIET: LeadStandingDelivery = {
  contacted: false,
  opened: false,
  clicked: false,
  replied: false,
  replyClassification: null,
  bounced: false,
  unsubscribed: false,
  globalBounced: false,
  globalUnsubscribed: false,
};

function leg(key: string): LegEntry {
  return entryOfLeg(legOf(key)!);
}
const VISIT = "start_to_website_visit";
const REPLY = "start_to_conversation";
const AD_MEETING = "start_to_meeting_booked";

interface StandArgs {
  entry?: LegEntry | null;
  delivery?: Partial<LeadStandingDelivery>;
  status?: string;
  deliveryQueried?: boolean;
  outcomes?: Partial<Record<LeadStepOutcomeName, "manual" | "tracker">>;
  nevers?: LeadStepOutcomeName[];
}

function stand(args: StandArgs = {}) {
  const f = args.entry === undefined ? leg(VISIT) : args.entry;
  const outcomes = new Map(
    Object.entries(args.outcomes ?? {}).map(([step, source]) => [
      step as LeadStepOutcomeName,
      {
        source: source as "manual" | "tracker",
        valueCents: null,
        costCents: null,
        note: null,
        statedByUserId: null,
        at: "2026-02-02T00:00:00.000Z",
      },
    ]),
  );
  const nevers = new Map(
    (args.nevers ?? []).map((step) => [
      step,
      { costCents: null, note: null, statedByUserId: null, at: "2026-02-02T00:00:00.000Z" },
    ]),
  );
  return resolveLeadStanding({
    lifecycleStatus: args.status ?? "served",
    deliveryQueried: args.deliveryQueried ?? true,
    delivery: { ...QUIET, ...args.delivery },
    entry: f,
    entryUnresolvedReason: f ? null : "leg_unstated",
    steps: resolveStepStates({
      allSteps: LEAD_STEP_OUTCOMES,
      outcomes,
      nevers,
    }),
  });
}

describe("where a lead stands on the campaign it was served under", () => {
  // THE CASE. A Form Magnet campaign sells visit -> form -> paid; 67 people clicked through to the
  // customer's site and the board showed nobody under Sales interest, because the only per-lead
  // triage anyone had read a positive REPLY and this campaign prices no reply.
  it("counts a website visit on a campaign whose funnel is entered by one", () => {
    const s = stand({ entry: leg(VISIT), delivery: { contacted: true, clicked: true } });
    expect(s.state).toBe("sales_interest");
    expect(s.reachedEntryStep).toBe(true);
    expect(s.entryStep).toBe("website_visit");
    expect(s.entryMeasure).toBe("delivery_click");
    expect(s.legKey).toBe(VISIT);
    expect(s.reason).toBeNull();
  });

  // The other half of funnel-awareness, and the reason it is not simply "a click is intent".
  it("does NOT count the same click on a campaign whose funnel prices a reply, not a visit", () => {
    const s = stand({
      entry: leg(REPLY),
      delivery: { contacted: true, clicked: true },
    });
    expect(s.state).toBe("engaged");
    expect(s.signal).toBe("click");
    expect(s.reachedEntryStep).toBe(false);
    expect(s.entryStep).toBe("conversation_reply");
  });

  it("counts a positive reply on a conversation-led funnel, and not on a visit-led one", () => {
    const conversation = stand({
      entry: leg(REPLY),
      delivery: { contacted: true, replied: true, replyClassification: "positive" },
    });
    expect(conversation.state).toBe("sales_interest");
    expect(conversation.signal).toBe("positive_reply");

    const visit = stand({
      entry: leg(VISIT),
      delivery: { contacted: true, replied: true, replyClassification: "positive" },
    });
    expect(visit.state).toBe("engaged");
    expect(visit.reachedEntryStep).toBe(false);
  });

  // The same person, two campaigns: the (lead, campaign) grain is what lets both answers be true.
  it("lets the same signals stand differently under two campaigns", () => {
    const delivery = { contacted: true, clicked: true };
    expect(stand({ entry: leg(VISIT), delivery }).state).toBe("sales_interest");
    expect(stand({ entry: leg(REPLY), delivery }).state).toBe("engaged");
  });

  describe("precedence", () => {
    // No-go, and it is the one rule with no exception anywhere in the ladder.
    it("lets NOTHING override an unsubscribe — not a click, not a stated sale", () => {
      const s = stand({
        delivery: { contacted: true, clicked: true, unsubscribed: true },
        outcomes: { sale: "manual" },
      });
      expect(s.state).toBe("opted_out");
      expect(s.signal).toBe("unsubscribed");
      // Both facts stay true and readable: they DID reach the entry step, and they DID opt out.
      expect(s.reachedEntryStep).toBe(true);
    });

    it("honours a global unsubscribe the same as a scoped one", () => {
      expect(stand({ delivery: { contacted: true, globalUnsubscribed: true } }).state).toBe(
        "opted_out",
      );
    });

    // The board draws an opt-out and a disqualification as two columns with different copy and
    // different moves, so the two must never collapse into one state.
    it("keeps an opt-out apart from a commercial disqualification", () => {
      const optedOut = stand({ delivery: { contacted: true, unsubscribed: true } });
      const wrongContact = stand({
        delivery: { contacted: true, replied: true, replyClassification: "negative", disqualified: true },
      });
      expect(optedOut.state).toBe("opted_out");
      expect(wrongContact.state).toBe("disqualified");
      expect(optedOut.state).not.toBe(wrongContact.state);
    });

    it("puts a human statement above every machine signal", () => {
      const s = stand({
        delivery: { contacted: true, replied: true, replyClassification: "negative" },
        outcomes: { form_submission: "manual" },
      });
      expect(s.state).toBe("sales_interest");
      expect(s.signal).toBe("stated_outcome");
      expect(s.origin).toBe("stated");
      expect(s.deepestStep).toBe("form_submission");
      expect(s.at).toBe("2026-02-02T00:00:00.000Z");
    });

    it("reads the funnel's last step reached as a customer", () => {
      const s = stand({ delivery: { contacted: true }, outcomes: { sale: "manual" } });
      expect(s.state).toBe("customer");
      expect(s.deepestStep).toBe("sale");
    });

    // The leg graph's own rule, applied to the standing: an outcome implies every step all paths to
    // it go through.
    it("reads an implied step exactly as a stated one, and says it was implied", () => {
      const s = stand({ delivery: { contacted: true }, outcomes: { signup: "manual" } });
      expect(s.state).toBe("sales_interest");
      // website_visit is implied by the signup; the deepest reached step is still the signup.
      expect(s.deepestStep).toBe("signup");
    });

    it("reads a never on the sale as disqualified", () => {
      const late = stand({ delivery: { contacted: true }, nevers: ["sale"] });
      expect(late.state).toBe("disqualified");
      expect(late.signal).toBe("stated_never");
      expect(late.origin).toBe("stated");
    });

    // The leg graph has no single path to the sale: a lead who will never visit the site can still
    // reply and buy, so a never on an earlier step does not close the sale.
    it("does not read a never on an earlier step as disqualified", () => {
      const early = stand({ delivery: { contacted: true }, nevers: ["website_visit"] });
      expect(early.state).toBe("contacted");
      const noMeeting = stand({ entry: leg(REPLY), delivery: { contacted: true }, nevers: ["meeting_booked"] });
      expect(noMeeting.state).toBe("contacted");
    });

    // A click on the campaign that sells a visit is a fact about the funnel; a classification is a
    // judgement about a message. The fact wins.
    it("puts the funnel's own entry step above a negative reply classification", () => {
      const s = stand({
        entry: leg(VISIT),
        delivery: { contacted: true, clicked: true, replied: true, replyClassification: "negative" },
      });
      expect(s.state).toBe("sales_interest");
      expect(s.signal).toBe("measured_visit");
    });

    // Disqualified means ONE thing: we realised this person is not our target — the wrong
    // contact, or gone from the role. It is ordinary sales qualification, and it is the only
    // reading of a reply that takes a lead out of play.
    it("disqualifies a reply the provider reads as permanently about the PERSON", () => {
      const s = stand({
        entry: leg(VISIT),
        delivery: {
          contacted: true,
          replied: true,
          replyClassification: "negative",
          disqualified: true,
        },
      });
      expect(s.state).toBe("disqualified");
      expect(s.signal).toBe("disqualifying_reply");
      expect(s.origin).toBe("measured");
    });

    // A decline is a judgement about the MOMENT. The person is still reachable and the lead is
    // still recyclable, so they stay in play and the "no" is named rather than used as a verdict.
    it("does NOT disqualify a decline about the moment — it stays in play", () => {
      const s = stand({
        entry: leg(VISIT),
        delivery: {
          contacted: true,
          replied: true,
          replyClassification: "negative",
          disqualified: false,
        },
      });
      expect(s.state).toBe("engaged");
      expect(s.signal).toBe("negative_reply");
    });

    // Absent is a third state and it is neither of the other two: "no" would be a claim this
    // service makes on the provider's behalf, "yes" is the bug this closes.
    it("states that it cannot tell when the provider serves no disqualification reading", () => {
      const s = stand({
        entry: leg(VISIT),
        delivery: { contacted: true, replied: true, replyClassification: "negative" },
      });
      expect(s.state).toBe("unresolved");
      expect(s.reason).toBe("reply_disqualification_unknown");
      expect(s.signal).toBe("negative_reply");
      expect(s.origin).toBeNull();
    });

    // A disqualifying reply is still a machine reading, so it sits exactly where the negative
    // reply always sat: below a human statement, and below the funnel's own entry step.
    it("keeps a permanent disqualification below a human statement and below the entry step", () => {
      const stated = stand({
        delivery: {
          contacted: true,
          replied: true,
          replyClassification: "negative",
          disqualified: true,
        },
        outcomes: { form_submission: "manual" },
      });
      expect(stated.state).toBe("sales_interest");
      expect(stated.signal).toBe("stated_outcome");

      const clicked = stand({
        entry: leg(VISIT),
        delivery: {
          contacted: true,
          clicked: true,
          replied: true,
          replyClassification: "negative",
          disqualified: true,
        },
      });
      expect(clicked.state).toBe("sales_interest");
      expect(clicked.signal).toBe("measured_visit");
    });

    // Being out of play by our judgement and being out of play by the prospect's own act are two
    // STATES, so a board can count and page each without reading a row's evidence.
    it("reads an opt-out as opted_out even when the provider also disqualifies them", () => {
      const out = stand({
        delivery: {
          contacted: true,
          unsubscribed: true,
          replied: true,
          replyClassification: "negative",
          disqualified: true,
        },
      });
      expect(out.state).toBe("opted_out");
      expect(out.signal).toBe("unsubscribed");
    });

    it("does NOT disqualify a bounce — it names it and leaves the person in play", () => {
      // A bad address says nothing about whether the human behind it would buy. It is a
      // failure of DELIVERY, so the lead stays contacted and the bounce is the evidence
      // rather than the verdict; the address is the thing to repair.
      const s = stand({ delivery: { contacted: true, bounced: true } });
      expect(s.state).toBe("contacted");
      expect(s.signal).toBe("bounced");
      // A global bounce reads the same way — it is the same fact about the address.
      const g = stand({ delivery: { contacted: true, globalBounced: true } });
      expect(g.state).toBe("contacted");
      expect(g.signal).toBe("bounced");
    });

    it("lets every signal above it outrank a bounce, so a later one cannot demote a lead", () => {
      // A bounce on a follow-up must not take back a visit the person already made, nor
      // a "no" they already said.
      const reached = stand({
        entry: leg(VISIT),
        delivery: { contacted: true, clicked: true, bounced: true },
      });
      expect(reached.state).toBe("sales_interest");
      const said = stand({
        entry: leg(VISIT),
        delivery: {
          contacted: true,
          replied: true,
          replyClassification: "negative",
          disqualified: true,
          bounced: true,
        },
      });
      expect(said.state).toBe("disqualified");
      expect(said.signal).toBe("disqualifying_reply");
    });

    it("still reads an OPT-OUT as opted_out, which is the prospect's own binding act", () => {
      const s = stand({ delivery: { contacted: true, unsubscribed: true, bounced: true } });
      expect(s.state).toBe("opted_out");
      expect(s.signal).toBe("unsubscribed");
    });

    it("walks down through engaged and contacted", () => {
      expect(stand({ delivery: { contacted: true, replied: true } }).signal).toBe("reply");
      expect(stand({ delivery: { contacted: true, replied: true } }).state).toBe("engaged");
      expect(stand({ delivery: { contacted: true, opened: true } }).signal).toBe("open");
      expect(stand({ delivery: { contacted: true } }).state).toBe("contacted");
      expect(stand({ delivery: {} }).state).toBe("not_contacted");
    });
  });

  describe("what is NOT answered", () => {
    // No-go: do not fabricate an answer for a lead nobody ever contacted.
    it("answers not_contacted for a row that was never served, and judges nothing further", () => {
      for (const status of ["buffered", "claimed", "skipped"]) {
        const s = stand({ status, delivery: { contacted: true, clicked: true } });
        expect(s.state).toBe("not_contacted");
        expect(s.signal).toBe("not_served");
      }
    });

    // No-go: a signal that cannot be resolved is stated as unresolved, never defaulted.
    it("says unresolved when the delivery layer was never asked", () => {
      const s = stand({ deliveryQueried: false });
      expect(s.state).toBe("unresolved");
      expect(s.reason).toBe("delivery_not_queried");
      expect(s.reachedEntryStep).toBeNull();
    });

    it("still answers from a stated outcome when the delivery layer was never asked", () => {
      const s = stand({ deliveryQueried: false, outcomes: { sale: "manual" } });
      expect(s.state).toBe("customer");
    });

    it("says unresolved when the campaign's leg could not be resolved", () => {
      const s = stand({ entry: null, delivery: { contacted: true, clicked: true } });
      expect(s.state).toBe("unresolved");
      expect(s.reason).toBe("leg_unstated");
      expect(s.legKey).toBeNull();
      expect(s.reachedEntryStep).toBeNull();
    });

    // An ad click is a real entry step this service holds no signal for. `false` would be a claim.
    it("answers null — never false — for an entry nothing here can observe", () => {
      const s = stand({
        entry: leg(AD_MEETING),
        delivery: { contacted: true, clicked: true },
      });
      expect(s.entryStep).toBe("meeting_booked");
      expect(s.entryMeasure).toBeNull();
      expect(s.reachedEntryStep).toBeNull();
      // The standing itself still says what IS known: they clicked, which is not the step sold.
      expect(s.state).toBe("engaged");
    });

    it("still says the entry step was reached on an ad-delivered entry when a step is stated", () => {
      const s = stand({
        entry: leg(AD_MEETING),
        delivery: { contacted: true },
        outcomes: { meeting_booked: "manual" },
      });
      expect(s.reachedEntryStep).toBe(true);
      expect(s.state).toBe("sales_interest");
    });
  });

  describe("the leg entry", () => {
    it("says where every entry leg puts leads, and what observes it", () => {
      expect(leg(VISIT)).toMatchObject({ step: "website_visit", measure: "delivery_click" });
      expect(leg(REPLY)).toMatchObject({ step: "conversation_reply", measure: "positive_reply" });
      expect(leg("start_to_form_submitted")).toMatchObject({ step: "form_submission", measure: null });
    });

    it("resolves a pre-merge leg spelling to the same entry", () => {
      expect(entryOfLeg(legOf("start_to_lead_form_submitted")!)).toEqual(leg("start_to_form_submitted"));
      expect(legOf("not_a_leg")).toBeNull();
    });
  });
});
