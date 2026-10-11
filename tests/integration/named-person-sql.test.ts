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

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: async () => ({ results: [] }),
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
const { leads, leadContactMethods, leadsCampaigns, crmFacts } = await import("../../src/db/schema.js");
const namedPeopleRoutes = (await import("../../src/routes/named-people.js")).default;
const { lookupFollowupRowByEmail, writeFollowupStatement, pickFollowupCandidate } = await import(
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

  const file = (campaign: string, email: string) =>
    request(app)
      .post(`/orgs/campaigns/${campaign}/leads/by-email`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .set("x-run-id", randomUUID())
      .send({ email });

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
});
