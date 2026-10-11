import { describe, expect, it } from "vitest";
import { awaitingReplyOf, type ConversationEvent } from "../../src/lib/awaiting-reply.js";
import { factEvent } from "../../src/lib/awaiting-reply-read.js";
import type { TimelineItemLabel } from "../../src/lib/timeline-labels.js";

const inbound = (at: string, label: TimelineItemLabel, ref = at): ConversationEvent => ({
  type: "inbound", at, label, campaignId: "c1", subject: "Re: hi", ref,
});
const answer = (at: string): ConversationEvent => ({ type: "answer", at, via: "replies_route" });

describe("awaitingReplyOf", () => {
  it("a question nobody answered waits since it arrived, whatever its age", () => {
    const r = awaitingReplyOf([inbound("2026-08-14T14:16:41Z", "question_to_escalate")]);
    expect(r).toMatchObject({
      waitingSince: "2026-08-14T14:16:41.000Z",
      lastMessage: { kind: "question", label: "question_to_escalate", campaignId: "c1" },
      lastAnsweredAt: null,
      unansweredMessages: 1,
    });
  });

  it("an answer of ours after their message takes them out; a new message puts them back", () => {
    const events = [inbound("2026-10-06T17:08:29Z", "interested"), answer("2026-10-07T09:00:00Z")];
    expect(awaitingReplyOf(events)).toBeNull();
    const back = awaitingReplyOf([...events, inbound("2026-10-08T10:00:00Z", "question")]);
    expect(back).toMatchObject({ waitingSince: "2026-10-08T10:00:00.000Z", lastAnsweredAt: "2026-10-07T09:00:00.000Z" });
  });

  it("a statement 'answered outside' is an answer like any other", () => {
    expect(awaitingReplyOf([inbound("2026-10-06T17:08:29Z", "question"), { type: "answer", at: "2026-10-11T08:00:00Z", via: "answered_outside" }])).toBeNull();
  });

  it("waits since the FIRST unanswered message, kind of the LATEST", () => {
    const r = awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "interested"), inbound("2026-10-03T00:00:00Z", "question")]);
    expect(r).toMatchObject({ waitingSince: "2026-10-01T00:00:00.000Z", lastMessage: { kind: "question" }, unansweredMessages: 2 });
  });

  it("a last word that asks nothing of us waits on nobody", () => {
    expect(awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "interested"), inbound("2026-10-02T00:00:00Z", "not_interested")])).toBeNull();
    expect(awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "wrong_contact")])).toBeNull();
  });

  it("an automatic answer is not their word", () => {
    const r = awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "interested"), inbound("2026-10-02T00:00:00Z", "auto_reply")]);
    expect(r).toMatchObject({ lastMessage: { label: "interested" }, unansweredMessages: 1 });
  });

  it("an opt-out is sticky, before or after", () => {
    expect(awaitingReplyOf([{ type: "opt_out", at: "2026-09-01T00:00:00Z" }, inbound("2026-10-01T00:00:00Z", "interested")])).toBeNull();
    expect(awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "interested"), { type: "opt_out", at: "2026-10-02T00:00:00Z" }])).toBeNull();
  });

  it("referral / proposal / hand-over are 'other'", () => {
    expect(awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "referral")])?.lastMessage.kind).toBe("other");
    expect(awaitingReplyOf([inbound("2026-10-01T00:00:00Z", "hand_over")])?.lastMessage.kind).toBe("other");
  });

  it("nothing said = not waiting (website visitors never enter)", () => {
    expect(awaitingReplyOf([])).toBeNull();
    expect(awaitingReplyOf([answer("2026-10-01T00:00:00Z")])).toBeNull();
  });
});

describe("factEvent", () => {
  const base = { subject_key: "s", occurred_at: "2026-10-06 17:08:29+00", lead_email: "x@y.z", campaign_id: "c" };
  const verdict = {
    classification: "positive", automatedAnswer: false, stopRequested: false, notOurTarget: false, handedToPerson: false,
    positiveSignal: "information_request", declinedOffer: false, notOurTargetReason: null, handoffReason: null,
  };

  it("places a reply with the timeline's label (Lukas: an information request only the sender can answer)", () => {
    const e = factEvent({ ...base, type: "reply", raw: { reply: { subject: "Re: B2B", verdict, judgments: { question: { value: "needs_sender_company" } } } } });
    expect(e).toMatchObject({ type: "inbound", label: "question_to_escalate", subject: "Re: B2B", at: "2026-10-06T17:08:29.000Z" });
  });

  it("a reply with no verdict yet says nothing", () => {
    expect(factEvent({ ...base, type: "reply", raw: { reply: { subject: null, verdict: null } } })).toBeNull();
  });

  it("a stop request and an unsubscribe are opt-outs", () => {
    expect(factEvent({ ...base, type: "reply", raw: { reply: { verdict: { ...verdict, stopRequested: true } } } })).toMatchObject({ type: "opt_out" });
    expect(factEvent({ ...base, type: "unsubscribed", raw: {} })).toMatchObject({ type: "opt_out" });
  });

  it("every reply_sent is an answer, whichever way it went", () => {
    for (const via of ["replies_route", "staff_client", "provider_unibox"]) {
      expect(factEvent({ ...base, type: "reply_sent", raw: { replySent: { via, sentBy: "human" } } })).toMatchObject({ type: "answer", via });
    }
  });

  it("a sequence email is not an answer", () => {
    expect(factEvent({ ...base, type: "email_sent", raw: {} })).toBeNull();
  });
});
