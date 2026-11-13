/**
 * SCRIPT-VALUE-RATING-1113-LEAD against a REAL database: a campaign's proactive tick asking ONLY for a due lead its
 * brand holds (buffer/next `dueFollowupOnly`, `claimDueFollowupLead` fileAs "outreach_held") gets that person filed on
 * itself as a claimable debt, held for it: a second campaign asking in the same round gets nobody, the answerer then
 * claims the person on that campaign exactly as an occurrence's person (claim-next `person`), once. A hold nobody
 * claims ends and the person is due again for anyone. Staff test addresses only.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: vi.fn(async (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) => ({
    results: items.map(({ email }) => ({
      email,
      broadcast: {
        brand: { queued: false, unsubscribed: false, bounced: false },
        global: { email: { unsubscribed: false, bounced: false } },
      },
    })),
  })),
}));
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: async (id: string) => ({ id, createdAt: "2020-01-01T00:00:00.000Z" }),
}));

const { db } = await import("../../src/db/index.js");
const fd = await import("../../src/lib/lead-followup-date.js");
const { pickFollowupCandidate } = await import("../../src/lib/followup-queue.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("a proactive tick serves only a due lead its brand holds, held for its claim (SCRIPT-VALUE-RATING-1113)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignA = `itest-meeting-booked-${randomUUID()}`;
  const campaignB = `itest-meeting-attended-${randomUUID()}`;
  const campaignC = `itest-cold-${randomUUID()}`;
  const leads: string[] = [];

  /** A person the brand emailed 9 days ago, never answered: their one date passed 2 days ago. */
  async function emailed(name: string): Promise<{ leadId: string; email: string }> {
    const [row] = (await db.execute(sql`INSERT INTO leads (first_name, human_id) VALUES (${name}, ${randomUUID()}::uuid) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leads.push(row.id);
    const email = `kevin+held-${name}-${randomUUID().slice(0, 6)}@distribute.you`;
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'email', ${email}, 'itest')`);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, sent_at)
      VALUES (${row.id}::uuid, ${campaignC}, ${orgId}, ARRAY[${brandId}]::text[], 'served', now() - interval '9 days', now() - interval '9 days')`);
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    await fd.applySends([{ orgId, brandId, leadId: row.id, sentAt: new Date(Date.now() - 9 * 86_400_000).toISOString(), channel: "email" }]);
    return { leadId: row.id, email };
  }

  const serve = (campaignId: string, fileAs: "outreach_held" | "outreach" = "outreach_held") =>
    fd.claimDueFollowupLead({
      orgId,
      brandId,
      brandIds: [brandId],
      sourceCampaignId: campaignId,
      fileAs,
      maxPasses: 2,
      featureSlug: "dy-answer-lead",
      runId: `run-${randomUUID()}`,
      parentRunId: null,
      userId: null,
      workflowSlug: "dy-answer-lead-v1",
      goal: null,
      activeGoalId: null,
      brandProfileId: null,
      reachableBy: ["email"],
      acceptedEmails: "as_found",
      recentlyEmailed: null,
    });

  const claim = (campaignId: string, leadId: string) =>
    pickFollowupCandidate({ orgId, campaignId, runId: randomUUID(), actingCampaignId: campaignId, context: { orgId }, person: { leadId, email: null, phone: null } });

  async function dateOf(leadId: string) {
    return fd.loadFollowupDate(orgId, brandId, leadId);
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM followup_actions WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM followup_responders WHERE held_campaign_id = ANY(${sql.param([campaignA, campaignB, campaignC])}::text[])`);
    await db.execute(sql`DELETE FROM lead_followup_due_serves WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_followup_dates WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leads)}::uuid[])`);
  });

  it("one campaign gets the due person, held; another campaign asking gets nobody; the answerer claims them once on that campaign", async () => {
    const p = await emailed("thomas");
    const before = await dateOf(p.leadId);
    expect(new Date(before.nextFollowupAt!).getTime()).toBeLessThan(Date.now());

    const served = await serve(campaignA);
    expect(served?.leadId).toBe(p.leadId);
    // Filed on the asking campaign as a debt due now, claimable by any campaign (lead-service states it).
    const [row] = (await db.execute(sql`
      SELECT campaign_id, status, followup_due_at, followup_due_set_by_campaign_id FROM leads_campaigns WHERE id = ${served!.leadCampaignId}::uuid
    `)) as unknown as Array<{ campaign_id: string; status: string; followup_due_at: string | null; followup_due_set_by_campaign_id: string | null }>;
    expect(row).toMatchObject({ campaign_id: campaignA, status: "served", followup_due_set_by_campaign_id: null });
    expect(row.followup_due_at).not.toBeNull();
    // The person's ONE date is untouched: the claim takes it.
    expect((await dateOf(p.leadId)).nextFollowupAt).toEqual(before.nextFollowupAt);

    // Same round: another campaign's held ask, and a proactive serve's due step, get nobody.
    expect(await serve(campaignB)).toBeNull();
    expect(await serve(campaignC, "outreach")).toBeNull();

    // A's answerer claims the person on A, as it claims an occurrence's person.
    const got = await claim(campaignA, p.leadId);
    expect(got.claimed?.leadId).toBe(p.leadId);
    expect(got.claimed?.campaignId).toBe(campaignA);
    // The claim consumed the hold and took the person's date.
    const [hold] = (await db.execute(sql`
      SELECT handed_at, held_for_claim_until FROM lead_followup_due_serves WHERE lead_campaign_id = ${served!.leadCampaignId}::uuid
    `)) as unknown as Array<{ handed_at: string | null; held_for_claim_until: string | null }>;
    expect(hold.handed_at).not.toBeNull();
    expect(hold.held_for_claim_until).not.toBeNull();
    expect(await dateOf(p.leadId)).toMatchObject({ basis: "not_yet" });

    // Exactly once: a second claim, or a claim by B, gets nobody.
    expect((await claim(campaignA, p.leadId)).claimed).toBeNull();
    expect((await claim(campaignB, p.leadId)).claimed).toBeNull();
    expect(await serve(campaignB)).toBeNull();
  });

  it("a hold nobody claims ends: the person is due again for anyone", async () => {
    await db.execute(sql`UPDATE lead_followup_dates SET next_followup_at = now() + interval '300 days' WHERE org_id = ${orgId} AND basis <> 'stopped'`);
    const q = await emailed("markus");
    const served = await serve(campaignA);
    expect(served?.leadId).toBe(q.leadId);
    expect(await serve(campaignB)).toBeNull();
    await db.execute(sql`UPDATE lead_followup_due_serves SET held_for_claim_until = now() - interval '1 minute' WHERE lead_campaign_id = ${served!.leadCampaignId}::uuid`);
    const again = await serve(campaignB);
    expect(again?.leadId).toBe(q.leadId);
    expect((await claim(campaignB, q.leadId)).claimed?.campaignId).toBe(campaignB);
  });
});
