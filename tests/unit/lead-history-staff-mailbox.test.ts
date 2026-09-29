import { describe, it, expect } from "vitest";
import {
  assembleLeadHistory,
  type AssembleHistoryInput,
  type HistoryCampaignInput,
  type HistoryMessageEvent,
} from "../../src/lib/lead-history.js";
import type { MailboxConversation, MailboxMessage } from "../../src/lib/mailbox-client.js";

// The Doc Dinners / Jamie exchange as production holds it (2026-09-21): the outreach mirror of
// the sending mailbox (nina@) carries the sequence, Jamie's replies and a staff message the
// staff member Cc'd it on — labelled INBOUND by the provider. Kevin's first hand-written answer
// went to Jamie alone, so ONLY his own Gmail holds it.
const PROSPECT = "jamie@physio-denver.example";
const SENDER = "nina@veriskube.com";
const STAFF = "kevin@distribute.you";
const SUBJECT = "Re: physical therapy dinners in Denver";

function campaign(over: Partial<HistoryCampaignInput> = {}): HistoryCampaignInput {
  return {
    leadCampaignId: "lc-1",
    campaignId: "camp-1",
    status: "served",
    createdAt: "2026-09-21T13:00:00.000Z",
    servedAt: "2026-09-21T13:00:00.000Z",
    sentAt: null,
    followupDueAt: null,
    followupCount: 0,
    followupLastActionAt: null,
    followupStoppedReason: null,
    delivery: null,
    conversation: {
      ok: true,
      data: {
        campaignId: "camp-1",
        leadEmail: PROSPECT,
        accountEmail: SENDER,
        transport: "instantly",
        source: "mirror",
        messageCount: 5,
        messages: [
          { direction: "outbound", from: SENDER, to: PROSPECT, at: "2026-09-21T14:01:18.000Z", subject: "physical therapy dinners in Denver", text: "Hey Jamie, I represent a team" },
          { direction: "inbound", from: PROSPECT, to: SENDER, at: "2026-09-21T15:28:34.000Z", subject: SUBJECT, text: "A rough estimate will work for me." },
          { direction: "outbound", from: SENDER, to: PROSPECT, at: "2026-09-21T19:04:44.000Z", subject: SUBJECT, text: "Hi Jamie, I don't have a price" },
          { direction: "inbound", from: STAFF, to: PROSPECT, at: "2026-09-21T19:07:27.000Z", subject: SUBJECT, text: "(Ignore that last email)" },
          { direction: "inbound", from: PROSPECT, to: SENDER, at: "2026-09-21T20:40:50.000Z", subject: SUBJECT, text: "Not w/o an estimate of price." },
        ] as never,
      },
    },
    generation: { ok: true, data: null },
    ...over,
  };
}

function input(over: Partial<AssembleHistoryInput> = {}): AssembleHistoryInput {
  return {
    email: PROSPECT,
    campaigns: [campaign()],
    deliveryRead: { ok: true, data: null },
    mailbox: { ok: true, data: null },
    replyStatements: { ok: true, data: [] },
    optOuts: { ok: true, data: [] },
    statedOutcomes: [],
    statedNevers: [],
    trackerConversions: [],
    ...over,
  };
}

const gmail = (over: Partial<MailboxMessage>): MailboxMessage => ({
  gmailMessageId: "g",
  threadId: "t-1",
  direction: "outbound",
  fromEmail: STAFF,
  fromName: "Kevin",
  to: [PROSPECT],
  subject: SUBJECT,
  snippet: null,
  sentAt: null,
  labels: [],
  bodyText: null,
  bodyHtml: null,
  bodyStatus: "ok",
  ...over,
});

const staffConversation = (messages: MailboxMessage[]): { ok: true; data: MailboxConversation } => ({
  ok: true,
  data: {
    address: PROSPECT,
    status: "ok",
    threadCount: 1,
    messageCount: messages.length,
    truncated: false,
    threads: [
      {
        threadId: "t-1",
        subject: SUBJECT,
        firstMessageAt: messages[0]?.sentAt ?? null,
        lastMessageAt: messages[messages.length - 1]?.sentAt ?? null,
        messageCount: messages.length,
        messages,
      },
    ],
  },
});

const messagesOf = (events: ReturnType<typeof assembleLeadHistory>["events"]) =>
  events.filter((e): e is HistoryMessageEvent => e.type === "message");

describe("assembleLeadHistory — our staff's own Gmail", () => {
  const staff = staffConversation([
    gmail({
      gmailMessageId: "1a0c4958ca5cc940",
      direction: "inbound",
      fromEmail: PROSPECT,
      to: [SENDER],
      sentAt: "2026-09-21T15:28:34.000Z",
      // Gmail keeps the quoted tail the outreach mirror stripped: same message, different head.
      bodyText: "A rough estimate will work for me.\n\nOn Mon, Sep 21 Nina wrote: > Hi Jamie",
    }),
    gmail({
      gmailMessageId: "1a0c4a068c33960d",
      sentAt: "2026-09-21T15:40:41.000Z",
      bodyText: "Hi Jamie, Kevin taking over here. Roughly you can expect $650",
    }),
    gmail({
      gmailMessageId: "1a0c55db58cf0c30",
      sentAt: "2026-09-21T19:07:27.000Z",
      bodyText: "(Ignore that last email)",
    }),
  ]);

  it("puts the staff member's hand-written messages in the conversation, in order, once each", () => {
    const { events, sources, complete } = assembleLeadHistory(input({ staffMailbox: staff }));
    const messages = messagesOf(events);

    expect(messages.map((m) => [m.at, m.from, m.direction])).toEqual([
      ["2026-09-21T14:01:18.000Z", SENDER, "outbound"],
      ["2026-09-21T15:28:34.000Z", PROSPECT, "inbound"],
      ["2026-09-21T15:40:41.000Z", STAFF, "outbound"],
      ["2026-09-21T19:04:44.000Z", SENDER, "outbound"],
      // Held by the outreach side too, which labelled it inbound: the staff mirror knows better.
      ["2026-09-21T19:07:27.000Z", STAFF, "outbound"],
      ["2026-09-21T20:40:50.000Z", PROSPECT, "inbound"],
    ]);

    const kevin = messages.find((m) => m.at === "2026-09-21T15:40:41.000Z")!;
    expect(kevin.source).toBe("staff-mailbox");
    expect(kevin.copy).toBe("staff_gmail_mirror");
    expect(kevin.campaignId).toBeNull();
    expect(kevin.bodyText).toContain("Kevin taking over here");

    const ignore = messages.find((m) => m.at === "2026-09-21T19:07:27.000Z")!;
    expect(ignore.heldBy.sort()).toEqual(["outreach", "staff-mailbox"]);
    const reply = messages.find((m) => m.at === "2026-09-21T15:28:34.000Z")!;
    expect(reply.heldBy.sort()).toEqual(["outreach", "staff-mailbox"]);

    expect(sources.find((s) => s.source === "staff-mailbox")).toEqual({
      source: "staff-mailbox",
      status: "ok",
      reason: null,
    });
    expect(complete).toBe(true);
  });

  it("leaves a lead with no staff exchange exactly as it was", () => {
    const without = assembleLeadHistory(input());
    const withEmpty = assembleLeadHistory(input({ staffMailbox: { ok: true, data: null } }));

    expect(withEmpty.events).toEqual(without.events);
    expect(withEmpty.complete).toBe(true);
    expect(withEmpty.sources.find((s) => s.source === "staff-mailbox")!.status).toBe("ok");
    expect(without.sources.find((s) => s.source === "staff-mailbox")!.status).toBe("not_asked");
  });

  it("states a staff mailbox it could not read, and never renders that as silence", () => {
    const { sources, complete, events } = assembleLeadHistory(
      input({ staffMailbox: { ok: false, reason: "google-service answered 500" } }),
    );
    expect(sources.find((s) => s.source === "staff-mailbox")).toEqual({
      source: "staff-mailbox",
      status: "unavailable",
      reason: "google-service answered 500",
    });
    expect(complete).toBe(false);
    expect(messagesOf(events)).toHaveLength(5);
  });
});
