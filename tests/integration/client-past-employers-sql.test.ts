/**
 * BRAND-PROOF-LOGOS-1121 against a REAL database: who a brand's paying clients are (ledger + CRM payments that stand),
 * the roles held on every lead of each client's human, and the read's empty answers.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, conversionEvents, crmFacts, leadsCampaigns, organizations, leadsOrganizations } = await import(
  "../../src/db/schema.js"
);
const { PEOPLE_FACTS_FEED } = await import("../../src/lib/crm-fact-feed.js");
const { loadPayingClients } = await import("../../src/lib/client-past-employers-read.js");
const routes = (await import("../../src/routes/client-past-employers.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("client past employers against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const emptyBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(routes);
  const addr = (name: string) => `${name}-${tag}@example.com`;
  const ids: Record<string, string> = {};

  async function lead(name: string, emails: string[], humanId: string | null = null, ofBrand = true): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name, humanId }).returning({ id: leads.id });
    for (const value of emails) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value, source: "itest" });
    if (ofBrand) await db.insert(leadsCampaigns).values({ leadId: row.id, campaignId: randomUUID(), orgId, brandIds: [brandId], status: "served" });
    ids[name] = row.id;
    return row.id;
  }

  async function role(leadId: string, orgName: string, current: boolean, startDate: string | null): Promise<void> {
    const [o] = await db.insert(organizations).values({ name: `${orgName}-${tag}` }).returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId, organizationId: o.id, title: "Head", current, startDate });
  }

  async function payment(email: string, payload: Record<string, unknown>, type = "payment"): Promise<string> {
    const factId = randomUUID();
    await db.insert(crmFacts).values({
      factId, seq: BigInt(Math.floor(Math.random() * 1e15)), orgId, brandId, personKey: `email:${email}`, fullName: null,
      emails: [email], phones: [], type, occurredAt: new Date("2026-10-14T10:00:00.000Z"), dateBasis: "created_at",
      source: "stripe", sourceRef: `ref-${randomUUID()}`, payload, raw: { itest: true },
    });
    return factId;
  }

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, '0', now())
      ON CONFLICT (feed) DO UPDATE SET caught_up_at = COALESCE(crm_feed_cursors.caught_up_at, now())`);
  });

  beforeAll(async () => {
    const human = randomUUID();
    // Ledger payer, whose PAST role sits on another lead of the same human (a job change).
    await lead("ledger", [addr("ledger")], human);
    await lead("ledger-old-job", [addr("ledger-old")], human, false);
    await role(ids["ledger-old-job"], "Acme", false, "2019-01-01");
    await role(ids.ledger, "Globex", true, "2022-03-01");
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", matchedLeadId: ids.ledger, matchConfidence: "deterministic", attributionStatus: "attributed",
      source: "manual", receivedAt: new Date("2026-05-12T16:03:36.845Z"),
    });
    // CRM payer (case differs), also worked at Acme.
    await lead("crm", [addr("crm")]);
    await role(ids.crm, "Acme", false, "2018-01-01");
    // Acme for both: the same organization row (name key).
    await db.execute(sql`UPDATE leads_organizations SET organization_id = (
      SELECT organization_id FROM leads_organizations WHERE lead_id = ${ids["ledger-old-job"]}::uuid LIMIT 1)
      WHERE lead_id = ${ids.crm}::uuid`);
    await payment(addr("crm").toUpperCase(), { status: "succeeded", amountMinor: 9900, amountRefunded: 0, currency: "usd" });
    // Payer with no history yet.
    await lead("nohistory", [addr("nohistory")]);
    await payment(addr("nohistory"), { status: "succeeded", amountMinor: 100 });
    // Not payers: refunded, failed, withdrawn sale, a staff address, not of the brand.
    await lead("refunded", [addr("refunded")]);
    await payment(addr("refunded"), { status: "succeeded", amountMinor: 100, amountRefunded: 100 });
    await lead("failed", [addr("failed")]);
    await payment(addr("failed"), { status: "failed", amountMinor: 100 });
    await lead("withdrawn", [addr("withdrawn")]);
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", matchedLeadId: ids.withdrawn, matchConfidence: "deterministic", attributionStatus: "attributed",
      source: "manual", receivedAt: new Date(), withdrawnAt: new Date(),
    });
    await lead("staff", [`kevin+${tag}@distribute.you`]);
    await payment(`kevin+${tag}@distribute.you`, { status: "succeeded", amountMinor: 100 });
    await lead("stranger", [addr("stranger")], null, false);
    await payment(addr("stranger"), { status: "succeeded", amountMinor: 100 });
  });

  it("names exactly the paying clients", async () => {
    const clients = await loadPayingClients(orgId, brandId);
    expect(clients.map((c) => c.leadId).sort()).toEqual([ids.ledger, ids.crm, ids.nohistory].sort());
  });

  it("answers the companies with their trace, every lead of the human counted", async () => {
    const res = await request(app).get(`/internal/brands/${brandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body.payingClients).toBe(3);
    expect(res.body.clientsWithHistory).toBe(2);
    expect(res.body.reason).toBeNull();
    const acme = res.body.companies.find((c: { name: string }) => c.name === `Acme-${tag}`);
    expect(acme.clientCount).toBe(2);
    expect(acme.clients.map((c: { leadId: string }) => c.leadId).sort()).toEqual([ids.ledger, ids.crm].sort());
    expect(res.body.companies[0].name).toBe(`Acme-${tag}`);
    const globex = res.body.companies.find((c: { name: string }) => c.name === `Globex-${tag}`);
    expect(globex.currentForSome).toBe(true);
    const nohistory = res.body.clients.find((c: { leadId: string }) => c.leadId === ids.nohistory);
    expect(nohistory.history).toBe("not_looked_up");
  });

  it("a brand with no paying client answers empty with a reason", async () => {
    const res = await request(app).get(`/internal/brands/${emptyBrandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payingClients: 0, companies: [], reason: "no_paying_clients" });
  });

  it("the fill door refuses without the caller's run", async () => {
    const res = await request(app).post(`/internal/brands/${brandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(400);
  });
});
