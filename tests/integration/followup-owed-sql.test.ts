/**
 * The owed read (WA-REACTIVE-LOOP-1016) against a REAL database: "is anyone owed a follow-up now on
 * these held campaigns, and if not, when?" It must agree with the claim and write NOTHING.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: async () => ({ results: [] }),
}));
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: async (id: string) => ({ id, createdAt: "2020-01-01T00:00:00.000Z" }),
}));

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, followupResponders } = await import("../../src/db/schema.js");
const { readFollowupOwed } = await import("../../src/lib/followup-owed.js");
const { pickFollowupCandidate } = await import("../../src/lib/followup-queue.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("follow-up owed read against a real database", () => {
  const heldA = `itest-owed-a-${randomUUID()}`;
  const heldB = `itest-owed-b-${randomUUID()}`;
  const responder = `itest-owed-responder-${randomUUID()}`;
  const orgId = randomUUID();
  const brandId = randomUUID();
  const MIN = 60_000;

  async function seed(campaign: string, values: Partial<typeof leadsCampaigns.$inferInsert>): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({
      leadId: lead.id,
      channel: "email",
      value: `${randomUUID()}@example.test`,
      source: "itest",
    });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId: campaign,
        orgId,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(),
        followupCount: 1,
        ...values,
      })
      .returning({ id: leadsCampaigns.id });
    return row.id;
  }

  const ask = (held: string[], nowMs = Date.now()) =>
    readFollowupOwed({ orgId, query: { campaignId: responder, heldCampaignIds: held }, nowMs });

  async function cleanup() {
    await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.campaignId, [heldA, heldB]));
    await db.delete(followupResponders).where(inArray(followupResponders.heldCampaignId, [heldA, heldB]));
  }
  beforeEach(cleanup);
  afterAll(cleanup);

  it("nobody owed now: answers false and the earliest future due moment", async () => {
    const soon = new Date(Date.now() + 30 * MIN);
    await seed(heldA, { followupDueAt: soon });
    await seed(heldA, { followupDueAt: new Date(Date.now() + 90 * MIN) });

    const answer = await ask([heldA]);
    expect(answer.owedNow).toBe(false);
    expect(answer.owedCampaignIds).toEqual([]);
    expect(answer.nextOwedAt).toBe(soon.toISOString());
  });

  it("nobody scheduled at all: owedNow false and nextOwedAt null", async () => {
    await seed(heldA, { followupDueAt: null });
    const answer = await ask([heldA]);
    expect(answer).toMatchObject({ owedNow: false, nextOwedAt: null, held: [{ campaignId: heldA, owedNow: false, nextOwedAt: null }] });
  });

  it("a person whose due date has passed is owed now", async () => {
    await seed(heldA, { followupDueAt: new Date(Date.now() - 5 * MIN) });
    const answer = await ask([heldA]);
    expect(answer.owedNow).toBe(true);
    expect(answer.owedCampaignIds).toEqual([heldA]);
  });

  it("only the SECOND held campaign has someone owed: owed now, named", async () => {
    await seed(heldA, { followupDueAt: new Date(Date.now() + 60 * MIN) });
    await seed(heldB, { followupDueAt: new Date(Date.now() - MIN) });
    const answer = await ask([heldA, heldB]);
    expect(answer.owedNow).toBe(true);
    expect(answer.owedCampaignIds).toEqual([heldB]);
    expect(answer.held.map((h) => h.owedNow)).toEqual([false, true]);
  });

  it("a live lease is not owed now; it is owed again when the lease expires", async () => {
    const claimedAt = new Date(Date.now() - 10 * MIN);
    await seed(heldA, { followupDueAt: new Date(Date.now() - 20 * MIN), followupClaimedAt: claimedAt });
    const answer = await ask([heldA]);
    expect(answer.owedNow).toBe(false);
    expect(answer.nextOwedAt).toBe(new Date(claimedAt.getTime() + 60 * MIN).toISOString());
  });

  it("a handed thread and a due date set by the holder itself are not the responder's", async () => {
    await seed(heldA, { followupDueAt: new Date(Date.now() - MIN), followupHandedAt: new Date() });
    await seed(heldA, { followupDueAt: new Date(Date.now() - MIN), followupDueSetByCampaignId: heldA });
    expect((await ask([heldA])).owedNow).toBe(false);
  });

  it("agrees with the claim: owed now, then claim-next takes that person", async () => {
    const id = await seed(heldA, { followupDueAt: new Date(Date.now() - MIN) });
    expect((await ask([heldA])).owedNow).toBe(true);
    const claim = await pickFollowupCandidate({
      orgId,
      campaignId: heldA,
      runId: null,
      actingCampaignId: responder,
      context: { orgId },
    });
    expect(claim.claimed?.id).toBe(id);
    expect((await ask([heldA])).owedNow).toBe(false); // leased now
  });

  it("a never-answered debt owed before the stored responder start is not owed (the claim hands it over)", async () => {
    await db.insert(followupResponders).values({
      heldCampaignId: heldA,
      firstResponderCampaignId: responder,
      firstResponderStartedAt: new Date(),
    });
    await seed(heldA, { followupDueAt: new Date(Date.now() - MIN), followupCount: 0 });
    expect((await ask([heldA])).owedNow).toBe(false);
  });

  it("writes NOTHING: rows, leases, ledger and responders unchanged", async () => {
    await db.insert(followupResponders).values({
      heldCampaignId: heldA,
      firstResponderCampaignId: responder,
      firstResponderStartedAt: new Date(),
    });
    await seed(heldA, { followupDueAt: new Date(Date.now() - 2 * MIN), followupCount: 0 }); // a claim would hand this over
    await seed(heldA, { followupDueAt: new Date(Date.now() - MIN) }); // a claim would lease this
    await seed(heldB, { followupDueAt: new Date(Date.now() + MIN) });
    const snapshot = async () => {
      const rows = await db.execute(
        sql`SELECT * FROM leads_campaigns WHERE campaign_id IN (${heldA}, ${heldB}) ORDER BY id`,
      );
      const ledger = await db.execute(
        sql`SELECT count(*)::int AS n FROM followup_actions WHERE held_by_campaign_id IN (${heldA}, ${heldB})`,
      );
      const responders = await db.execute(
        sql`SELECT count(*)::int AS n FROM followup_responders WHERE held_campaign_id IN (${heldA}, ${heldB})`,
      );
      return JSON.stringify({ rows, ledger, responders });
    };
    const before = await snapshot();
    expect((await ask([heldA, heldB])).owedNow).toBe(true);
    await ask([heldB, heldA]);
    expect(await snapshot()).toBe(before);
  });
});
