/**
 * COMPANY-MARK-SERVE-1101 against a REAL database: a company the client marked "not our target" for a brand is never
 * served again for that brand (and offer when the mark names one), on every pool, through the one shared clause.
 *
 * Acme has two people. Ann's list row is where the client marks Acme. Bob (Ann's colleague) sits in the campaign's
 * paid pool. Bob must leave the pool for that brand, stay servable for another brand of the org, and come back once
 * the mark is withdrawn. A fresh lead whose own company id the identity sweep has not filled yet is caught through
 * its employer row; a lead-level mark refuses that person only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../../src/db/index.js";
import { setCompanyDisqualification, setDisqualification, withdrawCompanyDisqualification } from "../../src/lib/lead-disqualification.js";
import { disqualifiedClause, leadServeDisqualification, serveExclusionScopeOf } from "../../src/lib/disqualified-sql.js";
import { loadRetryCandidates } from "../../src/lib/retry-pool.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("disqualified marks refuse the serve", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrand = randomUUID();
  const offerA = randomUUID();
  const offerB = randomUUID();
  const campaignId = randomUUID();
  const otherCampaignId = randomUUID();
  const acmeCompany = randomUUID();
  const userId = randomUUID();
  const createdLeads: string[] = [];
  const createdOrgs: string[] = [];
  const leads: Record<string, string> = {};
  let acmeOrg = "";

  async function lead(name: string, organizationId: string | null, companyId: string | null): Promise<string> {
    const [row] = (await db.execute(sql`
      INSERT INTO leads (name, first_name, organization_id, company_id)
      VALUES (${name}, ${name}, ${organizationId}::uuid, ${companyId}::uuid) RETURNING id::text
    `)) as unknown as Array<{ id: string }>;
    createdLeads.push(row.id);
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'email', ${`${name.toLowerCase()}-${row.id}@itest.dev`}, 'itest')`);
    return row.id;
  }

  async function served(leadId: string, campaign: string, brand: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, status_reason, served_at)
      VALUES (${leadId}::uuid, ${campaign}, ${orgId}, ${sql.param([brand])}::text[], 'served', 'served', now() - interval '1 day')
    `);
  }

  const servable = async (leadId: string, brand: string, offer: string | null) =>
    ((await db.execute(sql`SELECT 1 AS ok WHERE TRUE ${disqualifiedClause(sql`${leadId}::uuid`, serveExclusionScopeOf(orgId, [brand], offer))}`)) as unknown as unknown[])
      .length === 1;

  const poolLeads = async (campaign: string, offer: string | null) =>
    (await loadRetryCandidates({ orgId, campaignId: campaign, nowMs: Date.now(), offerId: offer })).map((c) => c.leadId).sort();

  beforeAll(async () => {
    const [org] = (await db.execute(sql`
      INSERT INTO organizations (name, primary_domain, company_id) VALUES ('Acme', ${`acme-${orgId}.itest.dev`}, ${acmeCompany}::uuid) RETURNING id::text
    `)) as unknown as Array<{ id: string }>;
    acmeOrg = org.id;
    createdOrgs.push(acmeOrg);
    leads.ann = await lead("Ann", acmeOrg, acmeCompany);
    leads.bob = await lead("Bob", acmeOrg, acmeCompany);
    // Served before the identity sweep filled her own company id: Acme is read off her employer row.
    leads.cid = await lead("Cid", acmeOrg, null);
    leads.dee = await lead("Dee", null, null);
    for (const id of [leads.ann, leads.bob, leads.cid, leads.dee]) await served(id, campaignId, brandId);
    await served(leads.bob, otherCampaignId, otherBrand);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM company_disqualification_marks WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_disqualification_marks WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_contact_methods WHERE lead_id = ANY(${sql.param(createdLeads)}::uuid[])`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ANY(${sql.param(createdOrgs)}::uuid[])`);
  });

  it("serves everyone while nothing is marked", async () => {
    expect(await poolLeads(campaignId, offerA)).toEqual([leads.ann, leads.bob, leads.cid, leads.dee].sort());
  });

  it("a company marked from one lead refuses every colleague for that brand, never for another brand", async () => {
    await setCompanyDisqualification({
      orgId, brandId, companyKey: acmeCompany, offerId: null, note: "never pursue Acme", statedByUserId: userId,
      statedFromLeadId: leads.ann, leadCampaignId: null,
    });
    // Bob (colleague) and Cid (employer row only) leave the brand's pool; Dee (no company) stays.
    expect(await poolLeads(campaignId, offerA)).toEqual([leads.dee]);
    expect(await leadServeDisqualification(leads.bob, orgId, [brandId], offerA)).toEqual({ lead: false, company: true });
    expect(await leadServeDisqualification(leads.cid, orgId, [brandId], null)).toEqual({ lead: false, company: true });
    // Another brand of the org: Bob is still served there.
    expect(await poolLeads(otherCampaignId, null)).toEqual([leads.bob]);
    expect(await servable(leads.bob, otherBrand, null)).toBe(true);
  });

  it("withdrawing the mark serves the company again", async () => {
    expect(await withdrawCompanyDisqualification({ orgId, brandId, companyKey: acmeCompany, offerId: null, withdrawnByUserId: userId })).toBe(1);
    expect(await poolLeads(campaignId, offerA)).toEqual([leads.ann, leads.bob, leads.cid, leads.dee].sort());
  });

  it("a mark naming an offer refuses that offer only; a name-only employer key matches too", async () => {
    await setCompanyDisqualification({
      orgId, brandId, companyKey: `org:${acmeOrg}`, offerId: offerA, note: null, statedByUserId: userId,
      statedFromLeadId: leads.cid, leadCampaignId: null,
    });
    expect(await servable(leads.bob, brandId, offerA)).toBe(false);
    expect(await servable(leads.bob, brandId, offerB)).toBe(true);
    // Offer unknown: only brand-wide marks answer.
    expect(await servable(leads.bob, brandId, null)).toBe(true);
    await withdrawCompanyDisqualification({ orgId, brandId, companyKey: `org:${acmeOrg}`, offerId: null, withdrawnByUserId: userId });
    expect(await servable(leads.bob, brandId, offerA)).toBe(true);
  });

  it("a lead-level mark refuses that person only", async () => {
    await setDisqualification({ orgId, brandId, leadId: leads.dee, offerId: null, note: "not the right contact", statedByUserId: userId, leadCampaignId: null });
    expect(await leadServeDisqualification(leads.dee, orgId, [brandId], offerA)).toEqual({ lead: true, company: false });
    expect(await poolLeads(campaignId, offerA)).toEqual([leads.ann, leads.bob, leads.cid].sort());
  });
});
