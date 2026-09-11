import { describe, it, expect } from "vitest";
import {
  assembleLeadHistory,
  type AssembleHistoryInput,
  type HistoryCampaignInput,
} from "../../src/lib/lead-history.js";
import { DEFAULT_STATUS } from "../../src/lib/delivery-flatten.js";

function campaign(over: Partial<HistoryCampaignInput> = {}): HistoryCampaignInput {
  return {
    leadCampaignId: "lc-1",
    campaignId: "camp-1",
    status: "served",
    createdAt: "2026-01-01T00:00:00.000Z",
    servedAt: "2026-01-01T00:00:00.000Z",
    sentAt: null,
    followupDueAt: null,
    followupCount: 0,
    followupLastActionAt: null,
    followupStoppedReason: null,
    delivery: null,
    conversation: { ok: true, data: null },
    generation: { ok: true, data: null },
    ...over,
  };
}

function input(over: Partial<AssembleHistoryInput> = {}): AssembleHistoryInput {
  return {
    email: "prospect@example.com",
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

const conversation = (messages: Array<Record<string, unknown>>) => ({
  ok: true as const,
  data: {
    campaignId: "camp-1",
    leadEmail: "prospect@example.com",
    accountEmail: "sender@ours.com",
    transport: "instantly" as const,
    source: "mirror" as const,
    messageCount: messages.length,
    messages: messages as never,
  },
});

describe("assembleLeadHistory — ordering", () => {
  it("orders oldest first and puts an undated fact LAST, never at the epoch", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [campaign({ servedAt: "2026-02-01T10:00:00.000Z" })],
        trackerConversions: [
          {
            id: "cv-undated",
            event: "signup",
            at: null,
            valueCents: null,
            matchConfidence: "deterministic",
            attributionStatus: "attributed",
          },
        ],
        statedOutcomes: [
          {
            id: "so-1",
            step: "meeting_booked",
            campaignId: "camp-1",
            at: "2026-01-01T09:00:00.000Z",
            valueCents: null,
            costCents: 1000,
            statedByUserId: "user-1",
            note: null,
          },
        ],
      }),
    );

    expect(events.map((e) => e.id)).toEqual([
      "step_statement:outcome:so-1",
      "lifecycle:lc-1:served",
      "conversion:cv-undated",
    ]);
    expect(events[2].at).toBeNull();
  });
});

describe("assembleLeadHistory — asserted is not observed", () => {
  it("tags a hand-stated step as asserted and a tracker-reported outcome as observed", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [campaign({ servedAt: null })],
        statedNevers: [
          {
            id: "nv-1",
            step: "sale",
            campaignId: "camp-1",
            at: "2026-03-01T00:00:00.000Z",
            costCents: 0,
            statedByUserId: "user-2",
            note: "went with a competitor",
          },
        ],
        trackerConversions: [
          {
            id: "cv-1",
            event: "signup",
            at: "2026-02-01T00:00:00.000Z",
            valueCents: 5000,
            matchConfidence: "deterministic",
            attributionStatus: "attributed",
          },
        ],
      }),
    );

    const tracker = events.find((e) => e.id === "conversion:cv-1")!;
    const stated = events.find((e) => e.id === "step_statement:never:nv-1")!;
    expect(tracker.evidence).toBe("observed");
    expect(stated.evidence).toBe("asserted");
    expect(stated.type).toBe("step_statement");
  });

  it("keeps a recorded reply apart from one whose words we hold, and gives it no body", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            conversation: conversation([
              {
                direction: "inbound",
                from: "prospect@example.com",
                to: "sender@ours.com",
                at: "2026-01-02T08:00:00.000Z",
                subject: "Re: intro",
                text: "sure, send me a time",
              },
            ]),
          }),
        ],
        replyStatements: {
          ok: true,
          data: [
            {
              id: "mq-1",
              campaignId: "camp-1",
              email: "prospect@example.com",
              replyKind: "lead_interested",
              status: "lead_interested",
              qualifiedBy: "user-3",
              notes: "answered on LinkedIn",
              qualifiedAt: "2026-01-05T08:00:00.000Z",
              withdrawnAt: null,
            },
          ],
        },
      }),
    );

    const held = events.find((e) => e.type === "message")!;
    const recorded = events.find((e) => e.type === "reply_statement")!;
    expect(held.evidence).toBe("observed");
    expect((held as { bodyText: string | null }).bodyText).toBe("sure, send me a time");
    expect(recorded.evidence).toBe("asserted");
    expect(recorded).not.toHaveProperty("bodyText");
  });

  it("drops a withdrawn reply statement and a withdrawn opt-out", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [campaign({ servedAt: null })],
        replyStatements: {
          ok: true,
          data: [
            {
              id: "mq-w",
              campaignId: "camp-1",
              email: "prospect@example.com",
              replyKind: "lead_interested",
              status: "lead_interested",
              qualifiedBy: "user-3",
              notes: null,
              qualifiedAt: "2026-01-05T08:00:00.000Z",
              withdrawnAt: "2026-01-06T08:00:00.000Z",
            },
          ],
        },
        optOuts: {
          ok: true,
          data: [
            {
              id: "oo-w",
              email: "prospect@example.com",
              channel: "email_reply",
              statedBy: "user-3",
              notes: null,
              statedAt: "2026-01-05T09:00:00.000Z",
              withdrawnAt: "2026-01-07T09:00:00.000Z",
            },
          ],
        },
      }),
    );

    expect(events).toEqual([]);
  });
});

describe("assembleLeadHistory — the de-duplication the browser was doing", () => {
  it("does not emit a 'sent' milestone beside the message carrying those words", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            delivery: {
              ...DEFAULT_STATUS,
              firstSentAt: "2026-01-02T07:00:00.000Z",
              firstOpenedAt: "2026-01-02T09:00:00.000Z",
            },
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-02T07:00:00.000Z",
                subject: "intro",
                text: "hello",
              },
            ]),
          }),
        ],
      }),
    );

    expect(events.filter((e) => e.type === "delivery").map((e) => (e as { milestone: string }).milestone)).toEqual([
      "opened",
    ]);
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
  });

  it("still emits 'sent' when nothing holds the words", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            delivery: { ...DEFAULT_STATUS, firstSentAt: "2026-01-02T07:00:00.000Z" },
          }),
        ],
      }),
    );

    expect(events.map((e) => (e as { milestone?: string }).milestone)).toEqual(["sent"]);
  });

  it("merges one message held by both the outreach mirror and the customer's mailbox", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            conversation: conversation([
              {
                direction: "inbound",
                from: "prospect@example.com",
                to: "sender@ours.com",
                at: "2026-01-02T08:00:12.000Z",
                subject: "Re: intro",
                text: "sure, send me a time",
              },
            ]),
          }),
        ],
        mailbox: {
          ok: true,
          data: {
            address: "prospect@example.com",
            status: "ok",
            threadCount: 1,
            messageCount: 1,
            truncated: false,
            threads: [
              {
                threadId: "t-1",
                subject: "intro",
                firstMessageAt: "2026-01-02T08:00:41.000Z",
                lastMessageAt: "2026-01-02T08:00:41.000Z",
                messageCount: 1,
                messages: [
                  {
                    gmailMessageId: "g-1",
                    threadId: "t-1",
                    direction: "inbound",
                    fromEmail: "prospect@example.com",
                    fromName: "A Prospect",
                    to: ["sender@ours.com"],
                    subject: "RE: intro",
                    snippet: "sure, send me a time",
                    sentAt: "2026-01-02T08:00:41.000Z",
                    labels: [],
                    bodyText: "sure, send me a time",
                    bodyHtml: null,
                    bodyStatus: "ok",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const messages = events.filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
    expect((messages[0] as { heldBy: string[] }).heldBy.sort()).toEqual(["mailbox", "outreach"]);
  });

  it("keeps an exchange that only the customer's mailbox holds", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [campaign({ servedAt: null })],
        mailbox: {
          ok: true,
          data: {
            address: "prospect@example.com",
            status: "ok",
            threadCount: 1,
            messageCount: 1,
            truncated: false,
            threads: [
              {
                threadId: "t-9",
                subject: "coffee?",
                firstMessageAt: "2026-04-02T08:00:00.000Z",
                lastMessageAt: "2026-04-02T08:00:00.000Z",
                messageCount: 1,
                messages: [
                  {
                    gmailMessageId: "g-9",
                    threadId: "t-9",
                    direction: "inbound",
                    fromEmail: "prospect@example.com",
                    fromName: null,
                    to: ["owner@customer.com"],
                    subject: "coffee?",
                    snippet: "are you around thursday",
                    sentAt: "2026-04-02T08:00:00.000Z",
                    labels: [],
                    bodyText: "are you around thursday",
                    bodyHtml: null,
                    bodyStatus: "ok",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("mailbox");
    // The mailbox knows an address, not a campaign — claiming one would be a guess.
    expect(events[0].campaignId).toBeNull();
  });

  it("carries an unreadable body as unavailable, never as empty", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [campaign({ servedAt: null })],
        mailbox: {
          ok: true,
          data: {
            address: "prospect@example.com",
            status: "partial",
            threadCount: 1,
            messageCount: 1,
            truncated: false,
            threads: [
              {
                threadId: "t-2",
                subject: "hi",
                firstMessageAt: "2026-04-02T08:00:00.000Z",
                lastMessageAt: "2026-04-02T08:00:00.000Z",
                messageCount: 1,
                messages: [
                  {
                    gmailMessageId: "g-2",
                    threadId: "t-2",
                    direction: "inbound",
                    fromEmail: "prospect@example.com",
                    fromName: null,
                    to: [],
                    subject: "hi",
                    snippet: null,
                    sentAt: "2026-04-02T08:00:00.000Z",
                    labels: [],
                    bodyText: null,
                    bodyHtml: null,
                    bodyStatus: "unavailable",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect((events[0] as { bodyStatus: string }).bodyStatus).toBe("unavailable");
    // A mirror that holds the exchange and cannot read it is stated, not rendered as silence.
    const mailbox = assembleLeadHistory(
      input({
        campaigns: [campaign({ servedAt: null })],
        mailbox: {
          ok: true,
          data: {
            address: "prospect@example.com",
            status: "unreadable",
            threadCount: 0,
            messageCount: 0,
            truncated: false,
            threads: [],
          },
        },
      }),
    );
    expect(mailbox.sources.find((s) => s.source === "mailbox")!.status).toBe("unavailable");
    expect(mailbox.complete).toBe(false);
  });
});

describe("assembleLeadHistory — a source that could not be read", () => {
  it("degrades only itself, still answers, and says what is missing", () => {
    const { events, sources, complete } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: "2026-01-01T00:00:00.000Z",
            conversation: { ok: false, reason: "instantly-service unreachable: fetch failed" },
          }),
        ],
        mailbox: { ok: false, reason: "google-service answered 500" },
      }),
    );

    expect(events.map((e) => e.id)).toEqual(["lifecycle:lc-1:served"]);
    expect(complete).toBe(false);
    const byName = Object.fromEntries(sources.map((s) => [s.source, s]));
    expect(byName.outreach.status).toBe("unavailable");
    expect(byName.outreach.reason).toContain("instantly-service unreachable");
    expect(byName.mailbox.status).toBe("unavailable");
    expect(byName["lead-service"].status).toBe("ok");
  });

  it("a failure on one campaign wins over a success on another — the failure is what matters", () => {
    const { sources } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({ leadCampaignId: "lc-1", campaignId: "camp-1", conversation: conversation([]) }),
          campaign({
            leadCampaignId: "lc-2",
            campaignId: "camp-2",
            conversation: { ok: false, reason: "instantly-service answered 502" },
          }),
        ],
      }),
    );

    expect(sources.find((s) => s.source === "outreach")!.status).toBe("unavailable");
  });

  it("says delivery was NOT ASKED rather than ok when nothing in scope was served", () => {
    const { sources, complete } = assembleLeadHistory(
      input({ campaigns: [campaign({ delivery: null })] }),
    );
    expect(sources.find((s) => s.source === "delivery")!.status).toBe("not_asked");
    // Not asked is not a failure — the answer is still whole.
    expect(complete).toBe(true);
  });
});

describe("assembleLeadHistory — what we owe next", () => {
  it("a stopped schedule states it is stopped and advertises NO next follow-up", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            followupDueAt: "2026-05-01T00:00:00.000Z",
            followupStoppedReason: "they replied",
            followupLastActionAt: "2026-04-20T00:00:00.000Z",
            followupCount: 3,
          }),
        ],
      }),
    );

    expect(events).toHaveLength(1);
    const followup = events[0] as { state: string; dueAt: string | null };
    expect(followup.state).toBe("stopped");
    expect(followup.dueAt).toBeNull();
  });

  it("a live schedule carries its due date", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({ servedAt: null, followupDueAt: "2026-05-01T00:00:00.000Z", followupCount: 1 }),
        ],
      }),
    );
    const followup = events[0] as { state: string; dueAt: string | null };
    expect(followup.state).toBe("scheduled");
    expect(followup.dueAt).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("assembleLeadHistory — the copy we produced", () => {
  it("carries the words and the planned cadence, tagged to the campaign", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: {
              ok: true,
              data: {
                id: "gen-1",
                campaignId: "camp-1",
                subject: "quick question",
                bodyText: "hello there",
                bodyHtml: null,
                sequence: [{ step: 2, waitDays: 3 }],
                model: "claude-sonnet-4-6",
                promptType: "cold",
                createdAt: "2026-01-01T06:00:00.000Z",
              },
            },
          }),
        ],
      }),
    );

    const generated = events[0] as { type: string; subject: string; plannedSequence: unknown };
    expect(generated.type).toBe("generated_email");
    expect(generated.subject).toBe("quick question");
    expect(generated.plannedSequence).toEqual([{ step: 2, waitDays: 3 }]);
    expect(events[0].evidence).toBe("observed");
  });

  it("says the words could not be read rather than being silent about their absence", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: {
              ok: true,
              data: {
                id: "gen-2",
                campaignId: "camp-1",
                subject: "quick question",
                bodyText: null,
                bodyHtml: null,
                sequence: [{ step: 1 }],
                model: "claude-sonnet-4-6",
                promptType: "cold",
                createdAt: "2026-01-01T06:00:00.000Z",
              },
            },
          }),
        ],
      }),
    );

    const generated = events[0] as { bodyText: string | null; bodyStatus: string };
    expect(generated.bodyText).toBeNull();
    expect(generated.bodyStatus).toBe("unavailable");
  });

  it("reads a body the producer handed over as readable, and an empty one as empty", () => {
    const withBody = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: {
              ok: true,
              data: {
                id: "gen-3",
                campaignId: "camp-1",
                subject: "s",
                bodyText: "hello there",
                bodyHtml: null,
                sequence: null,
                model: null,
                promptType: null,
                createdAt: "2026-01-01T06:00:00.000Z",
              },
            },
          }),
        ],
      }),
    ).events[0] as { bodyStatus: string };
    expect(withBody.bodyStatus).toBe("ok");

    const emptyBody = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: {
              ok: true,
              data: {
                id: "gen-4",
                campaignId: "camp-1",
                subject: "s",
                bodyText: "   ",
                bodyHtml: null,
                sequence: null,
                model: null,
                promptType: null,
                createdAt: "2026-01-01T06:00:00.000Z",
              },
            },
          }),
        ],
      }),
    ).events[0] as { bodyStatus: string };
    expect(emptyBody.bodyStatus).toBe("empty");
  });
});

const GENERATED_URL =
  "https://opsfolio.com/lp/cmmc/level-1-free-assessment/?utm_source=landing_page&utm_medium=email&utm_campaign=cmmc_level1&utm_id=distribute";
const SEEN_URL = "https://opsfolio.com/lp/cmmc/level-1-free-assessment/";

function generation(over: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      id: "gen-1",
      campaignId: "camp-1",
      subject: "CMMC Level 1 readiness",
      bodyText: `Hi Tom,\n\nSee how it works here: ${GENERATED_URL}`,
      bodyHtml: null,
      sequence: null,
      model: "gemini-3.5-flash-lite",
      promptType: "cold",
      createdAt: "2026-01-01T06:00:00.000Z",
      ...over,
    } as never,
  };
}

describe("assembleLeadHistory — one event per email", () => {
  it("states the message that went out and NOT the copy we drafted of it", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation(),
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-02T09:00:00.000Z",
                subject: "CMMC Level 1 readiness",
                text: `Hi Tom,\nSee how it works here: ${SEEN_URL}\n--\nKevin\n\nunsubscribe`,
              },
            ]),
          }),
        ],
      }),
    );

    expect(events.filter((e) => e.type === "generated_email")).toHaveLength(0);
    const messages = events.filter((e) => e.type === "message");
    expect(messages).toHaveLength(1);
    expect((messages[0] as { bodyText: string }).bodyText).toContain("unsubscribe");
  });

  it("states one event per email sent when a sequence sent several", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation(),
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-02T09:00:00.000Z",
                subject: "CMMC Level 1 readiness",
                text: `first ${SEEN_URL}`,
              },
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-05T09:00:00.000Z",
                subject: "Re: CMMC Level 1 readiness",
                text: `follow-up ${SEEN_URL}`,
              },
            ]),
          }),
        ],
      }),
    );

    expect(events.filter((e) => e.type === "generated_email")).toHaveLength(0);
    expect(events.filter((e) => e.type === "message")).toHaveLength(2);
  });

  it("still states the drafted copy for a person nothing has been sent to yet", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({ servedAt: null, generation: generation(), conversation: { ok: true, data: null } }),
        ],
      }),
    );

    const drafted = events.filter((e) => e.type === "generated_email");
    expect(drafted).toHaveLength(1);
    expect((drafted[0] as { bodyText: string }).bodyText).toContain(GENERATED_URL);
  });

  it("keeps the drafted copy when the only message we hold is an INBOUND one", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation(),
            conversation: conversation([
              {
                direction: "inbound",
                from: "prospect@example.com",
                to: "sender@ours.com",
                at: "2026-01-02T09:00:00.000Z",
                subject: "Re: CMMC",
                text: "not interested",
              },
            ]),
          }),
        ],
      }),
    );

    expect(events.filter((e) => e.type === "generated_email")).toHaveLength(1);
  });
});

describe("assembleLeadHistory — where a link in a message leads", () => {
  it("names what the prospect saw and the destination we wrote, parameters included", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation(),
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-02T09:00:00.000Z",
                subject: "CMMC Level 1 readiness",
                text: `See how it works here: ${SEEN_URL}`,
              },
            ]),
          }),
        ],
      }),
    );

    const message = events.find((e) => e.type === "message") as { links: Array<{ text: string; href: string | null }> };
    expect(message.links).toEqual([{ text: SEEN_URL, href: GENERATED_URL }]);
  });

  it("states a link it cannot resolve with only what it knows, and never invents parameters", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation(),
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-02T09:00:00.000Z",
                subject: "CMMC Level 1 readiness",
                text: "read this https://example.org/some/other/page and this https://click.instantly.ai/t/abc123",
              },
            ]),
          }),
        ],
      }),
    );

    const message = events.find((e) => e.type === "message") as { links: Array<{ text: string; href: string | null }> };
    expect(message.links).toEqual([
      { text: "https://example.org/some/other/page", href: null },
      { text: "https://click.instantly.ai/t/abc123", href: null },
    ]);
  });

  it("resolves a follow-up's link out of the planned sequence's own copy", () => {
    const followupUrl = "https://opsfolio.com/lp/cmmc/book?utm_campaign=cmmc_level1&utm_id=distribute";
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation({
              sequence: [{ step: 2, bodyText: `book a slot: ${followupUrl}` }],
            }),
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-05T09:00:00.000Z",
                subject: "Re: CMMC Level 1 readiness",
                text: "book a slot: https://opsfolio.com/lp/cmmc/book",
              },
            ]),
          }),
        ],
      }),
    );

    const message = events.find((e) => e.type === "message") as { links: Array<{ text: string; href: string | null }> };
    expect(message.links).toEqual([
      { text: "https://opsfolio.com/lp/cmmc/book", href: followupUrl },
    ]);
  });

  it("refuses to choose when two copies point at one page with different parameters", () => {
    const { events } = assembleLeadHistory(
      input({
        campaigns: [
          campaign({
            servedAt: null,
            generation: generation({
              sequence: [
                { step: 2, bodyText: `${SEEN_URL}?utm_campaign=other&utm_id=distribute` },
              ],
            }),
            conversation: conversation([
              {
                direction: "outbound",
                from: "sender@ours.com",
                to: "prospect@example.com",
                at: "2026-01-02T09:00:00.000Z",
                subject: "CMMC Level 1 readiness",
                text: `here: ${SEEN_URL}`,
              },
            ]),
          }),
        ],
      }),
    );

    const message = events.find((e) => e.type === "message") as { links: Array<{ text: string; href: string | null }> };
    expect(message.links).toEqual([{ text: SEEN_URL, href: null }]);
  });
});
