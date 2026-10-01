/**
 * "Already a customer", read off the prospect's reply, against a REAL database: the upsert's
 * conflict path, the person-grain dedupe and the supersede are raw SQL a mocked `sql` never runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, conversionEvents } = await import(
  "../../src/db/schema.js"
);
const existingCustomersRoutes = (await import("../../src/routes/existing-customers.js")).default;
const conversionsRoutes = (await import("../../src/routes/conversions.js")).default;
const wonLeadsRoutes = (await import("../../src/routes/won-leads.js")).default;
const stepStatementsRoutes = (await import("../../src/routes/step-statements.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("existing customer from a reply, against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `camp-${randomUUID().slice(0, 8)}`;
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(express.json());
  app.use(existingCustomersRoutes);
  app.use(conversionsRoutes);
  app.use(wonLeadsRoutes);
  app.use(stepStatementsRoutes);

  const addr = (name: string) => `${name}-${tag}@example.com`;

  async function seed(name: string): Promise<{ leadId: string; rowId: string }> {
    const [lead] = await db.insert(leads).values({ firstName: name }).returning({ id: leads.id });
    await db
      .insert(leadContactMethods)
      .values({ leadId: lead.id, channel: "email", value: addr(name), source: "itest" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId, orgId, brandIds: [brandId], status: "served", servedAt: new Date() })
      .returning({ id: leadsCampaigns.id });
    return { leadId: lead.id, rowId: row.id };
  }

  const state = (email: string, body: Record<string, unknown> = {}) =>
    request(app)
      .post(`/orgs/campaigns/${campaignId}/existing-customers/by-email`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .send({ email, ...body });

  const liveReplyRows = (leadId: string) =>
    db
      .select()
      .from(conversionEvents)
      .where(and(eq(conversionEvents.matchedLeadId, leadId), eq(conversionEvents.source, "reply")));

  let customer: { leadId: string; rowId: string };
  let stated: { leadId: string; rowId: string };

  beforeAll(async () => {
    customer = await seed("customer");
    stated = await seed("stated");
  });

  afterAll(async () => {
    await db.delete(conversionEvents).where(eq(conversionEvents.brandId, brandId));
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
  });

  it("records once: a second statement writes nothing (and the address is case-folded)", async () => {
    const first = await state(addr("customer").toUpperCase(), { replyRef: "ie:abc" });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe("recorded");
    expect(first.body.outcome).toMatchObject({
      leadId: customer.leadId,
      leadCampaignId: customer.rowId,
      step: "sale",
      source: "reply",
      valueCents: null,
      costCents: null,
      causedByOutreach: false,
      occurredAt: null,
      replyRef: "ie:abc",
    });

    const second = await state(addr("customer"));
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("already_recorded");

    const rows = await liveReplyRows(customer.leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: "sale",
      valueCents: null,
      costCents: null,
      causedByOutreach: false,
      statedCausedByOutreach: false,
      receivedAt: null,
      attributionStatus: "attributed",
    });
  });

  it("refuses an address that is not on the campaign, naming why, and writes nothing", async () => {
    const res = await state(addr("stranger"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("lead_not_found");
  });

  it("counts as a sale that is NOT ours: byCause.other, bySource.reply, never outreach", async () => {
    const res = await request(app)
      .get(`/internal/brands/${brandId}/conversion-counts`)
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts.sale).toBe(1);
    expect(res.body.bySource.reply.sale).toBe(1);
    expect(res.body.bySource.manual.sale).toBe(0);
    expect(res.body.byCause.other.sale).toBe(1);
    expect(res.body.byCause.outreach.sale).toBe(0);
    expect(res.body.byCause.unstated.sale).toBe(0);

    const converted = await request(app)
      .get(`/internal/brands/${brandId}/converted-leads?event=sale`)
      .set("x-api-key", "test-api-key");
    expect(converted.status).toBe(200);
    expect(converted.body.outcomes).toHaveLength(1);
    expect(converted.body.outcomes[0]).toMatchObject({
      leadId: customer.leadId,
      causedByOutreach: false,
      valueCents: null,
      costCents: null,
      occurredAt: null,
      source: "reply",
      causeBasis: "reply",
      causeReason: "already_a_customer",
    });

    const won = await request(app)
      .get(`/orgs/brands/${brandId}/won-leads?email=${encodeURIComponent(addr("customer"))}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId);
    expect(won.status).toBe(200);
    expect(won.body.emails).toEqual([addr("customer")]);
  });

  it("withdraws and revives the same row", async () => {
    const withdraw = () =>
      request(app)
        .post(`/orgs/campaigns/${campaignId}/existing-customers/by-email/withdraw`)
        .set("x-api-key", "test-api-key")
        .set("x-org-id", orgId)
        .send({ email: addr("customer") });
    expect((await withdraw()).body).toMatchObject({ withdrawn: true, alreadyWithdrawn: false });
    expect((await withdraw()).body).toMatchObject({ withdrawn: false, alreadyWithdrawn: true });

    const revived = await state(addr("customer"));
    expect(revived.status).toBe(201);
    expect(revived.body.status).toBe("recorded");
    const rows = await liveReplyRows(customer.leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].withdrawnAt).toBeNull();
  });

  it("never stacks on a stronger sale: a person's sale wins either way round", async () => {
    // Reply first, then a person states the sale: the reply-read row is set aside.
    expect((await state(addr("stated"))).status).toBe(201);
    const manual = await request(app)
      .post(`/orgs/leads/${stated.rowId}/step-statements?brandId=${brandId}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .send({ kind: "outcome", step: "sale", valueCents: 50_000, costCents: 0, causedByOutreach: false });
    expect(manual.status).toBe(201);
    const rows = await liveReplyRows(stated.leadId);
    expect(rows[0].withdrawnAt).not.toBeNull();

    // Then the classifier states it again: the person's sale stands, nothing is written.
    const again = await state(addr("stated"));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "already_won", wonBy: "manual", outcome: null });
    expect((await liveReplyRows(stated.leadId))[0].withdrawnAt).not.toBeNull();

    const res = await request(app)
      .get(`/internal/brands/${brandId}/conversion-counts`)
      .set("x-api-key", "test-api-key");
    // One sale per person: the customer's (reply) and the stated one (manual). Never three.
    expect(res.body.counts.sale).toBe(2);
    expect(res.body.bySource.reply.sale).toBe(1);
    expect(res.body.bySource.manual.sale).toBe(1);
  });
});
