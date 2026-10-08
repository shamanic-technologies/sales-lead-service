import { describe, expect, it } from "vitest";
import {
  clickLabel,
  conversationTags,
  hostOf,
  outcomeLabel,
  replyLabel,
  type TimelineItem,
} from "../../src/lib/timeline-labels.js";
import type { ReplyVerdict } from "../../src/lib/reply-verdicts-client.js";

function verdict(over: Partial<ReplyVerdict>): ReplyVerdict {
  return {
    kind: "k",
    classification: null,
    producerType: "model",
    producer: "p",
    attribution: "a",
    confidence: null,
    decidedAt: null,
    automatedAnswer: false,
    stopRequested: false,
    notOurTarget: false,
    handedToPerson: false,
    ...over,
  };
}

let n = 0;
function item(label: TimelineItem["label"], at: string | null, over: Partial<TimelineItem> = {}): TimelineItem {
  n += 1;
  return {
    id: `i${n}`,
    label,
    source: "reply",
    occurredAt: at,
    attributable: true,
    attributionBasis: "reaction_to_our_email",
    campaignId: null,
    offerId: null,
    url: null,
    withdrawnAt: null,
    ...over,
  };
}

describe("a reply is placed from the provider's flags, never a kind name", () => {
  it("reads Christina's 'We are good, thanks.' (negative) as not_interested", () => {
    expect(replyLabel(verdict({ classification: "negative" }))).toBe("not_interested");
  });
  it("places every flag, machine answers and stop requests first", () => {
    expect(replyLabel(verdict({ automatedAnswer: true, classification: "positive" }))).toBe("auto_reply");
    expect(replyLabel(verdict({ stopRequested: true, classification: "negative" }))).toBe("opt_out");
    expect(replyLabel(verdict({ notOurTarget: true, classification: "negative" }))).toBe("wrong_contact");
    expect(replyLabel(verdict({ handedToPerson: true, classification: "neutral" }))).toBe("hand_over");
    expect(replyLabel(verdict({ classification: "positive" }))).toBe("interested");
    expect(replyLabel(verdict({ classification: "neutral" }))).toBe("question");
    expect(replyLabel(verdict({}))).toBe("reply");
  });
  it("writes nothing for a reply nobody judged yet", () => {
    expect(replyLabel(null)).toBeNull();
  });
});

describe("a reply is placed from the provider's finer distinctions (owner vocabulary 2026-10-08)", () => {
  it("splits not-our-target: an existing client is a paid client, a role change is changed_job", () => {
    expect(replyLabel(verdict({ notOurTarget: true, notOurTargetReason: "already_customer" }))).toBe("paid_client");
    expect(replyLabel(verdict({ notOurTarget: true, notOurTargetReason: "left_role" }))).toBe("changed_job");
    expect(replyLabel(verdict({ notOurTarget: true, notOurTargetReason: "wrong_contact" }))).toBe("wrong_contact");
  });
  it("splits a hand-over into referral and other proposal", () => {
    expect(replyLabel(verdict({ handedToPerson: true, handoffReason: "referral" }))).toBe("referral");
    expect(replyLabel(verdict({ handedToPerson: true, handoffReason: "unrelated_proposal" }))).toBe("other_proposal");
    expect(replyLabel(verdict({ handedToPerson: true }))).toBe("hand_over");
  });
  it("reads a plain no off declinedOffer", () => {
    expect(replyLabel(verdict({ classification: "neutral", declinedOffer: true }))).toBe("not_interested");
  });
  it("splits a question by the Jev judgment: answer now, or escalate to the user", () => {
    expect(replyLabel(verdict({ classification: "positive", positiveSignal: "information_request" }), { question: { value: "answerable" } })).toBe("question_answerable");
    expect(replyLabel(verdict({ classification: "neutral" }), { question: { value: "needs_sender_company" } })).toBe("question_to_escalate");
    expect(replyLabel(verdict({ classification: "neutral" }), { question: { value: "none" } })).toBe("question");
    expect(replyLabel(verdict({ classification: "positive", positiveSignal: "meeting_request" }))).toBe("interested");
  });
});

describe("a click is placed by where it went", () => {
  it("on the brand's site (or a subdomain) is a website visit, anywhere else a link click", () => {
    const hosts = ["acme.com", "book.acme.io"];
    expect(clickLabel("https://www.acme.com/pricing?utm=x", hosts)).toBe("website_visit");
    expect(clickLabel("https://app.acme.com/", hosts)).toBe("website_visit");
    expect(clickLabel("https://calendly.com/acme/30min", hosts)).toBe("link_click");
    expect(clickLabel("not a url at all", hosts)).toBe("link_click");
  });
  it("with no URL recorded is the measured visit, as the standing reads it", () => {
    expect(clickLabel(null, [])).toBe("website_visit");
  });
  it("normalizes hosts", () => {
    expect(hostOf("WWW.Acme.com")).toBe("acme.com");
    expect(hostOf("https://www.acme.com/x")).toBe("acme.com");
  });
});

describe("a step outcome is placed", () => {
  it("maps every outcome word, legacy purchase included, and nothing else", () => {
    expect(outcomeLabel("sale")).toBe("paid_client");
    expect(outcomeLabel("purchase")).toBe("paid_client");
    expect(outcomeLabel("form_submission")).toBe("form_filled");
    expect(outcomeLabel("meeting_booked")).toBe("meeting_booked");
    expect(outcomeLabel("meeting_attended")).toBe("meeting_attended");
    expect(outcomeLabel("website_visit")).toBe("website_visit");
    expect(outcomeLabel("deal_lost")).toBeNull();
  });
});

describe("the conversation's tags", () => {
  it("Christina: three emails then a no -> last word not_interested, furthest step contacted", () => {
    const tags = conversationTags([
      item("initial_email", "2026-09-30T10:00:00Z"),
      item("followup", "2026-10-03T10:00:00Z"),
      item("followup", "2026-10-07T10:00:00Z"),
      item("not_interested", "2026-10-07T22:13:00Z"),
    ]);
    expect(tags).toEqual({
      lastWord: "not_interested",
      lastWordAt: "2026-10-07T22:13:00Z",
      furthestStep: "contacted",
      furthestStepAttributable: true,
    });
  });

  it("a later yes moves the last word back to interested", () => {
    const tags = conversationTags([item("not_interested", "2026-10-01T00:00:00Z"), item("interested", "2026-10-05T00:00:00Z")]);
    expect(tags.lastWord).toBe("interested");
    expect(tags.furthestStep).toBe("conversation_ongoing");
  });

  it("a question after an interest keeps the interest; a no replaces it", () => {
    expect(conversationTags([item("interested", "2026-10-01T00:00:00Z"), item("question", "2026-10-02T00:00:00Z")]).lastWord).toBe("interested");
    expect(conversationTags([item("interested", "2026-10-01T00:00:00Z"), item("not_interested", "2026-10-02T00:00:00Z")]).lastWord).toBe("not_interested");
  });

  it("an opt-out is sticky, whatever is said after", () => {
    const tags = conversationTags([item("opt_out", "2026-10-01T00:00:00Z"), item("interested", "2026-10-02T00:00:00Z")]);
    expect(tags).toMatchObject({ lastWord: "opted_out", lastWordAt: "2026-10-01T00:00:00Z" });
  });

  it("a machine's answer is not a word", () => {
    expect(conversationTags([item("auto_reply", "2026-10-01T00:00:00Z")]).lastWord).toBe("no_reply");
  });

  it("an existing client reads paid_client, not ours", () => {
    const tags = conversationTags([
      item("initial_email", "2026-10-01T00:00:00Z"),
      item("paid_client", "2026-10-02T00:00:00Z", { source: "reply_statement", attributable: false, attributionBasis: "person" }),
    ]);
    expect(tags).toMatchObject({ furthestStep: "paid_client", furthestStepAttributable: false });
  });

  it("orders the furthest step by the owner's ladder, form before booking", () => {
    expect(conversationTags([item("meeting_booked", null), item("form_filled", null)]).furthestStep).toBe("meeting_booked");
    expect(conversationTags([item("website_visit", null), item("interested", null)]).furthestStep).toBe("conversation_ongoing");
  });

  it("a withdrawn item says nothing", () => {
    const tags = conversationTags([item("paid_client", "2026-10-02T00:00:00Z", { withdrawnAt: "2026-10-03T00:00:00Z" })]);
    expect(tags).toEqual({ lastWord: "no_reply", lastWordAt: null, furthestStep: null, furthestStepAttributable: null });
  });
});
