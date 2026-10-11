/**
 * "Needs your call" against a REAL database: the people waiting on us are read off the outreach
 * fact copy and the "answered outside" statements. Replays the brief's case: an interest from two
 * months ago and a question from five days ago both wait; a statement takes the question out; a new
 * message puts it back; an answer through our mailboxes (reply_sent) takes the interest out.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { ingestOutreachFactsPage } = await import("../../src/lib/outreach-fact-feed.js");
const awaitingReplyRoutes = (await import("../../src/routes/awaiting-reply.js")).default;
const leadsRoutes = (await import("../../src/routes/leads.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("awaiting-reply routes against a real database", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const campaign = `itest-camp-${randomUUID()}`;
  const interestEmail = `dbobrow-${randomUUID()}@example.test`;
  const questionEmail = `lukas-${randomUUID()}@example.test`;
  const people: Record<string, { leadId: string; rowId: string }> = {};
  const app = express();
  app.use(express.json());
  app.use(awaitingReplyRoutes);
  app.use(leadsRoutes);

  const get = () =>
    request(app).get(`/orgs/leads/awaiting-reply?brandId=${brand}`)
      .set("x-api-key", "test-api-key").set("x-org-id", org).set("x-user-id", "u1");

  let seq = Math.floor(Math.random() * 1e12) * 100;
  function fact(type: string, subjectKey: string, email: string, at: string, body: Record<string, unknown>) {
    seq += 1;
    return {
      seq: String(seq), type, subjectKey, supersedesSeq: null, occurredAt: at, recordedAt: at,
      leadEmail: email, orgId: org, campaignId: campaign, instantlyCampaignId: "ic", brandIds: [brand], transport: "smtp",
      send: null, open: null, click: null, bounce: null, unsubscribe: null, reply: null, withdrawal: null, ...body,
    };
  }
  const verdict = (over: Record<string, unknown>) => ({
    kind: "k", classification: "positive", automatedAnswer: false, stopRequested: false, notOurTarget: false,
    handedToPerson: false, positiveSignal: null, declinedOffer: false, notOurTargetReason: null, handoffReason: null, ...over,
  });
  function reply(email: string, at: string, v: Record<string, unknown>, judgments: Record<string, unknown> = {}) {
    const id = `r-${randomUUID()}`;
    return fact("reply", `reply:${id}`, email, at, {
      reply: { replyId: id, subject: "Re: hello", receivedAt: at, verdict: verdict(v), judgments: { question: null, proposalType: null, ...judgments }, escalation: null },
    });
  }
  const feed = (...facts: unknown[]) => ingestOutreachFactsPage({ facts, nextCursor: String(seq), hasMore: false });

  beforeAll(async () => {
    for (const email of [interestEmail, questionEmail]) {
      const lead = (await db.execute(sql`INSERT INTO leads (id, first_name) VALUES (gen_random_uuid(), 'Itest') RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
      await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead[0].id}::uuid, 'email', ${email}, 'itest')`);
      const lc = (await db.execute(sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
        VALUES (${lead[0].id}::uuid, ${campaign}, ${org}, ARRAY[${brand}]::text[], 'served', now())
        RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
      people[email] = { leadId: lead[0].id, rowId: lc[0].id };
    }
    await feed(
      fact("email_sent", `ievt:${randomUUID()}`, interestEmail, "2026-08-14T13:08:55Z", { send: { step: 3, position: "followup" } }),
      reply(interestEmail, "2026-08-14T14:16:41Z", { positiveSignal: "interested" }),
      reply(questionEmail, "2026-10-06T17:08:29Z", { positiveSignal: "information_request" }, { question: { value: "needs_sender_company" } }),
    );
  });

  afterAll(async () => {
    for (const t of ["answered_outside_statements", "leads_campaigns", "outreach_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${org}`);
    }
  });

  it("returns both people waiting, oldest wait first, count = list", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.people.map((p: { email: string }) => p.email)).toEqual([interestEmail, questionEmail]);
    expect(res.body.people[0]).toMatchObject({
      id: people[interestEmail].rowId, leadId: people[interestEmail].leadId, firstName: "Itest",
      waitingSince: "2026-08-14T14:16:41.000Z", lastMessage: { kind: "interest", label: "interested", campaignId: campaign },
    });
    expect(res.body.people[1]).toMatchObject({ waitingSince: "2026-10-06T17:08:29.000Z", lastMessage: { kind: "question", label: "question_to_escalate" } });
  });

  it("'answered outside' takes the person out; a new message from them puts them back", async () => {
    const stated = await request(app).post(`/orgs/leads/${people[questionEmail].rowId}/answered-outside`)
      .set("x-api-key", "test-api-key").set("x-org-id", org).set("x-user-id", "owner-1");
    expect(stated.status).toBe(201);
    expect(stated.body).toMatchObject({ statement: { leadId: people[questionEmail].leadId, brandId: brand, statedByUserId: "owner-1" }, awaitingReply: false });

    const after = await get();
    expect(after.body.people.map((p: { email: string }) => p.email)).toEqual([interestEmail]);

    await feed(reply(questionEmail, new Date(Date.now() + 60_000).toISOString(), { positiveSignal: "interested" }));
    const back = await get();
    expect(back.body.total).toBe(2);
  });

  it("an answer through our mailboxes takes the person out with no dashboard action", async () => {
    await feed(fact("reply_sent", `rsent:${randomUUID()}`, interestEmail, "2026-08-15T09:00:00Z", { replySent: { via: "provider_unibox", sentBy: "human" } }));
    const res = await get();
    expect(res.body.people.map((p: { email: string }) => p.email)).toEqual([questionEmail]);
  });

  it("refuses a statement without who, and on a row of another org", async () => {
    const noUser = await request(app).post(`/orgs/leads/${people[questionEmail].rowId}/answered-outside`)
      .set("x-api-key", "test-api-key").set("x-org-id", org);
    expect(noUser.status).toBe(400);
    const foreign = await request(app).post(`/orgs/leads/${people[questionEmail].rowId}/answered-outside`)
      .set("x-api-key", "test-api-key").set("x-org-id", randomUUID()).set("x-user-id", "u1");
    expect(foreign.status).toBe(404);
  });

  it("brandId is required", async () => {
    const res = await request(app).get("/orgs/leads/awaiting-reply").set("x-api-key", "test-api-key").set("x-org-id", org).set("x-user-id", "u1");
    expect(res.status).toBe(400);
  });
});
