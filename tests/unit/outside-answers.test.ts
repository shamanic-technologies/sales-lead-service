import { describe, expect, it } from "vitest";
import { outsideAnswerCandidates, judgmentState } from "../../src/lib/outside-answers.js";
import type { MailboxConversation, MailboxMessage } from "../../src/lib/mailbox-client.js";

function msg(over: Partial<MailboxMessage>): MailboxMessage {
  return {
    gmailMessageId: "g1", threadId: "t1", direction: "outbound", fromEmail: "kevin@distribute.you", fromName: null,
    to: ["lukas@stankamera.com"], subject: "Re: hello", snippet: "snip", sentAt: "2026-10-11T12:49:35.000Z", labels: ["SENT"],
    bodyText: "We are distribute.you", bodyHtml: null, bodyStatus: "ok", ...over,
  };
}
function conv(...messages: MailboxMessage[]): MailboxConversation {
  return {
    address: "lukas@stankamera.com", status: "ok", threadCount: 1, messageCount: messages.length, truncated: false,
    threads: [{ threadId: "t1", subject: null, firstMessageAt: null, lastMessageAt: null, messageCount: messages.length, messages }],
  };
}
const SINCE = "2026-10-06T17:08:29.000Z";

describe("outsideAnswerCandidates", () => {
  it("keeps an email of ours to the person sent after they wrote (the Lukas case)", () => {
    const c = outsideAnswerCandidates("Lukas@StanKamera.com", SINCE, [{ mailbox: "org", conversation: conv(msg({})) }]);
    expect(c).toEqual([{ gmailMessageId: "g1", mailbox: "org", fromEmail: "kevin@distribute.you", sentAt: "2026-10-11T12:49:35.000Z", subject: "Re: hello", text: "We are distribute.you" }]);
  });

  it("drops their own messages, emails before they wrote, and emails to someone else in the thread", () => {
    const c = outsideAnswerCandidates("lukas@stankamera.com", SINCE, [{
      mailbox: "org",
      conversation: conv(
        msg({ gmailMessageId: "in", direction: "inbound", fromEmail: "lukas@stankamera.com", to: ["kevin@distribute.you"] }),
        msg({ gmailMessageId: "early", sentAt: "2026-10-01T00:00:00Z" }),
        msg({ gmailMessageId: "other", to: ["someone@else.com"] }),
        msg({ gmailMessageId: "undated", sentAt: null }),
      ),
    }]);
    expect(c).toEqual([]);
  });

  it("one candidate per Gmail message across both mirrors, the org copy kept, oldest first", () => {
    const c = outsideAnswerCandidates("lukas@stankamera.com", SINCE, [
      { mailbox: "org", conversation: conv(msg({ gmailMessageId: "b", sentAt: "2026-10-12T00:00:00Z" }), msg({ gmailMessageId: "a" })) },
      { mailbox: "staff", conversation: conv(msg({ gmailMessageId: "a" }), msg({ gmailMessageId: "s", sentAt: "2026-10-07T00:00:00Z" })) },
      { mailbox: "staff", conversation: null },
    ]);
    expect(c.map((x) => [x.gmailMessageId, x.mailbox])).toEqual([["s", "staff"], ["a", "org"], ["b", "org"]]);
  });

  it("states what they wrote and what we sent to Jev, nothing else", () => {
    const [ours] = outsideAnswerCandidates("lukas@stankamera.com", SINCE, [{ mailbox: "staff", conversation: conv(msg({})) }]);
    expect(judgmentState([{ at: SINCE, subject: "Re: B2B", text: "Which company are you?", label: "question_to_escalate" }], ours)).toEqual({
      theirMessages: [{ sentAt: SINCE, subject: "Re: B2B", text: "Which company are you?", whatTheyAsked: "question_to_escalate" }],
      ourEmail: { sentAt: "2026-10-11T12:49:35.000Z", from: "kevin@distribute.you", subject: "Re: hello", text: "We are distribute.you" },
    });
  });
});
