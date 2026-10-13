/**
 * Every person a brand's CRM says signed up is a lead of the brand, against a REAL database: a new
 * lead named off the fact, the brand's own intake row, an existing lead reused email-first, a person
 * already a lead of the brand left alone, a withdrawn signup skipped, and idempotency.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { crmFacts, leads, leadsCampaigns, leadContactMethods } from "../../src/db/schema.js";
import { brandSignupsCampaignId, fileBrandSignups } from "../../src/lib/brand-signups.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("brand signups become leads of the brand", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const addr = (name: string) => `${name}-${tag}@example.com`;
  const createdLeads: string[] = [];

  async function fact(email: string, over: Partial<typeof crmFacts.$inferInsert> = {}): Promise<string> {
    const factId = randomUUID();
    await db.insert(crmFacts).values({
      factId,
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:${email}`,
      fullName: "Lucas Martinez",
      emails: [email],
      phones: [],
      type: "signup",
      occurredAt: new Date("2026-09-29T03:43:04.258Z"),
      dateBasis: "user_created_at",
      source: "clerk",
      sourceRef: `user_${randomUUID()}`,
      payload: {},
      raw: { itest: true },
      ...over,
    });
    return factId;
  }

  async function rowsOf(email: string) {
    const owners = await db.select().from(leadContactMethods).where(eq(leadContactMethods.value, email));
    if (owners.length === 0) return [];
    owners.forEach((o) => createdLeads.push(o.leadId));
    return db.select().from(leadsCampaigns).where(and(eq(leadsCampaigns.leadId, owners[0].leadId), eq(leadsCampaigns.orgId, orgId)));
  }

  afterAll(async () => {
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    await db.delete(crmFacts).where(eq(crmFacts.orgId, orgId));
    if (createdLeads.length) {
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, createdLeads));
      await db.delete(leads).where(inArray(leads.id, createdLeads));
    }
  });

  it("files every live signup once, as a served lead of the brand's own intake", async () => {
    await fact(addr("lucas"));
    await fact(addr("lucas"), { source: "posthog", occurredAt: new Date("2026-09-29T03:43:06.000Z") });

    // A person who already had a lead elsewhere (another org's campaign) keeps that lead: email-first.
    const [elsewhere] = await db.insert(leads).values({ name: "Already Known" }).returning({ id: leads.id });
    createdLeads.push(elsewhere.id);
    await db.insert(leadContactMethods).values({ leadId: elsewhere.id, channel: "email", value: addr("known"), source: "itest" });
    await fact(addr("known"));

    // Already a lead of THIS brand: nothing filed.
    const [worked] = await db.insert(leads).values({ name: "Worked" }).returning({ id: leads.id });
    createdLeads.push(worked.id);
    await db.insert(leadContactMethods).values({ leadId: worked.id, channel: "email", value: addr("worked"), source: "itest" });
    await db.insert(leadsCampaigns).values({ leadId: worked.id, campaignId: randomUUID(), orgId, brandIds: [brandId], status: "served" });
    await fact(addr("worked"));

    // A signup the CRM took back.
    const withdrawn = await fact(addr("gone"));
    await fact(addr("gone"), { type: "withdrawn", withdrawnOf: withdrawn, fullName: null });

    const first = await fileBrandSignups({ orgId, brandId });
    expect(first.brands).toContainEqual({ orgId, brandId });

    const lucas = await rowsOf(addr("lucas"));
    expect(lucas).toHaveLength(1);
    expect(lucas[0]).toMatchObject({
      campaignId: brandSignupsCampaignId(brandId),
      brandIds: [brandId],
      status: "served",
      statusReason: "crm_signup",
    });
    expect(lucas[0].servedAt?.toISOString()).toBe("2026-09-29T03:43:04.258Z");
    const [lead] = await db.select().from(leads).where(eq(leads.id, lucas[0].leadId));
    expect(lead).toMatchObject({ name: "Lucas Martinez", firstName: "Lucas", lastName: "Martinez" });

    const known = await rowsOf(addr("known"));
    expect(known).toHaveLength(1);
    expect(known[0].leadId).toBe(elsewhere.id);

    const workedRows = await rowsOf(addr("worked"));
    expect(workedRows).toHaveLength(1);
    expect(workedRows[0].campaignId).not.toBe(brandSignupsCampaignId(brandId));

    expect(await rowsOf(addr("gone"))).toHaveLength(0);

    // Idempotent: nothing left to file for this brand.
    const second = await fileBrandSignups({ orgId, brandId });
    expect(second.brands).not.toContainEqual({ orgId, brandId });
    expect(await rowsOf(addr("lucas"))).toHaveLength(1);
  });
});
