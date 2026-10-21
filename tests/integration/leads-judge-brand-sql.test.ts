/**
 * LEADS-JUDGE-BRAND-1021 against a REAL database: a person filed from the Unibox stops being a lead of the brand once a
 * verdict says they are not the brand's (the judge reading the brand's offers says no prospect and no customer, or
 * crm-service tags their conversations professional NOT to the brand), and is filed back the day the verdict turns.
 * Staff test addresses only.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

vi.mock("../../src/lib/company-client.js", () => ({ getCompanies: async () => [] }));

const { db } = await import("../../src/db/index.js");
const { connectionTag } = await import("../helpers/crm-registry.js");
const { reconcileUniboxLeads, uniboxIntakeCampaignId } = await import("../../src/lib/unibox-leads.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("a Unibox lead whose verdict flips (LEADS-JUDGE-BRAND-1021)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const leads: string[] = [];

  async function uniboxLead(name: string): Promise<{ leadId: string; humanId: string; rowId: string }> {
    const humanId = randomUUID();
    const [l] = (await db.execute(sql`INSERT INTO leads (first_name, human_id) VALUES (${name}, ${humanId}::uuid) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leads.push(l.id);
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${l.id}::uuid, 'email', ${`kevin+ljb-${name}-${randomUUID().slice(0, 6)}@distribute.you`}, 'itest')`);
    const [row] = (await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, status_reason, served_at)
      VALUES (${l.id}::uuid, ${uniboxIntakeCampaignId(brandId)}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'unibox_conversation', now())
      RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    return { leadId: l.id, humanId, rowId: row.id };
  }

  const statusOf = async (rowId: string) =>
    ((await db.execute(sql`SELECT status, status_reason FROM leads_campaigns WHERE id = ${rowId}::uuid`)) as unknown as Array<{ status: string; status_reason: string }>)[0];

  afterAll(async () => {
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM relationship_judgments WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM relationship_subjects WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM crm_registry_facts WHERE org_id = ${orgId}`);
    if (leads.length > 0) {
      await db.execute(sql`DELETE FROM lead_contact_methods WHERE lead_id = ANY(${sql.param(leads)}::uuid[])`);
      await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leads)}::uuid[])`);
    }
  });

  it("crm-service tags them professional NOT to the brand: filed out, then back once a source says TO the brand", async () => {
    const p = await uniboxLead("otherbiz");
    const notTo = await connectionTag({ orgId, brandId, human: p.humanId, personKey: `itest:${p.humanId}`, tag: "professional_not_to_brand" });
    expect(await reconcileUniboxLeads({ orgId, brandId })).toEqual({ filedOut: 1, filedBack: 0 });
    expect(await statusOf(p.rowId)).toEqual({ status: "skipped", status_reason: "not_brand_lead" });
    // Idempotent: nothing moves on the next pass.
    expect(await reconcileUniboxLeads({ orgId, brandId })).toEqual({ filedOut: 0, filedBack: 0 });

    // crm-service re-judges: the old tag withdrawn, the person is professional TO the brand (a subject).
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, withdrawn_of, raw)
      VALUES (${randomUUID()}, ${(BigInt(Date.now()) * 1000n + 999_000_000n).toString()}::bigint, ${orgId}, ${brandId}, ${`itest:${p.humanId}`}, '{}', '{}', 'withdrawn', 'none', 'crm',
        ${randomUUID()}, '{"withdrawnType":"connection_tag"}'::jsonb, ${notTo}, '{}'::jsonb)`);
    await connectionTag({ orgId, brandId, human: p.humanId, personKey: `itest:${p.humanId}`, tag: "professional_to_brand" });
    await db.execute(sql`INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, has_direct) VALUES (${orgId}, ${brandId}, ${p.humanId}::uuid, '', false)`);
    expect(await reconcileUniboxLeads({ orgId, brandId })).toEqual({ filedOut: 0, filedBack: 1 });
    expect(await statusOf(p.rowId)).toEqual({ status: "served", status_reason: "unibox_conversation" });
  });

  it("the judge, reading the brand's offers, says no prospect and no customer: filed out", async () => {
    const p = await uniboxLead("judgedout");
    await connectionTag({ orgId, brandId, human: p.humanId, personKey: `itest:${p.humanId}`, tag: "professional_to_brand" });
    await db.execute(sql`INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, has_direct) VALUES (${orgId}, ${brandId}, ${p.humanId}::uuid, '', true)`);
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id, context_hash)
      VALUES (${orgId}, ${brandId}, ${p.humanId}::uuid, '', ${JSON.stringify({ prospect: 0.96, customer: 0.02 })}::jsonb, 1, 'jev', 'run', 'name-only')`);
    expect((await reconcileUniboxLeads({ orgId, brandId })).filedOut).toBe(0);
    await db.execute(sql`
      UPDATE relationship_judgments SET probabilities = ${JSON.stringify({ prospect: 0.08, customer: 0.02 })}::jsonb, context_hash = 'with-offers'
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ${p.humanId}::uuid`);
    expect((await reconcileUniboxLeads({ orgId, brandId })).filedOut).toBe(1);
    expect(await statusOf(p.rowId)).toEqual({ status: "skipped", status_reason: "not_brand_lead" });
  });
});
