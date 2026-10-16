/**
 * EVERY-OUTCOME-FIRES-1015 against a REAL database: every outcome a person reaches rings campaign-service's trigger
 * door ONCE (src/lib/outcome-triggers.ts). The siblings are faked at `fetch`; campaign-service's door is recorded.
 *
 *   AC1 a stated meeting booked records exactly one `meeting_booked` event; re-marking records none.
 *   AC2 a lead found records exactly one `lead_found` event; finding the same person again records none.
 *   AC3 a positive reply / a form submission (fired by instantly-service / crm-service) records nothing here.
 *   No back-fill; a failed delivery is kept and retried; a refusal is kept and never resent.
 * Every pass is scoped to this file's org: the suite's files share one database and run in parallel (an unscoped
 * pass read brand-transfer-sql's seeded sale and moved its count).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, conversionEvents, crmFacts, followupActions, outcomeTriggerFires } = await import(
  "../../src/db/schema.js"
);
const { sweepOutcomeTriggers, noteLeadFound, drainOutcomeTriggerFires, resetOutcomeTriggerCatalogue } = await import(
  "../../src/lib/outcome-triggers.js"
);

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

/** The served catalogue's trigger list (2026-10-15), the fields read. */
const CATALOGUE = {
  triggers: [
    { id: "on_demand", type: "condition", outcomeKey: null, firedBy: "campaign-service", coded: true },
    { id: "positive_reply_received", type: "outcome", outcomeKey: "conversation", firedBy: "instantly-service", coded: true },
    { id: "website_visited", type: "outcome", outcomeKey: "website_visit", firedBy: "lead-service", coded: false },
    { id: "booking_call_started", type: "outcome", outcomeKey: "booking_call", firedBy: "lead-service", coded: false },
    { id: "meeting_booked", type: "outcome", outcomeKey: "meeting_booked", firedBy: "lead-service", coded: false },
    { id: "meeting_attended", type: "outcome", outcomeKey: "meeting_attended", firedBy: "lead-service", coded: false },
    { id: "signed_up", type: "outcome", outcomeKey: "signup", firedBy: "lead-service", coded: false },
    { id: "form_submitted", type: "outcome", outcomeKey: "form_submitted", firedBy: "crm-service", coded: true },
    { id: "purchase_made", type: "outcome", outcomeKey: "purchase", firedBy: "lead-service", coded: false },
    { id: "lead_found", type: "outcome", outcomeKey: "lead_found", firedBy: "lead-service", coded: false },
    { id: "paid_client", type: "outcome", outcomeKey: "paid_client", firedBy: "crm-service", coded: false },
  ],
};

interface DoorCall {
  orgId: string | null;
  body: Record<string, unknown>;
}

describe.skipIf(!hasRealDatabase)("outcome triggers against a real database", () => {
  let orgId: string;
  let brandId: string;
  let offerId: string;
  let outreachId: string;
  let otherCampaignId: string;
  let callCampaignId: string;
  let tag: string;
  let door: DoorCall[];
  let doorAnswer: () => Response;
  /** What campaign-service's for-person read answers (another caller's earlier event of the trigger, or null). */
  let priorAnswer: (url: URL) => Response;
  let priorAsks: URL[];
  const addr = (name: string) => `${name}-${tag}@example.com`;

  function stubSiblings(): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const org = headers.get("x-org-id");
        if (url.endsWith("/public/channels")) return new Response(JSON.stringify(CATALOGUE), { status: 200 });
        if (url.includes("/trigger-events/for-person?")) {
          const asked = new URL(url);
          priorAsks.push(asked);
          return priorAnswer(asked);
        }
        if (url.endsWith("/internal/trigger-events")) {
          door.push({ orgId: org, body: JSON.parse(String(init?.body)) });
          return doorAnswer();
        }
        if (url.endsWith("/campaigns")) {
          const campaigns =
            org === orgId
              ? [
                  { id: outreachId, offerId, legKey: "lead_found_to_conversation", featureSlug: "sales-cold-email-outreach" },
                  { id: otherCampaignId, offerId, legKey: "lead_found_to_conversation", featureSlug: "sales-cold-email-outreach" },
                  { id: callCampaignId, offerId, legKey: "conversation_to_booking_call", featureSlug: "ai-instant-call" },
                ]
              : [];
          return new Response(JSON.stringify({ campaigns }), { status: 200 });
        }
        if (url.includes("/internal/brands/") && url.endsWith("/offers")) {
          const offers = url.includes(brandId) && org === orgId ? [{ offerId, status: "active" }, { offerId: randomUUID(), status: "archived" }] : [];
          return new Response(JSON.stringify({ offers }), { status: 200 });
        }
        return new Response(`unexpected ${url}`, { status: 599 });
      }),
    );
  }

  const ours = () => door.filter((c) => c.orgId === orgId);

  async function rowsOf(where: { step?: string } = {}) {
    return db
      .select()
      .from(outcomeTriggerFires)
      .where(and(eq(outcomeTriggerFires.orgId, orgId), ...(where.step ? [eq(outcomeTriggerFires.step, where.step)] : [])));
  }

  async function seedLead(name: string): Promise<string> {
    const [lead] = await db.insert(leads).values({ firstName: name, lastName: "Staff" }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: addr(name), source: "itest" });
    await db.insert(leadsCampaigns).values({ leadId: lead.id, campaignId: outreachId, orgId, brandIds: [brandId], status: "served", servedAt: new Date() });
    return lead.id;
  }

  async function nextSeq(): Promise<bigint> {
    const [row] = (await db.execute(sql`SELECT COALESCE(max(seq), 0)::text AS m FROM crm_facts`)) as unknown as Array<{ m: string }>;
    return BigInt(row.m) + 1000n + BigInt(Math.floor(Math.random() * 1000));
  }

  async function crmFact(type: string, email: string, over: Partial<typeof crmFacts.$inferInsert> = {}): Promise<void> {
    await db.insert(crmFacts).values({
      factId: randomUUID(),
      seq: await nextSeq(),
      orgId,
      brandId,
      personKey: `email:${email}`,
      fullName: "Staff Person",
      emails: [email],
      phones: [],
      type,
      occurredAt: new Date(),
      dateBasis: "created_at",
      source: "itest",
      sourceRef: `ref-${randomUUID()}`,
      payload: {},
      raw: { itest: true },
      ...over,
    });
  }

  async function until<T>(read: () => Promise<T | undefined | false>): Promise<T | undefined> {
    for (let i = 0; i < 300; i++) {
      const v = await read();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 10));
    }
    return undefined;
  }

  beforeEach(async () => {
    orgId = randomUUID();
    brandId = randomUUID();
    offerId = randomUUID();
    outreachId = randomUUID();
    otherCampaignId = randomUUID();
    callCampaignId = randomUUID();
    tag = randomUUID().slice(0, 8);
    door = [];
    doorAnswer = () => new Response(JSON.stringify({ event: { id: randomUUID() }, replayed: false }), { status: 201 });
    priorAnswer = () => new Response(JSON.stringify({ event: null, idempotencyKey: null }), { status: 200 });
    priorAsks = [];
    resetOutcomeTriggerCatalogue();
    stubSiblings();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Armed afresh for each case: what is recorded before arming never fires.
    await db.execute(sql`DELETE FROM outcome_trigger_sweep`);
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("AC1: a stated meeting booked records exactly ONE meeting_booked event; re-marking it records none", async () => {
    const leadId = await seedLead("ann");
    const stated = {
      orgId,
      brandId,
      event: "meeting_booked",
      matchedLeadId: leadId,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "manual",
      campaignId: outreachId,
      costCents: 0,
      receivedAt: new Date(),
    } as const;
    await db.insert(conversionEvents).values(stated);

    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours()).toHaveLength(1);
    expect(ours()[0].body).toMatchObject({
      triggerId: "meeting_booked",
      brandId,
      offerId,
      leadId,
      person: { email: addr("ann") },
      idempotencyKey: `lead-service:outcome:meeting_booked:${brandId}:${offerId}:lead:${leadId}`,
    });
    expect((await rowsOf({ step: "meeting_booked" })).map((r) => r.status)).toEqual(["delivered"]);

    // A re-sync reads nothing new; re-marking the person (a second statement row) is the same person: nothing sent.
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    await db.insert(conversionEvents).values({ ...stated, receivedAt: new Date() });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours()).toHaveLength(1);
    expect((await rowsOf({ step: "meeting_booked" })).map((r) => r.status).sort()).toEqual(["already_fired", "delivered"]);
  });

  it("AC2: a lead found records exactly ONE lead_found event; the same person found again for the offer records none", async () => {
    const leadId = await seedLead("bob");
    noteLeadFound({ orgId, brandId, leadId, email: addr("bob"), campaignId: outreachId, offerId });
    await until(async () => (await rowsOf({ step: "lead_found" })).some((r) => r.status === "delivered"));
    noteLeadFound({ orgId, brandId, leadId, email: addr("bob"), campaignId: otherCampaignId, offerId });
    await until(async () => (await rowsOf({ step: "lead_found" })).length === 2);

    expect(ours()).toHaveLength(1);
    expect(ours()[0].body).toMatchObject({ triggerId: "lead_found", brandId, offerId, leadId, person: { email: addr("bob") } });
    expect((await rowsOf({ step: "lead_found" })).map((r) => r.status).sort()).toEqual(["already_fired", "delivered"]);
  });

  it("a lead found by a serve that could not read its offer names the serve campaign's offer", async () => {
    const leadId = await seedLead("cid");
    noteLeadFound({ orgId, brandId, leadId, email: addr("cid"), campaignId: outreachId, offerId: null });
    await until(async () => (await rowsOf({ step: "lead_found" })).some((r) => r.status === "delivered"));
    expect(ours().map((c) => c.body.offerId)).toEqual([offerId]);
  });

  it("AC3: a positive reply and a form submission (fired by instantly-service / crm-service) send nothing from here", async () => {
    const leadId = await seedLead("cy");
    await db.insert(conversionEvents).values({
      orgId,
      brandId,
      event: "positive_reply",
      matchedLeadId: leadId,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "crm",
      receivedAt: new Date(),
    });
    await crmFact("form_submitted", addr("cy"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });

    expect(ours()).toEqual([]);
    const rows = await rowsOf();
    expect(rows.map((r) => [r.step, r.status, r.skipReason])).toEqual([["form_submitted", "skipped", "fired_by_another_service"]]);
  });

  it("the CRM's facts fire their outcome for anybody the brand knows: a signup, a payment that stands; never a failed one", async () => {
    await crmFact("signup", addr("newcomer"));
    await crmFact("payment", addr("payer"), { payload: { status: "succeeded", amountMinor: 5000, amountRefunded: 0 } });
    await crmFact("payment", addr("declined"), { payload: { status: "failed", amountMinor: 5000, amountRefunded: 0 } });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });

    const sent = ours().map((c) => [c.body.triggerId, (c.body.person as { email: string }).email, c.body.offerId]).sort();
    // Not leads: the brand's only active offer is named; no lead id.
    expect(sent).toEqual([
      ["paid_client", addr("payer"), offerId],
      ["signed_up", addr("newcomer"), offerId],
    ]);
    expect(ours().every((c) => !("leadId" in c.body))).toBe(true);
  });

  it("a CRM fact about a lead names the lead and the offers of its campaigns", async () => {
    const leadId = await seedLead("dee");
    await crmFact("meeting_attended", addr("DEE"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours().map((c) => c.body)).toEqual([expect.objectContaining({ triggerId: "meeting_attended", leadId, offerId })]);
  });

  it("a lead with no address (a WhatsApp writer) is named by its E.164 phone", async () => {
    const [lead] = await db.insert(leads).values({ firstName: "Wa" }).returning({ id: leads.id });
    const phone = `+447700${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "phone", value: phone, source: "itest" });
    await db.insert(leadsCampaigns).values({ leadId: lead.id, campaignId: outreachId, orgId, brandIds: [brandId], status: "served" });
    await db.insert(conversionEvents).values({
      orgId,
      brandId,
      event: "meeting_booked",
      matchedLeadId: lead.id,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "manual",
      costCents: 0,
      receivedAt: new Date(),
    });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours().map((c) => c.body)).toEqual([
      expect.objectContaining({ triggerId: "meeting_booked", leadId: lead.id, offerId, person: { phone } }),
    ]);
  });

  it("a scoped pass never touches another org's outcomes (the suite's files share one database)", async () => {
    const foreignOrg = randomUUID();
    await db.insert(conversionEvents).values({
      orgId: foreignOrg,
      brandId: randomUUID(),
      event: "sale",
      email: addr("foreign"),
      matchConfidence: "unmatched",
      attributionStatus: "unmatched",
      source: "tracker",
      receivedAt: new Date(),
    });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(await db.select().from(outcomeTriggerFires).where(eq(outcomeTriggerFires.orgId, foreignOrg))).toEqual([]);
  });

  it("no back-fill: an outcome before arming, or a CRM fact dated outside the window, never fires", async () => {
    const leadId = await seedLead("eve");
    await db.insert(conversionEvents).values({
      orgId,
      brandId,
      event: "meeting_booked",
      matchedLeadId: leadId,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "manual",
      receivedAt: new Date(Date.now() - 60 * 60_000),
    });
    await crmFact("meeting_booked", addr("eve"), { occurredAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) });
    await crmFact("signup", addr("undated"), { occurredAt: null });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours()).toEqual([]);
    expect(await rowsOf()).toEqual([]);
  });

  it("a booking call placed by an AI Instant Call campaign fires booking_call_started; any other act fires nothing", async () => {
    const leadId = await seedLead("fay");
    const [row] = await db.select({ id: leadsCampaigns.id }).from(leadsCampaigns).where(eq(leadsCampaigns.leadId, leadId));
    const act = { orgId, brandIds: [brandId], leadCampaignId: row.id, leadId, heldByCampaignId: outreachId, action: "acted", occurredAt: new Date() };
    await db.insert(followupActions).values({ ...act, actingCampaignId: callCampaignId });
    await db.insert(followupActions).values({ ...act, actingCampaignId: otherCampaignId });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours().map((c) => c.body)).toEqual([expect.objectContaining({ triggerId: "booking_call_started", leadId, offerId })]);
  });

  it("a door that fails keeps the fire pending and retries it; a refusal is kept and never resent", async () => {
    doorAnswer = () => new Response("down", { status: 503 });
    await crmFact("signup", addr("retry"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    const [pending] = await rowsOf({ step: "signup" });
    expect(pending).toMatchObject({ status: "pending", attempts: 1 });
    expect(pending.lastError).toMatch(/503/);

    await db.update(outcomeTriggerFires).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(outcomeTriggerFires.id, pending.id));
    doorAnswer = () => new Response(JSON.stringify({ event: { id: "evt-1" } }), { status: 201 });
    await drainOutcomeTriggerFires({ orgIds: [orgId] });
    const [delivered] = await rowsOf({ step: "signup" });
    expect(delivered).toMatchObject({ status: "delivered", campaignEventId: "evt-1", attempts: 2 });
    // Our retry and the first attempt carry the same key: campaign-service records one event.
    const keys = ours().map((c) => c.body.idempotencyKey);
    expect(new Set(keys).size).toBe(1);

    doorAnswer = () => new Response(JSON.stringify({ reason: "unknown_trigger" }), { status: 400 });
    await crmFact("signup", addr("refused"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    const refused = (await rowsOf({ step: "signup" })).find((r) => r.email === addr("refused"));
    expect(refused?.status).toBe("refused");
    const before = ours().length;
    await db.update(outcomeTriggerFires).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(outcomeTriggerFires.id, refused!.id));
    await drainOutcomeTriggerFires({ orgIds: [orgId] });
    expect(ours().length).toBe(before);
  });

  it("a brand with several active offers and a person in no campaign: nothing guessed, set aside offer_unknown", async () => {
    const otherBrand = brandId;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/public/channels")) return new Response(JSON.stringify(CATALOGUE), { status: 200 });
        if (url.endsWith("/campaigns")) return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
        if (url.endsWith("/offers")) {
          return new Response(JSON.stringify({ offers: [{ offerId: randomUUID(), status: "active" }, { offerId: randomUUID(), status: "active" }] }), { status: 200 });
        }
        door.push({ orgId: new Headers(init?.headers).get("x-org-id"), body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 201 });
      }),
    );
    await crmFact("signup", addr("multi"), { brandId: otherBrand });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours()).toEqual([]);
    expect((await rowsOf()).map((r) => [r.status, r.skipReason])).toEqual([["skipped", "offer_unknown"]]);
  });

  it("AC (STD-VOCAB 1016): each of the 8 outcomes, reached once, records exactly ONE event; reached again, none", async () => {
    const leadId = await seedLead("all");
    const [lc] = await db.select({ id: leadsCampaigns.id }).from(leadsCampaigns).where(eq(leadsCampaigns.leadId, leadId));
    const reachAll = async (servedBy: string) => {
      noteLeadFound({ orgId, brandId, leadId, email: addr("all"), campaignId: servedBy, offerId });
      await crmFact("website_visit", addr("all"));
      await crmFact("signup", addr("all"));
      await crmFact("meeting_attended", addr("all"));
      await db.insert(followupActions).values({
        orgId, brandIds: [brandId], leadCampaignId: lc.id, leadId, heldByCampaignId: outreachId, action: "acted",
        occurredAt: new Date(), actingCampaignId: callCampaignId,
      });
      const ledger = {
        orgId, brandId, matchedLeadId: leadId, matchConfidence: "deterministic", attributionStatus: "attributed",
        campaignId: outreachId, costCents: 0, receivedAt: new Date(),
      } as const;
      await db.insert(conversionEvents).values({ ...ledger, event: "meeting_booked", source: "manual" });
      // A sale the brand's website tag reported: bought on the site (Direct purchase) AND a paying client.
      await db.insert(conversionEvents).values({ ...ledger, event: "sale", source: "tracker" });
      await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
      await until(async () => (await rowsOf({ step: "lead_found" })).length > 0 && ours().some((c) => c.body.triggerId === "lead_found"));
    };

    await reachAll(outreachId);
    const fired = ours().map((c) => c.body.triggerId).sort();
    expect(fired).toEqual([
      "booking_call_started", "lead_found", "meeting_attended", "meeting_booked", "paid_client", "purchase_made", "signed_up", "website_visited",
    ]);
    expect(ours().every((c) => c.body.leadId === leadId && c.body.offerId === offerId)).toBe(true);

    // Found again by another campaign of the offer (the same serve record is never read twice).
    await reachAll(otherCampaignId);
    await until(async () => (await rowsOf({ step: "lead_found" })).length === 2);
    expect(ours().map((c) => c.body.triggerId).sort()).toEqual(fired);
    const statuses = (await rowsOf()).map((r) => r.status);
    expect(statuses.filter((s) => s === "delivered")).toHaveLength(8);
    expect(statuses.filter((s) => s === "already_fired")).toHaveLength(8);
  });

  it("Direct purchase is a sale the website tag reported; a stated sale is a paid client only", async () => {
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", email: addr("hand"), matchConfidence: "unmatched", attributionStatus: "unmatched",
      source: "manual", costCents: 0, receivedAt: new Date(),
    });
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", email: addr("site"), matchConfidence: "unmatched", attributionStatus: "unmatched",
      source: "tracker", receivedAt: new Date(),
    });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    const sent = ours().map((c) => [c.body.triggerId, (c.body.person as { email: string }).email]).sort();
    expect(sent).toEqual([
      ["paid_client", addr("hand")],
      ["paid_client", addr("site")],
      ["purchase_made", addr("site")],
    ]);
  });

  it("an occurrence another caller already pushed for the person is that fire: nothing sent, kept already_recorded", async () => {
    priorAnswer = (url) =>
      url.searchParams.get("triggerId") === "signed_up" && url.searchParams.get("email") === addr("pushed")
        ? new Response(JSON.stringify({ event: { id: "evt-client", recordedVia: "trigger_events" }, idempotencyKey: "client-key" }), { status: 200 })
        : new Response(JSON.stringify({ event: null, idempotencyKey: null }), { status: 200 });
    await crmFact("signup", addr("pushed"));
    await crmFact("signup", addr("fresh"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });

    expect(ours().map((c) => (c.body.person as { email: string }).email)).toEqual([addr("fresh")]);
    const pushed = (await rowsOf({ step: "signup" })).find((r) => r.email === addr("pushed"));
    expect(pushed).toMatchObject({ status: "skipped", skipReason: "already_recorded", campaignEventId: "evt-client", triggerId: "signed_up" });
    const asked = priorAsks.find((u) => u.searchParams.get("email") === addr("pushed"));
    expect(asked?.pathname).toBe(`/internal/offers/${offerId}/trigger-events/for-person`);
    expect(asked?.searchParams.get("brandId")).toBe(brandId);
  });

  it("our own earlier event (same key) is replayed through the door, never mistaken for another caller's", async () => {
    priorAnswer = (url) => {
      const email = url.searchParams.get("email") ?? "";
      const key = `lead-service:outcome:signup:${brandId}:${offerId}:email:${createHash("sha256").update(`email:${email}`).digest("hex").slice(0, 32)}`;
      return new Response(JSON.stringify({ event: { id: "evt-ours", recordedVia: "trigger_events" }, idempotencyKey: key }), { status: 200 });
    };
    await crmFact("signup", addr("replayed"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours()).toHaveLength(1);
    expect((await rowsOf({ step: "signup" }))[0].status).toBe("delivered");
  });

  it("a for-person read that fails keeps the fire pending (never fired on a guess)", async () => {
    priorAnswer = () => new Response("down", { status: 503 });
    await crmFact("signup", addr("blind"));
    await sweepOutcomeTriggers(new Date(), { orgIds: [orgId] });
    expect(ours()).toEqual([]);
    const [row] = await rowsOf({ step: "signup" });
    expect(row.status).toBe("pending");
    expect(row.lastError).toMatch(/prior occurrence unreadable.*503/);
  });
});
