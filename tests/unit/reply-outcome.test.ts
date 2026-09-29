import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { leadReplyOutcome, offerKeyOf, readReplies } from "../../src/lib/reply-outcome.js";
import { replyDelivery, withUnrecordedReplyStatement } from "../../src/lib/lead-standing-resolver.js";
import { resolveLeadStanding, salesInterestStage, type LeadStandingDelivery } from "../../src/lib/lead-standing.js";
import { entryOfLeg, legOf } from "../../src/lib/step-graph.js";
import { resolveStepStates } from "../../src/lib/step-states.js";
import { LEAD_STEP_OUTCOMES } from "../../src/lib/step-statements.js";
import type { ReplyVerdictView } from "../../src/lib/reply-verdicts-client.js";

// What a person's replies MEAN for them as a lead, rolled up from every reply's own verdict. The
// cases are the production ones that forced it (instantly-service replies table, 2026-09-29).

const BRAND = "brand-living-vital";
const OTHER_BRAND = "brand-other";
const CAMP_A = "camp-a"; // sells offer A
const CAMP_A2 = "camp-a2"; // also sells offer A (another channel)
const CAMP_B = "camp-b"; // sells offer B
const CAMP_NO_OFFER = "camp-none"; // states no offer
const OFFERS = new Map<string, string | null>([
  [CAMP_A, "offer-a"],
  [CAMP_A2, "offer-a"],
  [CAMP_B, "offer-b"],
  [CAMP_NO_OFFER, null],
]);


/** instantly-service's per-verdict flags, as it derives them for these kinds (test fixtures only). */
function flagsOf(kind: string) {
  return {
    automatedAnswer: kind === "lead_out_of_office" || kind === "auto_reply_received",
    stopRequested: kind === "lead_opt_out_requested",
    notOurTarget: kind === "lead_wrong_person" || kind === "lead_changed_job",
  };
}

let seq = 0;
function reply(
  receivedAt: string,
  kind: string | null,
  classification: "positive" | "negative" | "neutral" | null,
  over: Partial<ReplyVerdictView> = {},
): ReplyVerdictView {
  seq += 1;
  return {
    replyId: `r-${seq}`,
    leadEmail: "p@example.com",
    instantlyCampaignId: "i",
    campaignId: CAMP_A,
    brandIds: [BRAND],
    transport: "instantly",
    fromEmail: "p@example.com",
    subject: null,
    receivedAt,
    verdict:
      kind === null
        ? null
        : { kind, classification, producerType: "model", producer: "m", attribution: "exact", confidence: null, decidedAt: receivedAt, ...flagsOf(kind) },
    verdictCount: kind === null ? 0 : 1,
    ...over,
  };
}

const OOO = ["lead_out_of_office", "neutral"] as const;
const REFERRAL = ["lead_referral", "neutral"] as const;
const OFF_TOPIC = ["lead_off_topic", "neutral"] as const;
const INTERESTED = ["lead_interested", "positive"] as const;
const NOT_NOW = ["lead_not_interested", "negative"] as const;
const STOP = ["lead_opt_out_requested", "negative"] as const;
const WRONG_PERSON = ["lead_wrong_person", "negative"] as const;

const BASE_DELIVERY: LeadStandingDelivery = {
  contacted: true,
  opened: false,
  clicked: false,
  replied: true,
  // What the ONE coarse value per (campaign x lead) says — deliberately wrong-looking in the cases
  // below: it is the latest verdict of any kind, which is exactly what hid replies.
  replyClassification: "neutral",
  disqualified: false,
  bounced: false,
  unsubscribed: false,
  globalBounced: false,
  globalUnsubscribed: false,
};

function standingFor(
  replies: ReplyVerdictView[],
  rowCampaignId = CAMP_A,
  opts: { leg?: string; base?: Partial<LeadStandingDelivery>; ledgerAt?: string | null } = {},
) {
  const baseDelivery = { ...BASE_DELIVERY, ...opts.base };
  const outcome = withUnrecordedReplyStatement(
    leadReplyOutcome({ replies, rowCampaignId, rowBrandIds: [BRAND], offers: OFFERS }),
    baseDelivery,
  );
  const delivery = replyDelivery(
    baseDelivery,
    outcome,
    opts.ledgerAt !== undefined && opts.ledgerAt !== null,
    opts.ledgerAt ?? null,
  );
  const leg = legOf(opts.leg ?? "start_to_conversation");
  const standing = resolveLeadStanding({
    lifecycleStatus: "served",
    deliveryQueried: true,
    delivery,
    entry: leg ? entryOfLeg(leg) : null,
    entryUnresolvedReason: null,
    steps: resolveStepStates({ allSteps: LEAD_STEP_OUTCOMES, outcomes: new Map(), nevers: new Map() }),
    replies: outcome,
  });
  return { outcome, standing };
}

describe("the rollup — two readings kept apart", () => {
  // AC 1. elena.staeheli@biopartner.ch: an out-of-office on 09-24, her referral on 09-28. The coarse
  // value per (campaign x lead) was overwritten by whichever verdict came last and read the OOO.
  it("the latest REAL reply decides now; an out-of-office never overrides it", () => {
    const replies = [
      reply("2026-09-24T11:10:37Z", ...OOO),
      reply("2026-09-28T04:52:00Z", ...REFERRAL),
    ];
    const r = readReplies(replies);
    expect(r.latest?.kind).toBe("lead_referral");
    expect(r.latest?.receivedAt).toBe("2026-09-28T04:52:00Z");
    expect(r.realReplies).toBe(1);
    expect(r.machineReplies).toBe(1);
  });

  it("an out-of-office that arrives AFTER a real reply does not displace it either", () => {
    const r = readReplies([reply("2026-09-20T00:00:00Z", ...NOT_NOW), reply("2026-09-21T00:00:00Z", ...OOO)]);
    expect(r.latest?.kind).toBe("lead_not_interested");
  });

  it("a person who only ever sent machine answers has no latest reply", () => {
    const r = readReplies([reply("2026-09-20T00:00:00Z", ...OOO)]);
    expect(r.latest).toBeNull();
    expect(r.realReplies).toBe(0);
  });

  // AC 3. cynthia@springspine.net: "interested" at 17:04, "not interested" at 17:22 the same day.
  it("a positive reply then a later 'not now': reached interest, and now reads not interested", () => {
    const r = readReplies([
      reply("2026-09-24T17:22:34Z", ...NOT_NOW),
      reply("2026-09-24T17:04:11Z", ...INTERESTED),
    ]);
    expect(r.reached.positive).toBe("2026-09-24T17:04:11Z");
    expect(r.reached.negative).toBe("2026-09-24T17:22:34Z");
    expect(r.latest?.classification).toBe("negative");
  });

  it("a reply nobody has judged yet decides nothing and is counted as such", () => {
    const r = readReplies([reply("2026-09-20T00:00:00Z", ...INTERESTED), reply("2026-09-21T00:00:00Z", null, null)]);
    expect(r.latest?.kind).toBe("lead_interested");
    expect(r.unjudgedReplies).toBe(1);
    expect(r.replies).toBe(2);
  });

  it("opt-out is sticky: nothing written after it undoes it", () => {
    const r = readReplies([reply("2026-09-01T00:00:00Z", ...STOP), reply("2026-09-10T00:00:00Z", ...INTERESTED)]);
    expect(r.optedOutAt).toBe("2026-09-01T00:00:00Z");
    expect(r.latest?.kind).toBe("lead_interested");
  });
});

describe("the grains — offer and brand", () => {
  it("interest on offer A says nothing about offer B", () => {
    const replies = [reply("2026-09-01T00:00:00Z", ...INTERESTED, { campaignId: CAMP_A })];
    const onB = leadReplyOutcome({ replies, rowCampaignId: CAMP_B, rowBrandIds: [BRAND], offers: OFFERS });
    expect(onB.offer.latest).toBeNull();
    expect(onB.offer.reached.positive).toBeNull();
    expect(onB.brand.reached.positive).toBe("2026-09-01T00:00:00Z");
  });

  it("two campaigns selling the same offer read as one offer", () => {
    const replies = [reply("2026-09-01T00:00:00Z", ...INTERESTED, { campaignId: CAMP_A2 })];
    const onA = leadReplyOutcome({ replies, rowCampaignId: CAMP_A, rowBrandIds: [BRAND], offers: OFFERS });
    expect(onA.offerKey).toBe("offer:offer-a");
    expect(onA.offer.latest?.kind).toBe("lead_interested");
  });

  it("a campaign stating no offer is its own grain; an unknown campaign borrows nothing", () => {
    expect(offerKeyOf(CAMP_NO_OFFER, OFFERS)).toBe(`campaign:${CAMP_NO_OFFER}`);
    expect(offerKeyOf("camp-unknown", OFFERS)).toBeNull();
    expect(offerKeyOf(CAMP_A, null)).toBeNull();
  });

  it("the brand grain only reads replies under the row's brands", () => {
    const replies = [reply("2026-09-01T00:00:00Z", ...STOP, { brandIds: [OTHER_BRAND] })];
    const o = leadReplyOutcome({ replies, rowCampaignId: CAMP_A, rowBrandIds: [BRAND], offers: OFFERS });
    expect(o.brand.optedOutAt).toBeNull();
  });
});

describe("the standing reads it", () => {
  it("AC 1 — elena: her referral is the latest real reply, and it is a hand-over, not interest", () => {
    const { outcome, standing } = standingFor([
      reply("2026-09-24T11:10:37Z", ...OOO),
      reply("2026-09-28T04:52:00Z", ...REFERRAL),
    ]);
    expect(outcome.offer.latest?.kind).toBe("lead_referral");
    expect(standing.replies?.offer.latest?.kind).toBe("lead_referral");
    expect(standing.state).toBe("engaged");
    expect(standing.signal).toBe("reply");
  });

  it("an off-topic reply is a hand-over too, never interest", () => {
    const { standing } = standingFor([reply("2026-09-24T00:00:00Z", ...OFF_TOPIC)]);
    expect(standing.state).toBe("engaged");
  });

  // AC 2. drmichellemcelroy@aginggracefully.co wrote "Stop" on one campaign of the brand.
  it("AC 2 — an opt-out reply opts the person out on EVERY offer of the brand", () => {
    const replies = [reply("2026-09-24T13:38:10Z", ...STOP, { campaignId: CAMP_A })];
    for (const campaign of [CAMP_A, CAMP_B, CAMP_NO_OFFER]) {
      const { standing } = standingFor(replies, campaign);
      expect(standing.state).toBe("opted_out");
      expect(standing.signal).toBe("opt_out_reply");
    }
  });

  it("an opt-out holds over a later positive reply", () => {
    const { standing } = standingFor([
      reply("2026-09-01T00:00:00Z", ...STOP),
      reply("2026-09-10T00:00:00Z", ...INTERESTED),
    ]);
    expect(standing.state).toBe("opted_out");
  });

  it("AC 3 — cynthia: reached interest (stats), not interested now (standing)", () => {
    const { standing } = standingFor([
      reply("2026-09-24T17:04:11Z", ...INTERESTED),
      reply("2026-09-24T17:22:34Z", ...NOT_NOW),
    ]);
    expect(standing.reachedEntryStep).toBe(true);
    expect(standing.state).toBe("engaged");
    expect(standing.signal).toBe("negative_reply");
  });

  it("the latest real reply positive -> sales interest at the conversation", () => {
    const { standing } = standingFor([
      reply("2026-09-20T00:00:00Z", ...NOT_NOW),
      reply("2026-09-22T00:00:00Z", ...INTERESTED),
      reply("2026-09-23T00:00:00Z", ...OOO),
    ]);
    expect(standing.state).toBe("sales_interest");
    expect(standing.signal).toBe("positive_reply");
    expect(salesInterestStage(standing)).toBe("conversation_reply");
  });

  it("interest on offer A leaves the offer-B row where it was", () => {
    const { standing } = standingFor([reply("2026-09-22T00:00:00Z", ...INTERESTED, { campaignId: CAMP_A })], CAMP_B);
    expect(standing.state).toBe("contacted");
    expect(standing.reachedEntryStep).toBe(false);
  });

  it("the wrong person is disqualified on the offer; a later 'not now' is not", () => {
    expect(standingFor([reply("2026-09-22T00:00:00Z", ...WRONG_PERSON)]).standing.state).toBe("disqualified");
    const later = standingFor([
      reply("2026-09-22T00:00:00Z", ...WRONG_PERSON),
      reply("2026-09-23T00:00:00Z", ...NOT_NOW),
    ]).standing;
    expect(later.state).toBe("engaged");
    expect(later.signal).toBe("negative_reply");
  });

  it("machine answers alone are not a reply: the lead reads contacted", () => {
    const { standing } = standingFor([reply("2026-09-22T00:00:00Z", ...OOO)]);
    expect(standing.state).toBe("contacted");
  });

  it("a visit keeps interest on a reply leg while the latest reply is a decline — staged at the visit", () => {
    const { standing } = standingFor(
      [reply("2026-09-20T00:00:00Z", ...INTERESTED), reply("2026-09-21T00:00:00Z", ...NOT_NOW)],
      CAMP_A,
      { base: { clicked: true } },
    );
    expect(standing.state).toBe("sales_interest");
    expect(standing.signal).toBe("measured_visit");
    expect(salesInterestStage(standing)).toBe("website_visit");
  });

  it("their CRM's positive reply dated after the latest real reply decides now", () => {
    const { standing } = standingFor([reply("2026-09-20T00:00:00Z", ...NOT_NOW)], CAMP_A, {
      ledgerAt: "2026-09-25T00:00:00Z",
    });
    expect(standing.state).toBe("sales_interest");
  });

  it("their CRM's positive reply dated before a later decline counts as reached only", () => {
    const { standing } = standingFor([reply("2026-09-20T00:00:00Z", ...NOT_NOW)], CAMP_A, {
      ledgerAt: "2026-09-10T00:00:00Z",
    });
    expect(standing.state).toBe("engaged");
    expect(standing.reachedEntryStep).toBe(true);
  });
});

// Owner-decided 2026-09-29: a plain neutral reply after a positive one does NOT cancel interest.
// joanie@aimforwellness.com asked for a meeting at 15:06 and wrote a neutral reply at 15:09.
describe("a neutral reply keeps an interest; a decline, a stop or a hand-over replaces it", () => {
  const NEUTRAL = ["lead_neutral", "neutral"] as const;
  it("positive then neutral: still interest now, and the neutral reply is the last one written", () => {
    const r = readReplies([
      reply("2026-09-28T15:06:39Z", "lead_meeting_requested", "positive"),
      reply("2026-09-28T15:09:15Z", ...NEUTRAL),
    ]);
    expect(r.latest?.kind).toBe("lead_meeting_requested");
    expect(r.lastRealReply?.kind).toBe("lead_neutral");
    const { standing } = standingFor([
      reply("2026-09-28T15:06:39Z", "lead_meeting_requested", "positive"),
      reply("2026-09-28T15:09:15Z", ...NEUTRAL),
    ]);
    expect(standing.state).toBe("sales_interest");
  });

  it.each([
    ["a decline", NOT_NOW, "engaged"],
    ["a referral", REFERRAL, "engaged"],
    ["an off-topic reply", OFF_TOPIC, "engaged"],
    ["a stop request", STOP, "opted_out"],
  ])("positive then %s: replaced", (_label, kind, state) => {
    const { outcome, standing } = standingFor([
      reply("2026-09-20T00:00:00Z", ...INTERESTED),
      reply("2026-09-21T00:00:00Z", ...kind),
    ]);
    expect(outcome.offer.latest?.kind).toBe(kind[0]);
    expect(standing.state).toBe(state);
  });

  it("a neutral reply with no interest before it decides now as before", () => {
    const r = readReplies([reply("2026-09-20T00:00:00Z", ...NOT_NOW), reply("2026-09-21T00:00:00Z", ...NEUTRAL)]);
    expect(r.latest?.kind).toBe("lead_neutral");
  });

  it("positive, neutral, then a decline: the decline replaces it", () => {
    const r = readReplies([
      reply("2026-09-20T00:00:00Z", ...INTERESTED),
      reply("2026-09-21T00:00:00Z", ...NEUTRAL),
      reply("2026-09-22T00:00:00Z", ...NOT_NOW),
    ]);
    expect(r.latest?.kind).toBe("lead_not_interested");
  });
});

// A reply somebody recorded BY HAND, whose message was never mirrored: instantly-service keeps its
// verdict in bronze attributed to no reply, so the per-reply layer holds nothing for that person.
// Measured at ship (2026-09-29): 16 leads, e.g. jason@uhmedical.com stated interested on 09-03.
describe("a reply recorded by hand, never mirrored as a message", () => {
  it("the delivery layer's positive statement stands, and says where it came from", () => {
    const { outcome, standing } = standingFor([], CAMP_A, { base: { replyClassification: "positive" } });
    expect(outcome.offerEvidence).toBe("delivery_statement");
    expect(standing.state).toBe("sales_interest");
    expect(standing.reachedEntryStep).toBe(true);
  });

  it("a stated 'wrong person' stands as disqualified", () => {
    const { standing } = standingFor([], CAMP_A, { base: { replyClassification: "negative", disqualified: true } });
    expect(standing.state).toBe("disqualified");
  });

  it("a stated positive after an out-of-office message stands too", () => {
    const { outcome, standing } = standingFor([reply("2026-09-01T00:00:00Z", ...OOO)], CAMP_A, {
      base: { replyClassification: "positive" },
    });
    expect(outcome.offerEvidence).toBe("delivery_statement");
    expect(standing.state).toBe("sales_interest");
  });

  it("a NEUTRAL coarse value is not taken: that is what an out-of-office overwrites it with", () => {
    const { outcome, standing } = standingFor([], CAMP_A, { base: { replyClassification: "neutral" } });
    expect(outcome.offerEvidence).toBe("replies");
    expect(standing.state).toBe("contacted");
  });

  it("a person's reply in the per-reply layer always wins over the coarse value", () => {
    const { outcome, standing } = standingFor([reply("2026-09-01T00:00:00Z", ...NOT_NOW)], CAMP_A, {
      base: { replyClassification: "positive" },
    });
    expect(outcome.offerEvidence).toBe("replies");
    expect(standing.state).toBe("engaged");
  });
});

// The reply vocabulary is instantly-service's. This service reads the classification it serves and
// names exactly the kinds it must act on, in ONE module — a second list elsewhere is how it drifts.
describe("the reply vocabulary is not copied", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
  }
  it("reply-outcome.ts names only the hand-over pair no flag carries yet", () => {
    const src = readFileSync(join(__dirname, "../../src/lib/reply-outcome.ts"), "utf8");
    const named = new Set(
      [...src.matchAll(/["'](lead_[a-z_]+|auto_reply_received)["']/g)].map((m) => m[1]),
    );
    expect([...named].sort()).toEqual(["lead_off_topic", "lead_referral"]);
  });

  it("no reply kind is named outside reply-outcome.ts", () => {
    const kind = /["'](lead_(interested|referral|info_requested|meeting_requested|not_interested|wrong_person|changed_job|opt_out_requested|neutral|off_topic|out_of_office)|auto_reply_received)["']/;
    const offenders = walk(join(__dirname, "../../src"))
      .filter((p) => !p.endsWith("reply-outcome.ts"))
      .filter((p) => kind.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
