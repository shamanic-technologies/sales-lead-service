/**
 * "Needs your call" clears BY ITSELF when one of our people answers from their own Gmail (owner
 * 2026-10-12), against a REAL database: the Gmail mirrors, the outreach conversation and Jev are
 * stubbed at their clients; the waiting rule, the frozen verdicts and the read are real.
 * Replays Lukas: a question on 2026-10-06, answered by staff from Gmail on 2026-10-11 = out of the
 * list with nobody clicking; a prospect whose only later email from us is unrelated stays listed.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { MailboxConversation, MailboxMessage } from "../../src/lib/mailbox-client.js";

const mailbox = vi.hoisted(() => ({
  org: new Map<string, unknown>(),
  staff: new Map<string, unknown>(),
}));
const judge = vi.hoisted(() => ({ calls: [] as unknown[], p: new Map<string, number>() }));

vi.mock("../../src/lib/mailbox-client.js", () => ({
  fetchMailboxConversation: vi.fn(async (email: string) => mailbox.org.get(email) ?? { ok: true, data: null }),
  fetchStaffMailboxConversation: vi.fn(async (email: string) => mailbox.staff.get(email) ?? { ok: true, data: null }),
}));
vi.mock("../../src/lib/outreach-client.js", () => ({
  fetchOutreachConversation: vi.fn(async () => ({
    ok: true,
    data: { messages: [{ direction: "inbound", from: "x", to: "y", at: "2026-10-06T17:08:29.000Z", subject: "Re: B2B", text: "Who is the company behind this?" }] },
  })),
}));
vi.mock("../../src/lib/qualification-judge.js", () => ({
  judgeYesNo: vi.fn(async (state: { ourEmail: { subject: string } }) => {
    judge.calls.push(state);
    return { probabilities: { answers: judge.p.get(state.ourEmail.subject) ?? 0 }, model: "jev-test-1" };
  }),
}));

const { db } = await import("../../src/db/index.js");
const { ingestOutreachFactsPage } = await import("../../src/lib/outreach-fact-feed.js");
const { resetOutsideAnswerMemo } = await import("../../src/lib/outside-answers.js");
const awaitingReplyRoutes = (await import("../../src/routes/awaiting-reply.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

function conv(email: string, messages: Array<Partial<MailboxMessage>>): { ok: true; data: MailboxConversation } {
  const full = messages.map((m, i) => ({
    gmailMessageId: `g-${randomUUID()}`, threadId: "t", direction: "outbound" as const, fromEmail: "kevin@distribute.you", fromName: null,
    to: [email], subject: `s${i}`, snippet: null, sentAt: "2026-10-11T12:49:35.000Z", labels: ["SENT"], bodyText: "text", bodyHtml: null,
    bodyStatus: "ok" as const, ...m,
  }));
  return { ok: true, data: { address: email, status: "ok", threadCount: 1, messageCount: full.length, truncated: false,
    threads: [{ threadId: "t", subject: null, firstMessageAt: null, lastMessageAt: null, messageCount: full.length, messages: full }] } };
}

describe.skipIf(!hasRealDatabase)("outside answers clear Needs your call by themselves", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const campaign = `itest-camp-${randomUUID()}`;
  const lukas = `lukas-${randomUUID()}@example.test`;
  const other = `other-${randomUUID()}@example.test`;
  const leadIds: Record<string, string> = {};
  const app = express();
  app.use(express.json());
  app.use(awaitingReplyRoutes);

  const get = (withRun = true) => {
    const r = request(app).get(`/orgs/leads/awaiting-reply?brandId=${brand}`)
      .set("x-api-key", "test-api-key").set("x-org-id", org).set("x-user-id", randomUUID());
    return withRun ? r.set("x-run-id", randomUUID()) : r;
  };

  let seq = Math.floor(Math.random() * 1e12) * 100;
  function question(email: string, at: string) {
    seq += 1;
    const id = `r-${randomUUID()}`;
    return {
      seq: String(seq), type: "reply", subjectKey: `reply:${id}`, supersedesSeq: null, occurredAt: at, recordedAt: at,
      leadEmail: email, orgId: org, campaignId: campaign, instantlyCampaignId: "ic", brandIds: [brand], transport: "smtp",
      send: null, open: null, click: null, bounce: null, unsubscribe: null, withdrawal: null,
      reply: {
        replyId: id, subject: "Re: B2B", receivedAt: at, escalation: null,
        verdict: { kind: "k", classification: "positive", automatedAnswer: false, stopRequested: false, notOurTarget: false, handedToPerson: false,
          positiveSignal: "information_request", declinedOffer: false, notOurTargetReason: null, handoffReason: null },
        judgments: { question: { value: "needs_sender_company" }, proposalType: null },
      },
    };
  }

  beforeAll(async () => {
    for (const email of [lukas, other]) {
      const lead = (await db.execute(sql`INSERT INTO leads (id, first_name) VALUES (gen_random_uuid(), 'Itest') RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
      await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead[0].id}::uuid, 'email', ${email}, 'itest')`);
      await db.execute(sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
        VALUES (${lead[0].id}::uuid, ${campaign}, ${org}, ARRAY[${brand}]::text[], 'served', now())`);
      leadIds[email] = lead[0].id;
    }
    await ingestOutreachFactsPage({ facts: [question(lukas, "2026-10-06T17:08:29Z"), question(other, "2026-10-06T18:00:00Z")], nextCursor: String(seq), hasMore: false });
  });

  beforeEach(() => {
    resetOutsideAnswerMemo();
    judge.calls.length = 0;
  });

  afterAll(async () => {
    for (const t of ["outside_answer_judgments", "leads_campaigns", "outreach_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${org}`);
    }
  });

  it("without a run to read the mirrors with, both stay listed and the response says why", async () => {
    mailbox.staff.set(lukas, conv(lukas, [{ subject: "Re: Needs you: lukas asked a question" }]));
    const res = await get(false);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.outsideAnswers).toMatchObject({ complete: false, judged: 0 });
    expect(res.body.outsideAnswers.reason).toMatch(/x-run-id/);
  });

  it("a staff answer from Gmail judged an answer takes Lukas out; an unrelated email keeps the other listed", async () => {
    judge.p.set("Re: Needs you: lukas asked a question", 0.93);
    mailbox.org.set(other, conv(other, [{ subject: "Our October newsletter" }]));
    judge.p.set("Our October newsletter", 0.04);

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.people.map((p: { email: string }) => p.email)).toEqual([other]);
    expect(res.body.outsideAnswers).toMatchObject({ complete: true, judged: 2, unreadable: [] });

    const rows = (await db.execute(sql`
      SELECT lead_id::text AS lead_id, mailbox, answers, probability, model FROM outside_answer_judgments WHERE org_id = ${org} ORDER BY probability DESC`)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { lead_id: leadIds[lukas], mailbox: "staff", answers: true, probability: 0.93, model: "jev-test-1" },
      { lead_id: leadIds[other], mailbox: "org", answers: false, probability: 0.04, model: "jev-test-1" },
    ]);
    // Jev read what they wrote beside what we sent.
    expect(judge.calls[0]).toMatchObject({ theirMessages: [{ text: "Who is the company behind this?" }] });
  });

  it("a verdict is frozen: the next read (even with no run) judges nothing again and keeps Lukas out", async () => {
    const res = await get();
    expect(res.body.people.map((p: { email: string }) => p.email)).toEqual([other]);
    expect(judge.calls).toHaveLength(0);
    const noRun = await get(false);
    expect(noRun.body.people.map((p: { email: string }) => p.email)).toEqual([other]);
  });

  it("an unreadable mirror leaves the person listed and says so", async () => {
    mailbox.org.set(other, { ok: false, reason: "google-service answered 500" });
    const res = await get();
    expect(res.body.people.map((p: { email: string }) => p.email)).toEqual([other]);
    expect(res.body.outsideAnswers).toMatchObject({ complete: false, unreadable: [{ email: other }] });
  });

  it("a new message from Lukas after our answer puts him back", async () => {
    await ingestOutreachFactsPage({ facts: [question(lukas, new Date(Date.now() + 60_000).toISOString())], nextCursor: String(seq), hasMore: false });
    mailbox.org.delete(other);
    const res = await get();
    expect(res.body.people.map((p: { email: string }) => p.email).sort()).toEqual([lukas, other].sort());
  });
});
