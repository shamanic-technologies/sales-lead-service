/**
 * The brand transfer, executed against a REAL database. Every table that ties a brand to an org
 * is seeded for the brand being moved AND for a sibling brand of the same org that must stay put;
 * after the transfer the source org holds nothing of the moved brand in ANY table, the sibling is
 * untouched, and a second call moves nothing. A mocked `sql` compiles none of these statements
 * (array equality, jsonb merge, the campaign UNION, the transaction), so this is where they run.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const schema = await import("../../src/db/schema.js");
const { transferBrand, SharedBrandRowsError } = await import("../../src/lib/brand-transfer.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

/** Every org-keyed table the transfer is responsible for, and how it names its brand. */
const BRAND_SCALAR_TABLES = [
  "brand_conversion_tokens",
  "conversion_events",
  "lead_step_disqualifications",
  "lead_step_cause_statements",
  "crm_pairing_matches",
  "crm_pairing_judgments",
  "crm_pairing_rulings",
  "lead_delivery_evidence",
] as const;
const BRAND_ARRAY_TABLES = ["leads_campaigns", "followup_actions", "requeued_serves"] as const;

async function n(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return Number(rows[0].n);
}

/** Rows of `brand` still held by `org`, per table (campaign-keyed + derived tables included). */
async function footprint(org: string, brand: string, campaignId: string) {
  const out: Record<string, number> = {};
  for (const t of BRAND_SCALAR_TABLES) {
    out[t] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND brand_id = ${brand}`,
    );
  }
  for (const t of BRAND_ARRAY_TABLES) {
    out[t] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND ${brand} = ANY(brand_ids)`,
    );
  }
  out.campaigns_apollo_strategies = await n(
    sql`SELECT count(*)::int AS n FROM campaigns_apollo_strategies WHERE org_id = ${org} AND campaign_id = ${campaignId}`,
  );
  for (const t of ["lead_read_models", "lead_change_feeds"]) {
    out[t] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND scope->>'brandId' = ${brand}`,
    );
  }
  return out;
}

describe.skipIf(!hasRealDatabase)("brand transfer against a real database", () => {
  const tag = randomUUID().slice(0, 8);
  const created: { orgs: string[]; leads: string[] } = { orgs: [], leads: [] };

  async function newLead(): Promise<string> {
    const [lead] = await db
      .insert(schema.leads)
      .values({ name: `itest transfer ${tag}` })
      .returning({ id: schema.leads.id });
    created.leads.push(lead.id);
    return lead.id;
  }

  /** Seeds one row in EVERY table for (org, brand) on `campaignId`. */
  async function seedBrand(org: string, brand: string, campaignId: string) {
    const leadId = await newLead();
    const [lc] = await db
      .insert(schema.leadsCampaigns)
      .values({ leadId, campaignId, orgId: org, brandIds: [brand], status: "served", servedAt: new Date() })
      .returning({ id: schema.leadsCampaigns.id });
    await db.insert(schema.followupActions).values({
      orgId: org, brandIds: [brand], leadCampaignId: lc.id, leadId,
      heldByCampaignId: campaignId, action: "claimed", occurredAt: new Date(),
    });
    await db.insert(schema.requeuedServes).values({
      leadCampaignId: randomUUID(), leadId, campaignId, orgId: org, brandIds: [brand],
      email: `${randomUUID()}@example.test`, reason: `itest-${tag}`,
      rowSnapshot: { org_id: org, brand_ids: [brand], campaign_id: campaignId },
    });
    await db.insert(schema.campaignsApolloStrategies).values({ orgId: org, campaignId });
    await db.insert(schema.brandConversionTokens).values({ brandId: brand, orgId: org, token: `tok-${randomUUID()}` });
    await db.insert(schema.conversionEvents).values({
      brandId: brand, orgId: org, event: "sale", matchedLeadId: leadId,
      matchConfidence: "deterministic", attributionStatus: "attributed", source: "manual",
      leadCampaignId: lc.id, campaignId, dedupeSignature: `m:${lc.id}:sale`,
    });
    await db.insert(schema.leadStepDisqualifications).values({
      leadId, leadCampaignId: lc.id, campaignId, brandId: brand, orgId: org, step: "meeting_booked",
    });
    await db.insert(schema.leadStepCauseStatements).values({
      orgId: org, brandId: brand, leadId, step: "sale", causedByOutreach: true,
    });
    const contact = `crm-${randomUUID()}`;
    await db.insert(schema.crmPairingMatches).values({
      orgId: org, brandId: brand, crmContactId: contact, matchedLeadId: leadId, matchConfidence: "deterministic",
    });
    await db.insert(schema.crmPairingJudgments).values({
      orgId: org, brandId: brand, crmContactId: contact, leadId, samePersonProbability: 0.9, judgmentModel: "itest",
    });
    await db.insert(schema.crmPairingRulings).values({
      orgId: org, brandId: brand, crmContactId: contact, leadId, ruling: "paired",
    });
    await db.execute(sql`
      INSERT INTO lead_delivery_evidence (org_id, brand_id, campaign_id, email, result, fetched_at)
      VALUES (${org}, ${brand}, '', ${`${randomUUID()}@example.test`}, NULL, now())`);
    await db.execute(sql`
      INSERT INTO lead_read_models (scope_key, org_id, scope, applied_xmin)
      VALUES (${`itest-${randomUUID()}`}, ${org}, ${JSON.stringify({ orgId: org, brandId: brand })}::jsonb, pg_current_xact_id())`);
    await db.execute(sql`
      INSERT INTO lead_change_feeds (scope_key, org_id, scope, applied_xmin)
      VALUES (${`itest-${randomUUID()}`}, ${org}, ${JSON.stringify({ orgId: org, brandId: brand })}::jsonb, pg_current_xact_id())`);
  }

  function org(): string {
    const id = randomUUID();
    created.orgs.push(id);
    return id;
  }

  afterAll(async () => {
    for (const o of created.orgs) {
      for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies",
        "lead_read_models", "lead_change_feeds"]) {
        await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${o}`);
      }
    }
    if (created.leads.length > 0) {
      await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(created.leads)}::uuid[])`);
    }
  });

  it("moves every table onto the target org and brand, leaves a sibling brand alone, and a re-run is a no-op", async () => {
    const source = org();
    const target = org();
    const brand = randomUUID();
    const targetBrand = randomUUID();
    const sibling = randomUUID();
    const campaign = `itest-camp-${randomUUID()}`;
    const siblingCampaign = `itest-camp-${randomUUID()}`;
    await seedBrand(source, brand, campaign);
    await seedBrand(source, sibling, siblingCampaign);

    const siblingBefore = await footprint(source, sibling, siblingCampaign);
    const sourceToken = (await db.execute(
      sql`SELECT token FROM brand_conversion_tokens WHERE brand_id = ${brand}`,
    )) as unknown as Array<{ token: string }>;
    // The target brand already carries a freshly minted token: the source one (on the client's
    // website) must win.
    await db.insert(schema.brandConversionTokens).values({ brandId: targetBrand, orgId: target, token: `fresh-${tag}` });

    const first = await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target, targetBrandId: targetBrand });
    const moved = Object.fromEntries(first.map((t) => [t.tableName, t.count]));
    for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies",
      "lead_read_models", "lead_change_feeds"]) {
      expect(moved[t], t).toBeGreaterThanOrEqual(1);
    }

    // Nothing of the brand remains under the source org — in any table.
    const left = await footprint(source, brand, campaign);
    expect(Object.values(left).every((v) => v === 0), JSON.stringify(left)).toBe(true);

    // Everything lives under the target org, on the target brand (derived tables are rebuilt on read).
    const arrived = await footprint(target, targetBrand, campaign);
    for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies"]) {
      expect(arrived[t], t).toBe(1);
    }
    const token = (await db.execute(
      sql`SELECT token, org_id FROM brand_conversion_tokens WHERE brand_id = ${targetBrand}`,
    )) as unknown as Array<{ token: string; org_id: string }>;
    expect(token).toEqual([{ token: sourceToken[0].token, org_id: target }]);
    const snapshot = (await db.execute(
      sql`SELECT row_snapshot FROM requeued_serves WHERE org_id = ${target}`,
    )) as unknown as Array<{ row_snapshot: Record<string, unknown> }>;
    expect(snapshot[0].row_snapshot).toMatchObject({ org_id: target, brand_ids: [targetBrand], campaign_id: campaign });

    // The sibling brand of the source org is untouched.
    expect(await footprint(source, sibling, siblingCampaign)).toEqual(siblingBefore);

    // Re-running moves nothing.
    const second = await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target, targetBrandId: targetBrand });
    expect(second.every((t) => t.count === 0), JSON.stringify(second)).toBe(true);
    expect(await footprint(target, targetBrand, campaign)).toEqual(arrived);
  });

  it("without targetBrandId keeps the brand id and only moves the org", async () => {
    const source = org();
    const target = org();
    const brand = randomUUID();
    const campaign = `itest-camp-${randomUUID()}`;
    await seedBrand(source, brand, campaign);

    await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target });
    const left = await footprint(source, brand, campaign);
    expect(Object.values(left).every((v) => v === 0), JSON.stringify(left)).toBe(true);
    const arrived = await footprint(target, brand, campaign);
    for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies"]) {
      expect(arrived[t], t).toBe(1);
    }
    const again = await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target });
    expect(again.every((t) => t.count === 0)).toBe(true);
  });

  it("refuses — and writes nothing — when a row is shared with another brand", async () => {
    const source = org();
    const target = org();
    const brand = randomUUID();
    const campaign = `itest-camp-${randomUUID()}`;
    await seedBrand(source, brand, campaign);
    const leadId = await newLead();
    await db.insert(schema.leadsCampaigns).values({
      leadId, campaignId: campaign, orgId: source, brandIds: [brand, randomUUID()], status: "served",
    });

    await expect(
      transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target }),
    ).rejects.toBeInstanceOf(SharedBrandRowsError);
    const stayed = await footprint(source, brand, campaign);
    expect(stayed.leads_campaigns).toBe(2);
    expect(stayed.conversion_events).toBe(1);
  });
});
