/**
 * UNIBOX-INTEREST-1102: what Jev reads of OUR OUTREACH thread. A reply of theirs is a line written by them (`in`) with
 * the reply's own verdict as the outreach copy states it; an answer of ours in that thread is `out` with who wrote it.
 * Before, a reply was a bare label ("question") and Jev read "I would like to learn more about what you can do for us"
 * as 0.42, Unsure.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));

const { outreachLineOf, threadLinesOf } = await import("../../src/lib/relationship-subjects.js");

const row = (over: Record<string, unknown>) => ({ label: "x", occurred_at: "2026-11-02T13:22:45Z", source: "outreach", verdict: null, sent_by: null, subject: null, ...over });

describe("our outreach thread as Jev reads it", () => {
  it("a reply carries its verdict: the classification, the buying signal, and only the flags that are true", () => {
    const line = outreachLineOf(row({
      label: "question", source: "reply", subject: "Re: custom software",
      verdict: { classification: "positive", positiveSignal: "information_request", stopRequested: false, declinedOffer: false, notOurTargetReason: null, kind: "lead_info_requested", producer: "deepseek-flash" },
    }));
    expect(line).toEqual({
      label: "replied (question)", occurred_at: "2026-11-02T13:22:45Z", source: "reply", direction: "in",
      detail: { subject: "Re: custom software", replyVerdict: { classification: "positive", positiveSignal: "information_request" } },
    });
  });

  it("a reply not yet classified is still THEIR line", () => {
    expect(outreachLineOf(row({ label: "auto_reply", source: "reply" }))).toMatchObject({ label: "replied (auto_reply)", direction: "in", detail: null });
  });

  it("an answer of ours names who wrote it: our automated responder or a person of the brand", () => {
    expect(outreachLineOf(row({ source: "reply_sent", sent_by: "automation", subject: "Re: x" }))).toMatchObject({
      label: "answered them in the thread", direction: "out", detail: { subject: "Re: x", writtenBy: "the brand's automated responder" },
    });
    expect(outreachLineOf(row({ source: "reply_sent", sent_by: "human" })).detail).toEqual({ writtenBy: "a person of the brand" });
    expect(outreachLineOf(row({ source: "reply_sent", sent_by: null })).detail).toEqual({});
  });

  it("a sequence label stays as it was: no direction, no detail", () => {
    expect(outreachLineOf(row({ label: "initial_email", source: "outreach", subject: "ignored" }))).toEqual({ label: "initial_email", occurred_at: "2026-11-02T13:22:45Z", source: "outreach" });
  });

  it("the thread line keeps the direction and detail", () => {
    const [line] = threadLinesOf([], [outreachLineOf(row({ label: "interested", source: "reply", verdict: { classification: "positive" } }))]);
    expect(line).toEqual({
      at: "2026-11-02T13:22:45.000Z", source: "our_outreach:reply", kind: "replied (interested)", direction: "in", text: null,
      detail: { replyVerdict: { classification: "positive" } },
    });
  });
});
