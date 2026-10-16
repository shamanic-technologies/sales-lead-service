/**
 * JOURNALISTS-NOT-LEADS-1016 against a REAL database: who a brand only ever pitched to the press is a journalist of
 * the brand, never a lead. Three people of one brand:
 *   - Ty: pitched by a PR campaign only, then re-served by a sourcing + follow-up pipe (the 2026-10-14 incident rows)
 *     -> journalist (evidence press_pitch_only), refused by every pool, the claim, the relationship policies;
 *   - Mia: pitched by PR AND cold-sold by a sales channel -> still a lead (owner's reading), until a person says
 *     journalist;
 *   - Pat: a pure prospect (sales only) -> untouched.
 * Plus a person's "no" overriding the press-only evidence, Jev's judgment naming a journalist, and the claim predicate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async () =>
    new Response(
      JSON.stringify({
        channels: [
          { slug: "pr-cold-email-outreach", channelType: "pr" },
          { slug: "sales-cold-email-outreach", channelType: "outbound" },
          { slug: "lead-sourcing", channelType: "sourcing" },
          { slug: "ai-follow-up-email", channelType: "conversion" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
}));

import { db } from "../../src/db/index.js";
import { journalistClause, journalistScopeOf, leadIsJournalist, refreshBrandJournalists, resetChannelKinds } from "../../src/lib/brand-journalists.js";
import { loadRelationships, readReview, stateTag, withdrawTag } from "../../src/lib/relationship-read.js";
import { notJournalistSql } from "../../src/lib/followup-queue.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("brand journalists", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrand = randomUUID();
  const createdLeads: string[] = [];
  const people: Record<string, { leadId: string; human: string }> = {};

  async function person(name: string, rows: Array<{ slug: string; brand?: string }>): Promise<{ leadId: string; human: string }> {
    const human = randomUUID();
    const [lead] = (await db.execute(sql`INSERT INTO leads (name, first_name, human_id) VALUES (${name}, ${name}, ${human}::uuid) RETURNING id::text`)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'email', ${`${name.toLowerCase()}-${lead.id}@itest.dev`}, 'itest')`);
    for (const r of rows) {
      await db.execute(sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, feature_slug, followup_due_at, followup_count)
        VALUES (${lead.id}::uuid, ${randomUUID()}, ${orgId}, ${sql.param([r.brand ?? brandId])}::text[], 'served', now() - interval '6 months',
          ${r.slug}, now() - interval '1 minute', 0)
      `);
    }
    return { leadId: lead.id, human };
  }

  const handedOut = async (leadId: string, brands = [brandId]) =>
    ((await db.execute(sql`SELECT 1 AS ok WHERE TRUE ${journalistClause(sql`${leadId}::uuid`, journalistScopeOf(orgId, brands))}`)) as unknown as unknown[]).length === 1;

  beforeAll(async () => {
    resetChannelKinds();
    people.ty = await person("Ty", [{ slug: "pr-cold-email-outreach" }, { slug: "lead-sourcing" }, { slug: "ai-follow-up-email" }]);
    people.mia = await person("Mia", [{ slug: "pr-cold-email-outreach" }, { slug: "sales-cold-email-outreach" }]);
    people.pat = await person("Pat", [{ slug: "sales-cold-email-outreach" }, { slug: "lead-sourcing" }]);
    // Pitched for ANOTHER brand only: a journalist there, a stranger here.
    people.zoe = await person("Zoe", [{ slug: "pr-cold-email-outreach", brand: otherBrand }, { slug: "sales-cold-email-outreach" }]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    for (const t of ["brand_journalists", "relationship_statements", "relationship_judgments", "relationship_subjects"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  it("classifies press-only people as journalists, keeps sales history and pure prospects as leads", async () => {
    const r = await refreshBrandJournalists({ orgId, brandId });
    expect(r).toMatchObject({ journalists: 1, pressOnly: 1 });
    expect(await leadIsJournalist(people.ty.leadId, orgId, [brandId])).toBe(true);
    expect(await leadIsJournalist(people.mia.leadId, orgId, [brandId])).toBe(false);
    expect(await leadIsJournalist(people.pat.leadId, orgId, [brandId])).toBe(false);
    expect(await leadIsJournalist(people.zoe.leadId, orgId, [brandId])).toBe(false);

    // Every sales pool refuses Ty, hands the others out.
    expect(await handedOut(people.ty.leadId)).toBe(false);
    expect(await handedOut(people.mia.leadId)).toBe(true);
    expect(await handedOut(people.pat.leadId)).toBe(true);

    // The follow-up claim predicate: Ty's due rows are never claimed.
    const claimable = (await db.execute(sql`
      SELECT DISTINCT lc.lead_id::text AS lead_id FROM leads_campaigns lc
      WHERE lc.org_id = ${orgId} AND lc.followup_due_at IS NOT NULL AND ${notJournalistSql()}
    `)) as unknown as Array<{ lead_id: string }>;
    expect(claimable.map((c) => c.lead_id).sort()).toEqual([people.mia.leadId, people.pat.leadId, people.zoe.leadId].sort());

    // Idempotent: a second pass writes nothing.
    expect(await refreshBrandJournalists({ orgId, brandId })).toMatchObject({ written: 0, deleted: 0 });
  });

  it("serves the journalist tag on the relationship block, so no pure-prospect or business-only pipe takes them", async () => {
    const blocks = await loadRelationships(orgId, brandId, [people.ty.human, people.mia.human, people.pat.human]);
    const ty = blocks.get(people.ty.human)!;
    expect(ty.tags).toContain("journalist");
    expect(ty.details.find((d) => d.tag === "journalist")).toMatchObject({ basis: "evidence", evidence: "press_pitch_only", state: "yes" });
    expect(ty.policies).toEqual({ business_only: false, pure_prospect: false });
    expect(blocks.get(people.mia.human)!.tags).not.toContain("journalist");
    expect(blocks.get(people.pat.human)!.policies.pure_prospect).toBe(true);

    const review = await readReview(orgId, brandId);
    expect(review.counts.byTag.journalist).toBe(1);
    expect(review.settled.people.map((p) => p.humanId)).toContain(people.ty.human);
  });

  it("a person's word wins both ways, and withdrawing it returns to the evidence", async () => {
    const userId = randomUUID();
    await stateTag({ orgId, brandId, humanId: people.ty.human, tag: "journalist", state: "no", userId });
    expect(await leadIsJournalist(people.ty.leadId, orgId, [brandId])).toBe(false);
    expect(await handedOut(people.ty.leadId)).toBe(true);

    await stateTag({ orgId, brandId, humanId: people.mia.human, tag: "journalist", state: "yes", userId });
    expect(await leadIsJournalist(people.mia.leadId, orgId, [brandId])).toBe(true);

    await withdrawTag({ orgId, brandId, humanId: people.ty.human, tag: "journalist", userId });
    await withdrawTag({ orgId, brandId, humanId: people.mia.human, tag: "journalist", userId });
    expect(await leadIsJournalist(people.ty.leadId, orgId, [brandId])).toBe(true);
    expect(await leadIsJournalist(people.mia.leadId, orgId, [brandId])).toBe(false);
  });

  it("Jev judging a lead a journalist makes them one; below 50% leaves them a lead", async () => {
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id, judged_at)
      VALUES (${orgId}, ${brandId}, ${people.pat.human}::uuid, '', ${JSON.stringify({ journalist: 0.45, prospect: 0.6 })}::jsonb, 0, 'itest', 'itest-run', now())
    `);
    await refreshBrandJournalists({ orgId, brandId });
    expect(await leadIsJournalist(people.pat.leadId, orgId, [brandId])).toBe(false);

    await db.execute(sql`
      UPDATE relationship_judgments SET probabilities = ${JSON.stringify({ journalist: 0.8, prospect: 0.2 })}::jsonb
      WHERE org_id = ${orgId} AND human_id = ${people.pat.human}::uuid
    `);
    await refreshBrandJournalists({ orgId, brandId });
    expect(await leadIsJournalist(people.pat.leadId, orgId, [brandId])).toBe(true);
    const row = (await db.execute(sql`SELECT basis, press_only FROM brand_journalists WHERE lead_id = ${people.pat.leadId}::uuid`)) as unknown as Array<{ basis: string; press_only: boolean }>;
    expect(row[0]).toEqual({ basis: "judgment", press_only: false });
  });
});
