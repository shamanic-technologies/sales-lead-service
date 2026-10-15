/**
 * A campaign that names its people, against a REAL database: the "known to the brand" evidence read
 * off `crm_facts`, the email-first identity, the ON CONFLICT idempotency, and the hand-off to the
 * follow-up queue (a filed person is found by schedule-by-email and claimed, never handed over).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const campaignCreatedAt = new Map<string, string>();
const campaignBrand = new Map<string, string | null>();

const unsubscribed = new Set<string>();
const gatewayCalls: string[] = [];
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: async (_brandId: string, _campaignId: string, items: Array<{ email: string }>) => {
    gatewayCalls.push(...items.map((i) => i.email));
    return {
      results: items
        .filter((i) => unsubscribed.has(i.email))
        .map((i) => ({ email: i.email, broadcast: { global: { email: { bounced: false, unsubscribed: true } } } })),
    };
  },
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: async (id: string) =>
    campaignBrand.has(id)
      ? {
          id,
          brandId: campaignBrand.get(id),
          brandIds: null,
          featureSlug: "sales-funnel",
          workflowSlug: "followup",
          createdAt: campaignCreatedAt.get(id) ?? "2020-01-01T00:00:00.000Z",
        }
      : null,
}));

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, crmFacts, brandPersonStatements } = await import("../../src/db/schema.js");
const { sql } = await import("drizzle-orm");
const namedPeopleRoutes = (await import("../../src/routes/named-people.js")).default;
const { lookupFollowupRowByEmail, lookupFollowupRowByPhone, writeFollowupStatement, pickFollowupCandidate } = await import(
  "../../src/lib/followup-queue.js"
);

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("named person filing against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const campaignId = randomUUID();
  const secondCampaignId = randomUUID();
  const brandlessCampaignId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const addr = (name: string) => `${name}-${tag}@example.com`;
  const createdLeadIds: string[] = [];

  campaignBrand.set(campaignId, brandId);
  campaignBrand.set(secondCampaignId, brandId);
  campaignBrand.set(brandlessCampaignId, null);
  campaignCreatedAt.set(campaignId, new Date(Date.now() - 60_000).toISOString());

  const app = express();
  app.use(express.json());
  app.use(namedPeopleRoutes);

  const file = (campaign: string, email: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post(`/orgs/campaigns/${campaign}/leads/by-email`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .set("x-run-id", randomUUID())
      .send({ email, ...extra });
  const stated = (triggerEventId = randomUUID()) => ({ statedBy: { triggerEventId, triggerId: "email_pushed_via_api" } });
  const humanIds: string[] = [];

  async function crmFact(email: string, over: Partial<typeof crmFacts.$inferInsert> = {}): Promise<string> {
    const factId = randomUUID();
    await db.insert(crmFacts).values({
      factId,
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:${email}`,
      fullName: "Marie Curie",
      emails: [email],
      phones: [],
      type: "signup",
      occurredAt: new Date("2026-10-01T10:00:00.000Z"),
      dateBasis: "occurred_at",
      source: "clerk",
      sourceRef: `ref-${randomUUID()}`,
      payload: {},
      raw: { itest: true },
      ...over,
    });
    return factId;
  }

  afterAll(async () => {
    await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.campaignId, [campaignId, secondCampaignId]));
    await db.delete(crmFacts).where(eq(crmFacts.orgId, orgId));
    await db.delete(brandPersonStatements).where(eq(brandPersonStatements.orgId, orgId));
    if (humanIds.length) {
      await db.execute(sql`DELETE FROM human_fact_copies WHERE human_id = ANY(${sql.param(humanIds)}::uuid[])`);
    }
    if (createdLeadIds.length) {
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, createdLeadIds));
      await db.delete(leads).where(inArray(leads.id, createdLeadIds));
    }
  });

  it("files a signup the brand's CRM knows: a new lead, its email registered, one served row of the brand", async () => {
    await crmFact(addr("marie"));
    const res = await file(campaignId, addr("marie").toUpperCase());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "filed", campaignId, brandId, email: addr("marie") });
    createdLeadIds.push(res.body.leadId);

    const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
    expect(lead).toMatchObject({ name: "Marie Curie", firstName: "Marie", lastName: "Curie" });
    const emails = await db.select().from(leadContactMethods).where(eq(leadContactMethods.leadId, res.body.leadId));
    expect(emails.map((e) => e.value)).toEqual([addr("marie")]);
    const [row] = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.id, res.body.leadCampaignId));
    expect(row).toMatchObject({
      leadId: res.body.leadId,
      campaignId,
      orgId,
      brandIds: [brandId],
      status: "served",
      featureSlug: "sales-funnel",
      workflowSlug: "followup",
    });
    expect(row.servedAt).not.toBeNull();
  });

  it("is idempotent: the same person on the same campaign answers the same row", async () => {
    const first = await file(campaignId, addr("marie"));
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("already_filed");
    const rows = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
    expect(rows).toHaveLength(1);
    expect(first.body.leadCampaignId).toBe(rows[0].id);
  });

  it("reuses the lead owning the address on a second campaign (email-first identity)", async () => {
    const first = await file(campaignId, addr("marie"));
    const second = await file(secondCampaignId, addr("marie"));
    expect(second.status).toBe(201);
    expect(second.body.leadId).toBe(first.body.leadId);
    expect(second.body.leadCampaignId).not.toBe(first.body.leadCampaignId);
  });

  it("refuses an address the brand does not know, and writes nothing", async () => {
    const res = await file(campaignId, addr("stranger"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("person_not_known");
    const owned = await db.select().from(leadContactMethods).where(eq(leadContactMethods.value, addr("stranger")));
    expect(owned).toHaveLength(0);
  });

  it("refuses a person known only to ANOTHER brand, and one whose only fact was withdrawn", async () => {
    await crmFact(addr("elsewhere"), { brandId: otherBrandId });
    expect((await file(campaignId, addr("elsewhere"))).body.code).toBe("person_not_known");

    const factId = await crmFact(addr("gone"));
    await crmFact(addr("gone"), { type: "withdrawn", withdrawnOf: factId });
    expect((await file(campaignId, addr("gone"))).body.code).toBe("person_not_known");
  });

  it("names a campaign campaign-service does not hold, and one that states no brand", async () => {
    expect((await file(randomUUID(), addr("marie"))).body.code).toBe("campaign_not_found");
    const res = await file(brandlessCampaignId, addr("marie"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("campaign_has_no_brand");
  });

  it("hands the filed person to the follow-up queue: found by email, scheduled now, claimed (not handed over)", async () => {
    await crmFact(addr("queue"), { type: "message_in", source: "matrix", fullName: null });
    const filed = await file(campaignId, addr("queue"));
    expect(filed.status).toBe(201);
    createdLeadIds.push(filed.body.leadId);

    const lookup = await lookupFollowupRowByEmail({ orgId, campaignId, email: addr("queue") });
    expect(lookup).toMatchObject({ ok: true, id: filed.body.leadCampaignId });

    const nowMs = Date.now();
    await writeFollowupStatement({
      orgId,
      id: filed.body.leadCampaignId,
      kind: "scheduled",
      dueAtIso: new Date(nowMs).toISOString(),
      reason: null,
      nowMs,
    });

    // Marie's row is not due; the only due row is the one just scheduled.
    const claim = await pickFollowupCandidate({
      orgId,
      campaignId,
      runId: randomUUID(),
      actingCampaignId: campaignId,
      context: { orgId },
      nowMs: nowMs + 1_000,
    });
    expect(claim.claimed?.id).toBe(filed.body.leadCampaignId);
  });
  it("files a STATED stranger (the brand's own org names them on a trigger occurrence): new lead, statement recorded, known from then on", async () => {
    const eventId = randomUUID();
    const res = await file(campaignId, addr("pushed"), { ...stated(eventId), name: "Ada Lovelace" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "filed", campaignId, brandId, email: addr("pushed"), knownBy: "statement" });
    createdLeadIds.push(res.body.leadId);
    const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
    expect(lead).toMatchObject({ name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" });

    const statements = await db.select().from(brandPersonStatements).where(eq(brandPersonStatements.email, addr("pushed")));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ orgId, brandId, source: "trigger_event", sourceRef: eventId, triggerId: "email_pushed_via_api", campaignId });

    // A retry of the same occurrence writes nothing new; a later filing WITHOUT a statement finds them known.
    expect((await file(campaignId, addr("pushed"), stated(eventId))).body.status).toBe("already_filed");
    expect(await db.select().from(brandPersonStatements).where(eq(brandPersonStatements.email, addr("pushed")))).toHaveLength(1);
    const later = await file(secondCampaignId, addr("pushed"));
    expect(later.status).toBe(201);
    expect(later.body.leadId).toBe(res.body.leadId);
  });

  it("a statement for one brand does not make the person known to another org's brand", async () => {
    await file(campaignId, addr("scoped"), stated());
    const other = await request(app)
      .post(`/orgs/campaigns/${campaignId}/leads/by-email`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", randomUUID())
      .send({ email: addr("scoped") });
    expect(other.body.code).toBe("person_not_known");
    const [row] = await db.select().from(leadContactMethods).where(eq(leadContactMethods.value, addr("scoped")));
    createdLeadIds.push(row.leadId);
  });

  it("refuses a stated person the sender reports unsubscribed, by name, writing nothing", async () => {
    unsubscribed.add(addr("unsub"));
    const res = await file(campaignId, addr("unsub"), stated());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "person_suppressed", reason: "unsubscribed" });
    expect(await db.select().from(leadContactMethods).where(eq(leadContactMethods.value, addr("unsub")))).toHaveLength(0);
    expect(await db.select().from(brandPersonStatements).where(eq(brandPersonStatements.email, addr("unsub")))).toHaveLength(0);
  });

  it("refuses a stated person whose human carries a live do_not_contact fact", async () => {
    await crmFact(addr("dnc"));
    const filed = await file(campaignId, addr("dnc"));
    createdLeadIds.push(filed.body.leadId);
    const humanId = randomUUID();
    humanIds.push(humanId);
    await db.update(leads).set({ humanId }).where(eq(leads.id, filed.body.leadId));
    await db.execute(sql`
      INSERT INTO human_fact_copies (fact_id, human_id, kind, event_id)
      VALUES (${randomUUID()}, ${humanId}, 'do_not_contact', 1)
    `);
    const res = await file(secondCampaignId, addr("dnc"), stated());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "person_suppressed", reason: "do_not_contact" });
  });

  it("without a statement the door is unchanged: no suppression read, the stranger still refused", async () => {
    gatewayCalls.length = 0;
    await crmFact(addr("plain"));
    const res = await file(campaignId, addr("plain"));
    expect(res.status).toBe(201);
    expect(res.body.knownBy).toBe("crm_fact");
    createdLeadIds.push(res.body.leadId);
    expect(gatewayCalls).toEqual([]);
    expect((await file(campaignId, addr("nobody"))).body.code).toBe("person_not_known");
  });

  describe("the pushed person's timezone (PUSHED-PERSON-TZ-1014)", () => {
    const phone = () => `+44 7700 ${Math.floor(100000 + Math.random() * 899999)}`;

    it("a +44 phone, no zone stated: Europe/London inferred, the phone recorded", async () => {
      const p = phone();
      const res = await file(campaignId, addr("ukphone"), { ...stated(), phone: p });
      expect(res.status).toBe(201);
      createdLeadIds.push(res.body.leadId);
      expect(res.body).toMatchObject({ timezone: "Europe/London", timezoneSource: "inferred" });
      const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
      expect(lead).toMatchObject({ timezone: "Europe/London", timezoneSource: "inferred", timezoneBasis: "phone_country" });
      const phones = await db
        .select()
        .from(leadContactMethods)
        .where(eq(leadContactMethods.leadId, res.body.leadId));
      expect(phones.map((m) => `${m.channel}:${m.value}`)).toContain(`phone:${p}`);
    });

    it("a .co.uk address, no zone, no phone: Europe/London from the email domain", async () => {
      const email = `employer-${tag}@acme-${tag}.co.uk`;
      const res = await file(campaignId, email, stated());
      expect(res.status).toBe(201);
      createdLeadIds.push(res.body.leadId);
      const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
      expect(lead).toMatchObject({ timezone: "Europe/London", timezoneSource: "inferred", timezoneBasis: "email_domain" });
    });

    it("a stated zone wins over the phone's country, and a later push without one keeps it", async () => {
      const res = await file(campaignId, addr("statedtz"), { ...stated(), phone: phone(), timezone: "America/New_York" });
      expect(res.status).toBe(201);
      createdLeadIds.push(res.body.leadId);
      expect(res.body).toMatchObject({ timezone: "America/New_York", timezoneSource: "stated" });
      const again = await file(secondCampaignId, addr("statedtz"), { ...stated(), phone: phone() });
      expect(again.body).toMatchObject({ timezone: "America/New_York", timezoneSource: "stated" });
      const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
      expect(lead).toMatchObject({ timezone: "America/New_York", timezoneSource: "stated", timezoneBasis: null });
    });

    it("nothing to infer from: null, unchanged behavior", async () => {
      const res = await file(campaignId, addr("nozone"), stated());
      expect(res.status).toBe(201);
      createdLeadIds.push(res.body.leadId);
      expect(res.body).toMatchObject({ timezone: null, timezoneSource: null });
      const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
      expect(lead.timezone).toBeNull();
      expect(lead.timezoneCheckedAt).not.toBeNull();
    });

    it("refuses a stated zone that is not an IANA name, writing nothing", async () => {
      const res = await file(campaignId, addr("badtz"), { ...stated(), timezone: "GMT+1" });
      expect(res.status).toBe(400);
      expect(await db.select().from(leadContactMethods).where(eq(leadContactMethods.value, addr("badtz")))).toHaveLength(0);
    });
  });

  describe("a person known by PHONE only, no email (REPLY-PHONE-ONLY-1015)", () => {
    const e164 = () => `+3367${String(Math.floor(1e7 + Math.random() * 9e7))}`;
    const fileByPhone = (campaign: string, body: Record<string, unknown>) =>
      request(app)
        .post(`/orgs/campaigns/${campaign}/leads/by-email`)
        .set("x-api-key", "test-api-key")
        .set("x-org-id", orgId)
        .set("x-run-id", randomUUID())
        .send(body);

    it("files a STATED phone + name person: 201 filed, the phone as the lead's contact method, then 200 already_filed", async () => {
      gatewayCalls.length = 0;
      const phone = e164();
      // Written with separators: canonicalized to E.164.
      const written = `${phone.slice(0, 3)} ${phone.slice(3, 4)} ${phone.slice(4, 8)}-${phone.slice(8)}`;
      const eventId = randomUUID();
      const res = await fileByPhone(campaignId, { phone: written, name: "Velveteen (WA)", ...stated(eventId) });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: "filed", campaignId, brandId, email: null, phone, knownBy: "statement", timezone: "Europe/Paris" });
      createdLeadIds.push(res.body.leadId);
      expect(gatewayCalls).toEqual([]);

      const methods = await db.select().from(leadContactMethods).where(eq(leadContactMethods.leadId, res.body.leadId));
      expect(methods.map((m) => `${m.channel}:${m.value}`)).toEqual([`phone:${phone}`]);
      const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
      expect(lead).toMatchObject({ name: "Velveteen (WA)" });
      const statements = await db.select().from(brandPersonStatements).where(eq(brandPersonStatements.phone, phone));
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchObject({ email: null, sourceRef: eventId });

      const again = await fileByPhone(campaignId, { phone, ...stated(eventId) });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ status: "already_filed", leadId: res.body.leadId, leadCampaignId: res.body.leadCampaignId });
      expect(await db.select().from(brandPersonStatements).where(eq(brandPersonStatements.phone, phone))).toHaveLength(1);

      // Known from then on (now a lead of the brand), on another campaign of the brand, without a statement: same lead.
      const later = await fileByPhone(secondCampaignId, { phone });
      expect(later.status).toBe(201);
      expect(later.body).toMatchObject({ leadId: res.body.leadId, knownBy: "brand_lead" });
    });

    it("files a phone the brand's CRM copy carries (a WhatsApp message fact), named from the fact", async () => {
      const phone = e164();
      await crmFact("", { emails: [], phones: [phone], personKey: `phone:${phone}`, type: "message_in", source: "whatsapp", fullName: "Wa Writer" });
      const res = await fileByPhone(campaignId, { phone });
      expect(res.status).toBe(201);
      createdLeadIds.push(res.body.leadId);
      expect(res.body).toMatchObject({ knownBy: "crm_fact", phone, email: null });
      const [lead] = await db.select().from(leads).where(eq(leads.id, res.body.leadId));
      expect(lead.name).toBe("Wa Writer");
    });

    it("refuses an unstated phone nobody of the brand knows, a non-E.164 phone, and a body with neither", async () => {
      expect((await fileByPhone(campaignId, { phone: e164() })).body.code).toBe("person_not_known");
      expect((await fileByPhone(campaignId, { phone: "06 12 34 56 78", ...stated() })).status).toBe(400);
      expect((await fileByPhone(campaignId, { name: "Nobody", ...stated() })).status).toBe(400);
    });

    it("reuses the lead already owning the phone; two leads holding it = ambiguous_lead, nothing filed", async () => {
      const phone = e164();
      const [owner] = await db.insert(leads).values({ name: "Owner" }).returning({ id: leads.id });
      createdLeadIds.push(owner.id);
      await db.insert(leadContactMethods).values({ leadId: owner.id, channel: "phone", value: phone, source: "itest" });
      const res = await fileByPhone(campaignId, { phone, ...stated() });
      expect(res.status).toBe(201);
      expect(res.body.leadId).toBe(owner.id);

      const [second] = await db.insert(leads).values({ name: "Twin" }).returning({ id: leads.id });
      createdLeadIds.push(second.id);
      // Stored with separators: a different value for the unique index, the same number for identification.
      await db.insert(leadContactMethods).values({ leadId: second.id, channel: "phone", value: `${phone.slice(0, 3)} ${phone.slice(3)}`, source: "itest" });
      const amb = await fileByPhone(secondCampaignId, { phone, ...stated() });
      expect(amb.status).toBe(409);
      expect(amb.body.code).toBe("ambiguous_lead");
      expect([...amb.body.leadIds].sort()).toEqual([owner.id, second.id].sort());
    });

    it("refuses a stated phone-only person whose human carries a live opt_out", async () => {
      const phone = e164();
      const [lead] = await db.insert(leads).values({ name: "Out" }).returning({ id: leads.id });
      createdLeadIds.push(lead.id);
      const humanId = randomUUID();
      humanIds.push(humanId);
      await db.update(leads).set({ humanId }).where(eq(leads.id, lead.id));
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "phone", value: phone, source: "itest" });
      await db.execute(sql`INSERT INTO human_fact_copies (fact_id, human_id, kind, event_id) VALUES (${randomUUID()}, ${humanId}, 'opt_out', 1)`);
      const res = await fileByPhone(campaignId, { phone, ...stated() });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "person_suppressed", reason: "opted_out" });
    });

    it("an email given keeps the email-first identity: the phone is only recorded beside it", async () => {
      await crmFact(addr("both"));
      const phone = e164();
      const res = await fileByPhone(campaignId, { email: addr("both"), phone });
      expect(res.status).toBe(201);
      createdLeadIds.push(res.body.leadId);
      expect(res.body.email).toBe(addr("both"));
      expect("phone" in res.body).toBe(false);
    });

    it("hands the phone-only person to the queue: found by phone, made due, claimed with email null", async () => {
      const phone = e164();
      const filed = await fileByPhone(campaignId, { phone, name: "Queue Phone", ...stated() });
      expect(filed.status).toBe(201);
      createdLeadIds.push(filed.body.leadId);

      const lookup = await lookupFollowupRowByPhone({ orgId, campaignId, phone });
      expect(lookup).toMatchObject({ ok: true, id: filed.body.leadCampaignId, leadId: filed.body.leadId, phone });
      expect(await lookupFollowupRowByPhone({ orgId, campaignId, phone: e164() })).toEqual({ ok: false, code: "lead_not_found" });

      const nowMs = Date.now();
      await writeFollowupStatement({
        orgId,
        id: filed.body.leadCampaignId,
        kind: "scheduled",
        dueAtIso: new Date(nowMs).toISOString(),
        reason: null,
        nowMs,
      });
      const claim = await pickFollowupCandidate({
        orgId,
        campaignId,
        runId: randomUUID(),
        actingCampaignId: campaignId,
        context: { orgId },
        nowMs: nowMs + 1_000,
      });
      expect(claim.claimed).toMatchObject({ id: filed.body.leadCampaignId, email: null, phone });
    });
  });
});
