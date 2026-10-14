/**
 * The lead row of ONE person on ONE campaign, against a REAL database (LEAD-BY-PERSON-CAMPAIGN-1014):
 * found by (person, campaign, org); the same person on another campaign, or the same row read by
 * another org, is null. The route tests (tests/unit/leads-by-person-route.test.ts) mock `sql`; this
 * file proves the predicate compiles and binds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns } = await import("../../src/db/schema.js");
const { fetchLeadCampaignRowByPerson } = await import("../../src/routes/leads.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead row by person + campaign against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `itest-by-person-${randomUUID()}`;
  const otherCampaignId = `itest-by-person-${randomUUID()}`;
  const leadIds: string[] = [];
  let personId = "";
  let otherPersonId = "";
  let rowId = "";

  beforeAll(async () => {
    const [person] = await db.insert(leads).values({ firstName: "Marie" }).returning({ id: leads.id });
    const [other] = await db.insert(leads).values({ firstName: "Paul" }).returning({ id: leads.id });
    personId = person.id;
    otherPersonId = other.id;
    leadIds.push(person.id, other.id);
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: personId, campaignId, orgId, brandIds: [brandId], status: "served" })
      .returning({ id: leadsCampaigns.id });
    rowId = row.id;
    await db
      .insert(leadsCampaigns)
      .values({ leadId: otherPersonId, campaignId: otherCampaignId, orgId, brandIds: [brandId], status: "served" });
  });

  afterAll(async () => {
    await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  });

  it("finds the one row the person holds on the campaign", async () => {
    const row = await fetchLeadCampaignRowByPerson(orgId, personId, campaignId);
    expect(row).toMatchObject({ id: rowId, leadId: personId, campaignId, orgId, status: "served" });
  });

  it("is null for a person who holds no row on that campaign", async () => {
    expect(await fetchLeadCampaignRowByPerson(orgId, otherPersonId, campaignId)).toBeNull();
    expect(await fetchLeadCampaignRowByPerson(orgId, personId, otherCampaignId)).toBeNull();
  });

  it("is null for another org, even naming the right person and campaign", async () => {
    expect(await fetchLeadCampaignRowByPerson(otherOrgId, personId, campaignId)).toBeNull();
  });
});
