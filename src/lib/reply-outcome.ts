/**
 * What a person's REPLIES mean for them as a lead — at two grains, lead x OFFER and lead x BRAND,
 * built from the per-reply verdicts instantly-service serves (reply-verdicts-client.ts).
 *
 * Why this exists. The reply half of a lead's standing used to be read off ONE coarse value per
 * (campaign x lead), which instantly-service overwrote with whichever verdict arrived last. An
 * out-of-office verdict therefore hid a real referral reply for a week (elena.staeheli@biopartner.ch,
 * 2026-09-24 -> 09-28). Every reply now carries its own current verdict, so the meaning is rolled up
 * here from all of them, under the owner's rules:
 *
 *   - TWO READINGS, KEPT APART. `latest` answers "what do we do NOW": the latest REAL reply decides,
 *     and a machine answer (an out-of-office, an auto-reply) is not a reply and never overrides one.
 *     `reached` answers "what has this lead REACHED": a positive reply on 09-10 still counts as
 *     reached interest after a "not now" on 09-20. A consumer picks the reading its question asks.
 *   - OPT-OUT IS STICKY AND BRAND-WIDE. Once a person asked us to stop, `optedOutAt` holds for every
 *     offer of the brand, whatever they write after. The brand reading carries it; the resolver reads
 *     it from there, never from the offer reading alone.
 *   - INTEREST AND DISQUALIFICATION ARE PER OFFER. Interested in offer A says nothing about offer B,
 *     so the offer reading is what decides them.
 *   - A REFERRAL OR AN OFF-TOPIC REPLY IS A HAND-OVER TO A HUMAN, NEVER INTEREST. Nothing here names
 *     them: instantly-service's own classification already reports both as `neutral`, and interest is
 *     read off `classification === "positive"` and nothing else.
 *
 * WHAT IS READ, WHAT IS NOT. The reply vocabulary is instantly-service's and is NOT copied here: the
 * coarse `classification` it serves decides interest, and the kind is read for exactly the three
 * facts the classification cannot carry and this service must act on (`reply-kind-facts` below):
 * whether a MACHINE answered, whether the person asked us to STOP, and whether the reply says they
 * are the WRONG PERSON for us (a fact about the person, not the moment). A kind this service does not
 * name is a real reply judged by its classification — never guessed into one of the three.
 *
 * A reply nobody has judged yet (`verdict: null`) is counted (`unjudgedReplies`) and decides nothing:
 * whether it is even a real reply is unknown until it is judged, and instantly-service judges within
 * minutes. Nothing is re-derived from a reply's text here — that is the producer's job.
 */
import type { ReplyVerdictView } from "./reply-verdicts-client.js";

/**
 * The only reply kinds this service acts on by name — each a fact instantly-service's coarse
 * classification cannot express. Everything else is read through `classification`.
 */
const MACHINE_ANSWER_KINDS: ReadonlySet<string> = new Set(["lead_out_of_office", "auto_reply_received"]);
const STOP_REQUEST_KINDS: ReadonlySet<string> = new Set(["lead_opt_out_requested"]);
const NOT_OUR_TARGET_KINDS: ReadonlySet<string> = new Set(["lead_wrong_person", "lead_changed_job"]);

/** True iff a machine answered, not the person (an out-of-office, an auto-reply). */
export function isMachineAnswer(kind: string): boolean {
  return MACHINE_ANSWER_KINDS.has(kind);
}
/** True iff the person asked us to stop contacting them. */
export function isStopRequest(kind: string): boolean {
  return STOP_REQUEST_KINDS.has(kind);
}
/** True iff the reply says they are not who we sell to (wrong contact, gone from the role). */
export function isNotOurTarget(kind: string): boolean {
  return NOT_OUR_TARGET_KINDS.has(kind);
}

/** The reply that decides "what do we do now". */
export interface LatestReply {
  replyId: string;
  receivedAt: string;
  campaignId: string | null;
  kind: string;
  classification: "positive" | "negative" | "neutral" | null;
  /** Who judged it: `human` | `instantly` | `model`, verbatim from instantly-service. */
  producerType: string;
}

/** What a set of replies means, at one grain. */
export interface ReplyReading {
  /** Every reply at this grain, judged or not, machine or person. */
  replies: number;
  /** Replies a PERSON wrote (judged, and not a machine answer). */
  realReplies: number;
  /** Replies a machine wrote (out-of-office, auto-reply). */
  machineReplies: number;
  /** Replies nobody has judged yet — they decide nothing until judged. */
  unjudgedReplies: number;
  /** "What do we do now": the latest real reply, or null when the person has written none. */
  latest: LatestReply | null;
  /** "What has this lead reached": when each classification was FIRST seen among real replies. */
  reached: {
    positive: string | null;
    negative: string | null;
    neutral: string | null;
  };
  /** When the person FIRST asked us to stop, or null. Sticky: nothing written after undoes it. */
  optedOutAt: string | null;
}

/** A lead's reply outcome at both grains, as one row reads it. */
export interface LeadReplyOutcome {
  /**
   * Which offer the row's campaign sells (`offer:<id>`), or the campaign itself (`campaign:<id>`)
   * when it states no offer, or null when the campaign is unknown — then the offer reading is
   * empty rather than borrowed from another offer.
   */
  offerKey: string | null;
  offer: ReplyReading;
  brand: ReplyReading;
}

function instant(iso: string): number {
  return Date.parse(iso);
}

/** Roll up ONE set of replies (already narrowed to one grain). Order of the input is irrelevant. */
export function readReplies(replies: readonly ReplyVerdictView[]): ReplyReading {
  const sorted = [...replies].sort(
    (a, b) => instant(a.receivedAt) - instant(b.receivedAt) || a.replyId.localeCompare(b.replyId),
  );
  const reading: ReplyReading = {
    replies: sorted.length,
    realReplies: 0,
    machineReplies: 0,
    unjudgedReplies: 0,
    latest: null,
    reached: { positive: null, negative: null, neutral: null },
    optedOutAt: null,
  };
  for (const r of sorted) {
    const v = r.verdict;
    if (!v) {
      reading.unjudgedReplies++;
      continue;
    }
    if (isMachineAnswer(v.kind)) {
      reading.machineReplies++;
      continue;
    }
    reading.realReplies++;
    // Ascending order, so the last real reply seen is the latest one.
    reading.latest = {
      replyId: r.replyId,
      receivedAt: r.receivedAt,
      campaignId: r.campaignId,
      kind: v.kind,
      classification: v.classification,
      producerType: v.producerType,
    };
    if (v.classification && reading.reached[v.classification] === null) {
      reading.reached[v.classification] = r.receivedAt;
    }
    if (isStopRequest(v.kind) && reading.optedOutAt === null) reading.optedOutAt = r.receivedAt;
  }
  return reading;
}

/** The offer key a campaign reads under — see `LeadReplyOutcome.offerKey`. */
export function offerKeyOf(
  campaignId: string | null,
  offers: ReadonlyMap<string, string | null> | null,
): string | null {
  if (!campaignId || !offers || !offers.has(campaignId)) return null;
  const offerId = offers.get(campaignId);
  return offerId ? `offer:${offerId}` : `campaign:${campaignId}`;
}

/**
 * A person's reply outcome as ONE membership row reads it: the brand reading over every reply the
 * person sent under any of the row's brands, the offer reading over the ones sent on a campaign
 * selling the same offer as the row's campaign.
 */
export function leadReplyOutcome(input: {
  /** This person's replies, org-wide. */
  replies: readonly ReplyVerdictView[];
  rowCampaignId: string;
  rowBrandIds: readonly string[];
  /** campaign -> offer id (null = states none). null when campaign-service could not be read. */
  offers: ReadonlyMap<string, string | null> | null;
}): LeadReplyOutcome {
  const brandReplies = input.replies.filter((r) =>
    r.brandIds.some((b) => input.rowBrandIds.includes(b)),
  );
  const offerKey = offerKeyOf(input.rowCampaignId, input.offers);
  const offerReplies =
    offerKey === null
      ? []
      : brandReplies.filter((r) => offerKeyOf(r.campaignId, input.offers) === offerKey);
  return { offerKey, offer: readReplies(offerReplies), brand: readReplies(brandReplies) };
}
