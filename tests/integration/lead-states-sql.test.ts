/**
 * LEAD-STATES-1024 against a REAL database: when each lead first reached each state at a brand
 * (src/lib/lead-states-read.ts), read through GET /internal/lead-states and POST /internal/lead-states/by-lead.
 * Every read is scoped to this file's org: the suite's files share one database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, conversionEvents, crmFacts } = await import("../../src/db/schema.js");
const routes = (await import("../../src/routes/lead-states.js")).default;
const { resetLeadStateCatalogueCache } = await import("../../src/lib/lead-states-read.js");

// features-service's step catalogue (LEAD-STATES-1024): which step reaches which state.
const I = (key: string, leadState: string, leadStateRank: number) => ({ key, leadState, leadStateFamily: "interest", leadStateRank });
const CATALOGUE_ROWS = [
  I("conversation", "lead_interested", 1), I("signup", "lead_interested", 1), I("form_submitted", "lead_interested", 1),
  I("booking_call", "lead_interested", 1), I("lead_interested", "lead_interested", 1), I("meeting_booked", "meeting_booked", 2),
  I("meeting_attended", "meeting_attended", 3), I("paid_client", "paid_client", 4), I("purchase", "paid_client", 4),
  { key: "website_visit", leadState: "lead_visited", leadStateFamily: "visit", leadStateRank: 1 },
  { key: "lead_visited", leadState: "lead_visited", leadStateFamily: "visit", leadStateRank: 1 },
  { key: "lead_found", leadState: null, leadStateFamily: null, leadStateRank: null },
];

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead states against a real database", () => {
  const orgId = `itest-ls-${randomUUID()}`;
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(express.json());
  app.use(routes);
  const created: string[] = [];
  const L: Record<string, string> = {};

  async function newLead(key: string, email?: string): Promise<string> {
    const [lead] = await db.insert(leads).values({ firstName: "Itest", lastName: key }).returning({ id: leads.id });
    created.push(lead.id);
    L[key] = lead.id;
    if (email) await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'email', ${email}, 'itest')`);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${lead.id}::uuid, ${randomUUID()}, ${orgId}, ARRAY[${brandId}]::text[], 'served', '2026-09-01T00:00:00Z')`);
    return lead.id;
  }

  async function timeline(leadId: string, label: string, source: string, at: string, classification?: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, occurred_at, label, source, source_ref, detail)
      VALUES (${`${source}:itest-${randomUUID()}`}, ${orgId}, ${brandId}, ${leadId}::uuid, ${at}::timestamptz, ${label}, ${source}, 'itest',
              ${JSON.stringify(classification ? { classification } : {})}::jsonb)`);
  }

  async function ledger(leadId: string, event: string, at: string | null, over: Partial<typeof conversionEvents.$inferInsert> = {}): Promise<void> {
    await db.insert(conversionEvents).values({
      brandId,
      orgId,
      event,
      matchedLeadId: leadId,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "crm",
      receivedAt: at === null ? null : new Date(at),
      dedupeSignature: `itest:${randomUUID()}`,
      ...over,
    });
  }

  beforeAll(async () => {
    resetLeadStateCatalogueCache();
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/public/catalogue/steps")) return new Response(JSON.stringify({ rows: CATALOGUE_ROWS }), { status: 200 });
        return realFetch(input, init);
      }),
    );
    // The AC lead: three positive replies, a later meeting, and a reply that is NOT positive.
    const ac = await newLead("ac");
    await timeline(ac, "interested", "reply", "2026-10-01T09:00:00Z", "positive");
    await timeline(ac, "interested", "reply", "2026-10-02T09:00:00Z", "positive");
    await timeline(ac, "question_answerable", "reply", "2026-10-03T09:00:00Z", "positive");
    await timeline(ac, "not_interested", "reply", "2026-09-20T09:00:00Z", "negative");
    await ledger(ac, "meeting_booked", "2026-10-05T10:00:00Z");

    // Booked with no reply: interested at the booking. A withdrawn sale counts nowhere.
    const booked = await newLead("booked");
    await ledger(booked, "meeting_booked", "2026-10-07T10:00:00Z");
    await ledger(booked, "sale", "2026-10-08T10:00:00Z", { withdrawnAt: new Date() });

    // Visits: twelve clicks = one visit at the first; a site session seen by the brand's analytics earlier wins.
    const clicker = await newLead("clicker", `clicker-${tag}@example.com`);
    for (let i = 0; i < 12; i++) await timeline(clicker, "website_visit", "outreach", `2026-10-${String(10 + i).padStart(2, "0")}T08:00:00Z`);
    await db.insert(crmFacts).values({
      factId: randomUUID(),
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:clicker-${tag}@example.com`,
      emails: [`Clicker-${tag}@example.com`],
      phones: [],
      type: "website_visit",
      occurredAt: new Date("2026-10-09T08:00:00Z"),
      dateBasis: "occurred_at",
      source: "posthog",
      sourceRef: `ref-${randomUUID()}`,
      payload: {},
      raw: { itest: true },
    });

    // A WhatsApp message judged interest; an "already a customer" reply sale (undated).
    const wa = await newLead("wa");
    await db.execute(sql`
      INSERT INTO personal_message_judgments (fact_id, org_id, brand_id, lead_id, occurred_at, verdict, confidence, model)
      VALUES (${`itest-${randomUUID()}`}, ${orgId}, ${brandId}, ${wa}::uuid, '2026-10-04T12:00:00Z', 'waits_interest', 0.9, 'itest')`);
    const already = await newLead("already");
    await ledger(already, "sale", null, { source: "reply" });

    // A lead the org marked not a person is never returned.
    const robot = await newLead("robot");
    await ledger(robot, "meeting_booked", "2026-10-07T10:00:00Z");
    await db.execute(sql`INSERT INTO not_a_person_marks (org_id, lead_id, basis) VALUES (${orgId}, ${robot}::uuid, 'stated')`);

    // A signup on the ledger makes the lead interested (the catalogue says so), never visited.
    const signedUp = await newLead("signedUp");
    await ledger(signedUp, "signup", "2026-10-06T10:00:00Z");

    // A lead with no state is absent.
    await newLead("nothing");
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.execute(sql`DELETE FROM not_a_person_marks WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM personal_message_judgments WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM crm_facts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_timeline_facts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    for (const id of created) await db.execute(sql`DELETE FROM leads WHERE id = ${id}::uuid`);
  });

  async function walk(limit: number) {
    const rows: Array<{ leadId: string; brandId: string; states: Record<string, { reachedAt: string | null; basis: string; impliedBy: string | null } | null> }> = [];
    let cursor: string | null = null;
    do {
      const res = await request(app)
        .get(`/internal/lead-states?limit=${limit}&orgId=${orgId}${cursor ? `&cursor=${cursor}` : ""}`)
        .set("x-api-key", "test-api-key");
      expect(res.status).toBe(200);
      rows.push(...res.body.leads);
      cursor = res.body.nextCursor;
    } while (cursor);
    return new Map(rows.map((r) => [r.leadId, r.states]));
  }

  it("3 positive replies then a meeting = one interested at the FIRST reply, one meeting booked", async () => {
    const s = (await walk(100)).get(L.ac)!;
    expect(s.lead_interested).toEqual({ reachedAt: "2026-10-01T09:00:00.000Z", basis: "positive_reply", impliedBy: null });
    expect(s.meeting_booked).toEqual({ reachedAt: "2026-10-05T10:00:00.000Z", basis: "meeting_booked", impliedBy: null });
    expect(s.meeting_attended).toBeNull();
    expect(s.paid_client).toBeNull();
    expect(s.lead_visited).toBeNull();
  });

  it("a booking with no reply is interested at the booking; a withdrawn sale is no state", async () => {
    const s = (await walk(100)).get(L.booked)!;
    expect(s.lead_interested).toEqual({ reachedAt: "2026-10-07T10:00:00.000Z", basis: "meeting_booked", impliedBy: "meeting_booked" });
    expect(s.paid_client).toBeNull();
  });

  it("twelve clicks and a site session = ONE visit at the earliest; a click never makes them interested", async () => {
    const s = (await walk(100)).get(L.clicker)!;
    expect(s.lead_visited).toEqual({ reachedAt: "2026-10-09T08:00:00.000Z", basis: "site_session", impliedBy: null });
    expect(s.lead_interested).toBeNull();
  });

  it("a personal message judged interest; an undated 'already a customer' reaches the ladder with no date", async () => {
    const m = await walk(100);
    expect(m.get(L.wa)!.lead_interested).toEqual({ reachedAt: "2026-10-04T12:00:00.000Z", basis: "positive_message", impliedBy: null });
    expect(m.get(L.already)!.paid_client).toEqual({ reachedAt: null, basis: "sale", impliedBy: null });
    expect(m.get(L.already)!.lead_interested).toEqual({ reachedAt: null, basis: "sale", impliedBy: "paid_client" });
  });

  it("not-a-person and state-less leads are absent; a page of 1 walks the same set", async () => {
    const all = await walk(100);
    expect(all.has(L.robot)).toBe(false);
    expect(all.has(L.nothing)).toBe(false);
    expect([...all.keys()].sort()).toEqual([L.ac, L.booked, L.clicker, L.wa, L.already, L.signedUp].sort());
    const paged = await walk(1);
    expect([...paged.keys()].sort()).toEqual([...all.keys()].sort());
  });

  it("a signup makes the lead interested at the signup, never visited", async () => {
    const s = (await walk(100)).get(L.signedUp)!;
    expect(s.lead_interested).toEqual({ reachedAt: "2026-10-06T10:00:00.000Z", basis: "signup", impliedBy: null });
    expect(s.lead_visited).toBeNull();
  });

  it("by-lead answers the same rows for the asked leads only", async () => {
    const res = await request(app).post("/internal/lead-states/by-lead").set("x-api-key", "test-api-key").send({ leadIds: [L.ac, L.nothing] });
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0]).toMatchObject({ orgId, brandId, leadId: L.ac });
  });

  it("refuses a missing limit and a foreign cursor", async () => {
    expect((await request(app).get("/internal/lead-states").set("x-api-key", "test-api-key")).status).toBe(400);
    expect((await request(app).get("/internal/lead-states?limit=10&cursor=abc").set("x-api-key", "test-api-key")).status).toBe(400);
  });
});
