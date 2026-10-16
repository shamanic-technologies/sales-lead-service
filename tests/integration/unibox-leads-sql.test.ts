/**
 * LEAD-FOLLOWUP-DATE-1016: a brand's Unibox PROSPECT (direct conversation, judged a pure prospect) becomes a lead of the
 * brand; a personal conversation never does, and a person already a lead of the brand is not filed twice.
 * Staff test addresses only.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { fileUniboxLeads, uniboxIntakeCampaignId } = await import("../../src/lib/unibox-leads.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("unibox intake (LEAD-FOLLOWUP-DATE-1016)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();

  async function subject(name: string, probabilities: Record<string, number>, email: string) {
    const humanId = randomUUID();
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, name, emails, has_messages, has_direct)
      VALUES (${orgId}, ${brandId}, ${humanId}::uuid, ${name}, ARRAY[${email}]::text[], true, true)`);
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, probabilities, thread_seq, model, run_id)
      VALUES (${orgId}, ${brandId}, ${humanId}::uuid, ${JSON.stringify(probabilities)}::jsonb, 0, 'jev', 'run')`);
    return humanId;
  }

  afterAll(async () => {
    const rows = (await db.execute(sql`SELECT lead_id::text AS id FROM leads_campaigns WHERE org_id = ${orgId}`)) as unknown as Array<{ id: string }>;
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM relationship_subjects WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM relationship_judgments WHERE org_id = ${orgId}`);
    if (rows.length > 0) await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(rows.map((r) => r.id))}::uuid[])`);
  });

  it("files the prospect, never the friend, and only once", async () => {
    const tag = randomUUID().slice(0, 6);
    const prospect = `kevin+ubx-prospect-${tag}@distribute.you`;
    const friend = `kevin+ubx-friend-${tag}@distribute.you`;
    await subject("Prospect Person", { prospect: 0.9 }, prospect);
    await subject("Friend Person", { personal: 0.95 }, friend);

    const first = await fileUniboxLeads({ orgId, brandId });
    expect(first).toMatchObject({ filed: 1, notProspect: 1 });
    const rows = (await db.execute(sql`
      SELECT lc.campaign_id, lc.status, lc.status_reason, cm.value AS email FROM leads_campaigns lc
      JOIN lead_contact_methods cm ON cm.lead_id = lc.lead_id AND cm.channel = 'email'
      WHERE lc.org_id = ${orgId}`)) as unknown as Array<Record<string, string>>;
    expect(rows).toEqual([{ campaign_id: uniboxIntakeCampaignId(brandId), status: "served", status_reason: "unibox_conversation", email: prospect }]);

    // Already a lead of the brand (by address: the lead has no human yet): not a candidate again.
    const again = await fileUniboxLeads({ orgId, brandId });
    expect(again.filed).toBe(0);
    expect(again.candidates).toBe(1); // the friend only
  });
});
