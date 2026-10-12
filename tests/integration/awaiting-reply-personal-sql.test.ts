/**
 * "Needs your call" reads PERSONAL channels (WhatsApp...) like email, against a REAL database
 * (WA-RESPONDER-1012). The crm fact copy carries the messages (source `matrix`); each message of theirs
 * after our latest answer is judged once (Jev, mocked here by its text) and frozen; a message of ours on
 * that channel is an answer. A stop request takes a person out for good; a closing word waits on nobody.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const judged: string[] = [];
let judgeFails = false;
vi.mock("../../src/lib/qualification-judge.js", () => ({
  judgeYesNo: async () => {
    throw new Error("not used");
  },
  judgeChoice: async (state: { message: { text: string | null } }) => {
    const text = state.message.text ?? "";
    judged.push(text);
    if (judgeFails) throw new Error("chat-service judgment failed: 503");
    const choice = /stop/i.test(text)
      ? "stop_request"
      : /thanks/i.test(text)
        ? "closing"
        : text.includes("?")
          ? "waits_question"
          : "waits_other";
    return { choice, confidence: 0.9, model: "jev-test" };
  },
}));
vi.mock("../../src/lib/mailbox-client.js", () => ({
  fetchMailboxConversation: async () => ({ ok: true, data: null }),
  fetchStaffMailboxConversation: async () => ({ ok: true, data: null }),
}));
vi.mock("../../src/lib/outreach-client.js", () => ({
  fetchOutreachConversation: async () => ({ ok: true, data: null }),
}));

const { db } = await import("../../src/db/index.js");
const { ingestOutreachFactsPage } = await import("../../src/lib/outreach-fact-feed.js");
const { ingestFactsPage } = await import("../../src/lib/crm-fact-feed.js");
const awaitingReplyRoutes = (await import("../../src/routes/awaiting-reply.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("awaiting-reply on personal channels against a real database", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const campaign = `itest-wa-${randomUUID()}`;
  const app = express();
  app.use(express.json());
  app.use(awaitingReplyRoutes);

  const people: Record<string, { leadId: string; email: string; phone: string }> = {};
  let seq = BigInt(Math.floor(Math.random() * 1e12)) * 1000n;

  const get = () =>
    request(app)
      .get(`/orgs/leads/awaiting-reply?brandId=${brand}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", org)
      .set("x-user-id", "u1")
      .set("x-run-id", randomUUID());

  function crmFact(
    who: { email?: string; phone?: string },
    type: string,
    at: string | null,
    payload: Record<string, unknown>,
    withdrawnOf: string | null = null,
  ) {
    seq += 1n;
    const factId = randomUUID();
    return {
      factId,
      seq: seq.toString(),
      orgId: org,
      brandId: brand,
      personKey: who.email ? `email:${who.email}` : `phone:${who.phone}`,
      sourceContactId: null,
      crmContactId: null,
      fullName: null,
      emails: who.email ? [who.email] : [],
      phones: who.phone ? [who.phone] : [],
      type,
      occurredAt: at,
      dateBasis: "sent_at",
      source: "matrix",
      sourceRef: `$${factId}`,
      payload,
      withdrawnOf,
    };
  }
  const msg = (who: { email?: string; phone?: string }, dir: "in" | "out", at: string, text: string) =>
    crmFact(who, dir === "in" ? "message_in" : "message_out", at, { text, channel: "whatsapp", msgtype: "m.text", threadId: "!t" });
  const feed = (...facts: ReturnType<typeof crmFact>[]) =>
    ingestFactsPage({ facts, nextCursor: seq.toString(), hasMore: false } as never);
  const listed = async () => {
    const res = await get();
    expect(res.status).toBe(200);
    return res.body as { total: number; people: Array<{ leadId: string; lastMessage: Record<string, unknown> }>; personalMessages: Record<string, unknown> };
  };
  const ids = (body: { people: Array<{ leadId: string }> }) => body.people.map((p) => p.leadId).sort();

  async function seedLead(key: string, opts: { phoneMethod?: boolean; atBrand?: boolean } = {}) {
    const email = `${key}-${randomUUID()}@example.test`;
    const phone = `+3361${Math.floor(Math.random() * 1e7).toString().padStart(7, "0")}`;
    const lead = (await db.execute(sql`INSERT INTO leads (id, first_name) VALUES (gen_random_uuid(), ${key}) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead[0].id}::uuid, 'email', ${email}, 'itest')`);
    if (opts.phoneMethod) {
      await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead[0].id}::uuid, 'phone', ${phone}, 'itest')`);
    }
    if (opts.atBrand !== false) {
      await db.execute(sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
        VALUES (${lead[0].id}::uuid, ${campaign}, ${org}, ARRAY[${brand}]::text[], 'served', now())`);
    }
    people[key] = { leadId: lead[0].id, email, phone };
  }

  beforeAll(async () => {
    // The outreach copy must be whole for the read to answer at all (the email half).
    await ingestOutreachFactsPage({ facts: [], nextCursor: "0", hasMore: false });
    for (const k of ["asker", "stopper", "thanker", "phoneOnly", "withdrawn", "stranger"]) {
      await seedLead(k, { phoneMethod: k === "phoneOnly", atBrand: k !== "stranger" });
    }
  });
  beforeEach(() => {
    judged.length = 0;
    judgeFails = false;
  });
  afterAll(async () => {
    for (const t of ["leads_campaigns", "crm_facts", "personal_message_judgments"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${org}`);
    }
  });

  it("lists who wrote last on WhatsApp after our latest answer, judged once; a closing word, a stop request, a stranger and a withdrawn message are not listed", async () => {
    const p = people;
    const withdrawnIn = msg({ email: p.withdrawn.email }, "in", "2026-10-12T10:05:00Z", "Can we talk?");
    await feed(
      msg({ email: p.asker.email }, "out", "2026-10-12T10:00:00Z", "Hey, what are you looking to grow?"),
      msg({ email: p.asker.email }, "in", "2026-10-12T10:02:00Z", "More clients. How much is it?"),
      msg({ email: p.stopper.email }, "out", "2026-10-12T10:00:00Z", "Hey"),
      msg({ email: p.stopper.email }, "in", "2026-10-12T10:01:00Z", "Please stop messaging me"),
      msg({ email: p.thanker.email }, "out", "2026-10-12T10:00:00Z", "Here is the link you asked for"),
      msg({ email: p.thanker.email }, "in", "2026-10-12T10:01:00Z", "Great, thanks"),
      msg({ phone: p.phoneOnly.phone }, "in", "2026-10-12T10:03:00Z", "Yeah"),
      withdrawnIn,
      crmFact({ email: p.withdrawn.email }, "withdrawn", null, { reason: "vendor_record_changed" }, withdrawnIn.factId),
      msg({ email: p.stranger.email }, "in", "2026-10-12T10:04:00Z", "Hello?"),
    );

    const body = await listed();
    expect(ids(body)).toEqual([p.asker.leadId, p.phoneOnly.leadId].sort());
    const asker = body.people.find((x) => x.leadId === p.asker.leadId)!;
    expect(asker.lastMessage).toMatchObject({ kind: "question", label: "question", channel: "whatsapp", campaignId: null });
    const phoneOnly = body.people.find((x) => x.leadId === p.phoneOnly.leadId)!;
    expect(phoneOnly.lastMessage).toMatchObject({ kind: "other", label: "reply", channel: "whatsapp" });
    expect(body.personalMessages).toMatchObject({ complete: true, judged: 4 });
    expect(judged.sort()).toEqual(["Great, thanks", "More clients. How much is it?", "Please stop messaging me", "Yeah"].sort());

    // Frozen: a second read judges nothing.
    judged.length = 0;
    const again = await listed();
    expect(ids(again)).toEqual(ids(body));
    expect(judged).toEqual([]);
  });

  it("drops a person when we answer on WhatsApp, and a stop request stays sticky after a later message", async () => {
    const p = people;
    await feed(
      msg({ email: p.asker.email }, "out", "2026-10-12T10:10:00Z", "It is free to start, want a call?"),
      msg({ email: p.stopper.email }, "in", "2026-10-12T10:11:00Z", "Actually, what do you do?"),
    );
    const body = await listed();
    expect(ids(body)).toEqual([p.phoneOnly.leadId]);
  });

  it("a message that cannot be judged is listed as waiting, and the gap is stated", async () => {
    judgeFails = true;
    await feed(msg({ email: people.thanker.email }, "in", "2026-10-12T10:20:00Z", "One more thing"));
    const body = await listed();
    expect(ids(body)).toEqual([people.phoneOnly.leadId, people.thanker.leadId].sort());
    expect(body.personalMessages).toMatchObject({ complete: false });
    expect((body.personalMessages.unjudged as unknown[]).length).toBe(1);
  });
});
