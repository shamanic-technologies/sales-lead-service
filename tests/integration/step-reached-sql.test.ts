/**
 * GET /internal/brands/:brandId/step-reached against a REAL database: who reached a catalogue step at the brand,
 * read off the CRM fact copy AND the outcome ledger (FACT-NOT-FOLLOWED-1014).
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, conversionEvents, crmFacts } = await import("../../src/db/schema.js");
const { PEOPLE_FACTS_FEED } = await import("../../src/lib/crm-fact-feed.js");
const routes = (await import("../../src/routes/step-reached.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("step-reached read against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(routes);

  const addr = (name: string) => `${name}-${tag}@example.com`;

  async function crmFact(
    over: Partial<typeof crmFacts.$inferInsert> & { emails: string[]; type: string },
  ): Promise<string> {
    const factId = randomUUID();
    await db.insert(crmFacts).values({
      factId,
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:${over.emails[0] ?? randomUUID()}`,
      fullName: null,
      phones: [],
      occurredAt: new Date("2026-10-14T10:00:00.000Z"),
      dateBasis: "created_at",
      source: "clerk",
      sourceRef: `ref-${randomUUID()}`,
      payload: {},
      raw: { itest: true },
      ...over,
    });
    return factId;
  }

  async function withdraw(factId: string): Promise<void> {
    await crmFact({ emails: [], type: "withdrawn", withdrawnOf: factId, occurredAt: null, dateBasis: "none" });
  }

  const get = (query: string, org = orgId, brand = brandId) =>
    request(app)
      .get(`/internal/brands/${brand}/step-reached?${query}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", org);

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, '0', now())
      ON CONFLICT (feed) DO UPDATE SET caught_up_at = COALESCE(crm_feed_cursors.caught_up_at, now())`);
  });

  beforeAll(async () => {
    // Signups: Marie (Clerk, named, with a phone), Paul (PostHog, earlier, then again later), a withdrawn one,
    // one before the window, one with no email, one in another brand and another org.
    await crmFact({ emails: [addr("Marie").toUpperCase()], type: "signup", fullName: "Marie Curie", phones: ["+33 6 12 34 56 78"], occurredAt: new Date("2026-10-14T10:05:00Z") });
    await crmFact({ emails: [addr("paul")], type: "signup", source: "posthog", occurredAt: new Date("2026-10-14T10:20:00Z") });
    await crmFact({ emails: [addr("paul")], type: "signup", source: "distribute_platform", occurredAt: new Date("2026-10-14T10:10:00Z") });
    const gone = await crmFact({ emails: [addr("gone")], type: "signup", occurredAt: new Date("2026-10-14T10:15:00Z") });
    await withdraw(gone);
    await crmFact({ emails: [addr("old")], type: "signup", occurredAt: new Date("2026-10-01T10:00:00Z") });
    await crmFact({ emails: [], personKey: `nomail-${tag}`, type: "signup", occurredAt: new Date("2026-10-14T10:30:00Z") });
    await crmFact({ emails: [addr("otherbrand")], brandId: otherBrandId, type: "signup" });
    await crmFact({ emails: [addr("otherorg")], orgId: otherOrgId, type: "signup" });

    // Visits: a PostHog session of Marie's (no name on the fact: filled from her signup), and of a stranger.
    await crmFact({ emails: [addr("marie")], type: "website_visit", source: "posthog", occurredAt: new Date("2026-10-14T09:00:00Z"), payload: { sessionId: "s1" } });
    await crmFact({ emails: [addr("visitor")], type: "website_visit", source: "posthog", occurredAt: new Date("2026-10-14T11:00:00Z") });

    // Payments: Marie paid (succeeded); Paul's payment failed; Zoe's was wholly refunded; Kim's partly refunded.
    await crmFact({ emails: [addr("marie")], type: "payment", source: "stripe", occurredAt: new Date("2026-10-14T12:00:00Z"), payload: { status: "succeeded", amountMinor: 5000, amountRefunded: 0, currency: "usd" } });
    await crmFact({ emails: [addr("paul")], type: "payment", source: "stripe", payload: { status: "failed", amountMinor: 5000, amountRefunded: 0 } });
    await crmFact({ emails: [addr("zoe")], type: "payment", source: "stripe", payload: { status: "succeeded", amountMinor: 5000, amountRefunded: 5000 } });
    await crmFact({ emails: [addr("kim"), addr("kim-alt")], type: "payment", source: "stripe", payload: { status: "succeeded", amountMinor: 5000, amountRefunded: 1000 } });

    // The ledger: a hand-stated sale on a lead with two addresses; a withdrawn sale; a tracker signup with its own email.
    const [lead] = await db.insert(leads).values({ firstName: "Ann", lastName: "Lee" }).returning({ id: leads.id });
    for (const value of [addr("ann"), addr("ann-work")]) {
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value, source: "itest" });
    }
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "phone", value: `+4477009${tag.slice(0, 5)}`, source: "itest" });
    const base = { orgId, brandId, matchConfidence: "deterministic", attributionStatus: "attributed" } as const;
    await db.insert(conversionEvents).values({ ...base, event: "sale", matchedLeadId: lead.id, source: "manual", valueCents: 100, costCents: 0, receivedAt: new Date("2026-10-14T13:00:00Z") });
    const [lead2] = await db.insert(leads).values({ firstName: "Wd" }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: lead2.id, channel: "email", value: addr("withdrawn-sale"), source: "itest" });
    await db.insert(conversionEvents).values({ ...base, event: "sale", matchedLeadId: lead2.id, source: "manual", valueCents: 100, costCents: 0, withdrawnAt: new Date() });
    await db.insert(conversionEvents).values({ orgId, brandId, event: "signup", email: addr("Tracked"), matchConfidence: "unmatched", attributionStatus: "unmatched", source: "tracker", receivedAt: new Date("2026-10-14T10:40:00Z") });
  });

  it("lists the signups since T with their earliest reach in the window, name and phone; never the withdrawn, older, email-less or foreign", async () => {
    const res = await get(`step=signup&since=${encodeURIComponent("2026-10-14T10:00:00Z")}`);
    expect(res.status).toBe(200);
    expect(res.body.step).toBe("signup");
    expect(res.body.people).toEqual([
      { email: addr("marie"), name: "Marie Curie", phone: "+33 6 12 34 56 78", reachedAt: "2026-10-14T10:05:00.000Z" },
      { email: addr("paul"), name: null, phone: null, reachedAt: "2026-10-14T10:10:00.000Z" },
      { email: addr("tracked"), name: null, phone: null, reachedAt: "2026-10-14T10:40:00.000Z" },
    ]);
  });

  it("since is inclusive and the window moves reachedAt to the earliest reach at/after it", async () => {
    const res = await get(`step=signup&since=${encodeURIComponent("2026-10-14T10:20:00Z")}`);
    expect(res.body.people.map((p: { email: string; reachedAt: string }) => [p.email, p.reachedAt])).toEqual([
      [addr("paul"), "2026-10-14T10:20:00.000Z"],
      [addr("tracked"), "2026-10-14T10:40:00.000Z"],
    ]);
  });

  it("a PostHog session is a website visit; a visit fact without a name takes the person's name from their other facts", async () => {
    const res = await get(`step=website_visit&since=${encodeURIComponent("2026-10-14T00:00:00Z")}`);
    expect(res.body.people).toEqual([
      { email: addr("marie"), name: "Marie Curie", phone: "+33 6 12 34 56 78", reachedAt: "2026-10-14T09:00:00.000Z" },
      { email: addr("visitor"), name: null, phone: null, reachedAt: "2026-10-14T11:00:00.000Z" },
    ]);
  });

  it("paid_client: a standing payment or a live ledger sale; never a failed, wholly refunded or withdrawn one", async () => {
    const res = await get(`step=paid_client&since=${encodeURIComponent("2026-10-01T00:00:00Z")}`);
    const emails = res.body.people.map((p: { email: string }) => p.email);
    expect(emails).toEqual([addr("kim"), addr("marie"), addr("ann")]);
    const ann = res.body.people.find((p: { email: string }) => p.email === addr("ann"));
    expect(ann).toMatchObject({ name: "Ann Lee", phone: `+4477009${tag.slice(0, 5)}`, reachedAt: "2026-10-14T13:00:00.000Z" });
  });

  it("email mode: ever reached (any of the person's addresses, case-insensitive) vs never", async () => {
    const marie = await get(`step=paid_client&email=${encodeURIComponent(addr("MARIE"))}`);
    expect(marie.body.people).toEqual([
      { email: addr("marie"), name: "Marie Curie", phone: "+33 6 12 34 56 78", reachedAt: "2026-10-14T12:00:00.000Z" },
    ]);
    const annWork = await get(`step=paid_client&email=${encodeURIComponent(addr("ann-work"))}`);
    expect(annWork.body.people).toHaveLength(1);
    expect(annWork.body.people[0].email).toBe(addr("ann-work"));
    const kimAlt = await get(`step=paid_client&email=${encodeURIComponent(addr("kim-alt"))}`);
    expect(kimAlt.body.people).toHaveLength(1);
    for (const never of ["paul", "zoe", "withdrawn-sale", "visitor"]) {
      const r = await get(`step=paid_client&email=${encodeURIComponent(addr(never))}`);
      expect(r.status).toBe(200);
      expect(r.body.people).toEqual([]);
    }
    const old = await get(`step=signup&email=${encodeURIComponent(addr("old"))}`);
    expect(old.body.people[0].reachedAt).toBe("2026-10-01T10:00:00.000Z");
    const otherOrg = await get(`step=signup&email=${encodeURIComponent(addr("otherorg"))}`);
    expect(otherOrg.body.people).toEqual([]);
  });

  it("meeting_attended: a booked meeting whose time passed with no cancel is held at its end (MEETING-ATTENDED-SOURCE-1028)", async () => {
    const appt = (email: string, ref: string, startsAt: string, endsAt: string) =>
      crmFact({ emails: [email], type: "meeting_booked", source: "gohighlevel", sourceRef: ref, payload: { via: "appointment", startsAt, endsAt } });
    await appt(addr("met"), `met-${tag}`, "2026-10-20T15:00:00.000Z", "2026-10-20T15:30:00.000Z");
    await appt(addr("cxl"), `cxl-${tag}`, "2026-10-20T15:00:00.000Z", "2026-10-20T15:30:00.000Z");
    await crmFact({ emails: [addr("cxl")], type: "meeting_not_held", source: "gohighlevel", sourceRef: `cxl-${tag}`, payload: { reason: "cancelled" } });
    await appt(addr("soon"), `soon-${tag}`, "2999-01-01T15:00:00.000Z", "2999-01-01T15:30:00.000Z");

    const res = await get(`step=meeting_attended&since=${encodeURIComponent("2026-10-20T00:00:00Z")}`);
    expect(res.status).toBe(200);
    expect(res.body.people.map((p: { email: string; reachedAt: string }) => [p.email, p.reachedAt])).toEqual([
      [addr("met"), "2026-10-20T15:30:00.000Z"],
    ]);
    expect((await get(`step=meeting_attended&since=${encodeURIComponent("2026-10-21T00:00:00Z")}`)).body.people).toEqual([]);
    expect((await get(`step=meeting_attended&email=${encodeURIComponent(addr("met"))}`)).body.people).toHaveLength(1);
    expect((await get(`step=meeting_attended&email=${encodeURIComponent(addr("cxl"))}`)).body.people).toEqual([]);
  });

  it("refuses unknown and unobservable steps by name, and anything but exactly one of since/email", async () => {
    expect((await get("step=banana&since=2026-10-14T00:00:00Z")).body.error).toBe("unknown_step");
    expect((await get("step=conversation&since=2026-10-14T00:00:00Z")).body.error).toBe("step_not_observable");
    expect((await get("since=2026-10-14T00:00:00Z")).body.error).toBe("step_required");
    expect((await get("step=signup")).body.error).toBe("since_or_email_required");
    expect((await get(`step=signup&since=2026-10-14T00:00:00Z&email=${addr("a")}`)).body.error).toBe("since_or_email_required");
    expect((await get("step=signup&since=yesterday")).body.error).toBe("invalid_since");
    expect((await get("step=signup&email=nobody")).body.error).toBe("invalid_email");
  });
});
