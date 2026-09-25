/**
 * The follow-up actions ledger, executed against a REAL database.
 *
 * The ledger row is written by a data-modifying CTE in the same statement as the claim / the
 * 'acted' write, and read back through array binds — none of which a mocked `sql` compiles. So this
 * file RUNS the statements: a claim records who took it, a lost race records nothing, an 'acted'
 * statement records the acting campaign, and the read groups per (acting campaign, person).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: async () => ({ results: [] }),
}));

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, followupActions } = await import(
  "../../src/db/schema.js"
);
const { claimFollowup, pickFollowupCandidate, writeFollowupStatement } = await import(
  "../../src/lib/followup-queue.js"
);
const { readFollowupActions } = await import("../../src/lib/followup-actions.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("follow-up actions ledger against a real database", () => {
  const heldBy = `itest-held-${randomUUID()}`;
  const acting = `itest-acting-${randomUUID()}`;
  const otherActing = `itest-acting-${randomUUID()}`;
  const orgId = randomUUID();
  const brandId = randomUUID();

  async function seedDueRow(): Promise<{ id: string; leadId: string; email: string }> {
    const email = `${randomUUID()}@example.test`;
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "itest" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId: heldBy,
        orgId,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(),
        followupDueAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: leadsCampaigns.id });
    return { id: row.id, leadId: lead.id, email };
  }

  async function clean() {
    await db.delete(followupActions).where(eq(followupActions.heldByCampaignId, heldBy));
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, heldBy));
  }

  beforeEach(clean);
  afterAll(clean);

  it("a claim records who took it, in the same statement; a lost race records nothing", async () => {
    const row = await seedDueRow();
    const nowMs = Date.now();
    expect(await claimFollowup({ id: row.id, nowMs, runId: "run-1", actingCampaignId: acting })).toBe(true);
    expect(await claimFollowup({ id: row.id, nowMs, runId: "run-2", actingCampaignId: acting })).toBe(false);

    const ledger = await db.select().from(followupActions).where(eq(followupActions.leadCampaignId, row.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      action: "claimed",
      actingCampaignId: acting,
      heldByCampaignId: heldBy,
      leadId: row.leadId,
      orgId,
      brandIds: [brandId],
      runId: "run-1",
      source: "live",
    });
  });

  it("pickFollowupCandidate forwards the acting campaign to the ledger", async () => {
    const row = await seedDueRow();
    const res = await pickFollowupCandidate({
      orgId,
      campaignId: heldBy,
      runId: "run-p",
      actingCampaignId: acting,
      context: {},
    });
    expect(res.claimed?.id).toBe(row.id);
    const ledger = await db.select().from(followupActions).where(eq(followupActions.leadCampaignId, row.id));
    expect(ledger.map((r) => r.actingCampaignId)).toEqual([acting]);
  });

  it("'acted' writes a ledger row; 'scheduled' and 'stopped' do not", async () => {
    const row = await seedDueRow();
    const next = new Date(Date.now() + 86_400_000).toISOString();
    const state = await writeFollowupStatement({
      orgId, id: row.id, kind: "acted", dueAtIso: next, reason: null, nowMs: Date.now(),
      actingCampaignId: acting, runId: "run-a",
    });
    expect(state?.followupCount).toBe(1);
    expect(state?.dueAt).toBe(next);
    await writeFollowupStatement({ orgId, id: row.id, kind: "scheduled", dueAtIso: next, reason: null, nowMs: Date.now() });
    await writeFollowupStatement({ orgId, id: row.id, kind: "stopped", dueAtIso: null, reason: "replied", nowMs: Date.now() });

    const ledger = await db.select().from(followupActions).where(eq(followupActions.leadCampaignId, row.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ action: "acted", actingCampaignId: acting, runId: "run-a" });
  });

  it("an 'acted' on another org's row writes neither the row nor the ledger", async () => {
    const row = await seedDueRow();
    const state = await writeFollowupStatement({
      orgId: randomUUID(), id: row.id, kind: "acted",
      dueAtIso: new Date(Date.now() + 86_400_000).toISOString(), reason: null, nowMs: Date.now(),
      actingCampaignId: acting,
    });
    expect(state).toBeNull();
    const ledger = await db.select().from(followupActions).where(eq(followupActions.leadCampaignId, row.id));
    expect(ledger).toHaveLength(0);
  });

  it("the read groups per (acting campaign, person) and answers every named campaign", async () => {
    const a = await seedDueRow();
    const b = await seedDueRow();
    const nowMs = Date.now();
    await claimFollowup({ id: a.id, nowMs, runId: "r1", actingCampaignId: acting });
    await writeFollowupStatement({
      orgId, id: a.id, kind: "acted", dueAtIso: new Date(nowMs - 1000).toISOString(), reason: null, nowMs,
      actingCampaignId: acting, runId: "r1",
    });
    // Due again (dueAt in the past) → claimed a second time by the same campaign: still one person.
    await claimFollowup({ id: a.id, nowMs: nowMs + 1, runId: "r2", actingCampaignId: acting });
    // b is claimed but never answered.
    await claimFollowup({ id: b.id, nowMs, runId: "r3", actingCampaignId: acting });

    const { leads: rows, campaigns } = await readFollowupActions({ brandId, campaignIds: [acting, otherActing] });
    expect(rows).toHaveLength(2);
    const ra = rows.find((r) => r.leadId === a.leadId)!;
    expect(ra).toMatchObject({
      actingCampaignId: acting, email: a.email.toLowerCase(), leadCampaignIds: [a.id],
      heldByCampaignIds: [heldBy], claimCount: 2, actedCount: 1,
    });
    expect(ra.firstActedAt).not.toBeNull();
    const rb = rows.find((r) => r.leadId === b.leadId)!;
    expect(rb).toMatchObject({ claimCount: 1, actedCount: 0, firstActedAt: null });
    expect(campaigns).toEqual([
      { campaignId: acting, leadsClaimed: 2, leadsActed: 1, claims: 3, acts: 1 },
      { campaignId: otherActing, leadsClaimed: 0, leadsActed: 0, claims: 0, acts: 0 },
    ]);

    // Another brand sees nothing.
    const other = await readFollowupActions({ brandId: randomUUID(), campaignIds: [acting] });
    expect(other.leads).toHaveLength(0);
  });

  it("the migration's backfill is idempotent on source_ref", async () => {
    const row = await seedDueRow();
    const insert = () =>
      db.execute(sql`
        INSERT INTO followup_actions
          (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, run_id,
           action, occurred_at, source, source_ref)
        SELECT lc.org_id, lc.brand_ids, lc.id, lc.lead_id, lc.campaign_id, ${acting}, 'r', 'claimed',
               '2026-09-21 15:22:53+00'::timestamptz, 'windmill_backfill', ${"job-" + row.id}
        FROM leads_campaigns lc WHERE lc.id = ${row.id}
        ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
      `);
    await insert();
    await insert();
    const ledger = await db.select().from(followupActions).where(eq(followupActions.leadCampaignId, row.id));
    expect(ledger).toHaveLength(1);
  });
});
