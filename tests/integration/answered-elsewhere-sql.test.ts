/**
 * WHATEVER ANSWERS A PERSON CLOSES THEIR DEBT (STALE-OWED-1119), against a real database.
 *
 * Prod 2026-11-19: one Lead event occurrence named drkaylynne on two trigger-run units of Doc Dinners (95e0219e and
 * c44e6fb2). 95e0219e claimed and answered her; the c44e6fb2 row kept its open occurrence debt, due since 11-11, so the
 * owed read kept answering "someone is owed" for a unit whose only person was already answered. The claim that takes a
 * person now closes their other open occurrence debts at the brand; a claim whose run FAILS keeps its own row due, so
 * the person stays owed on the claiming queue (ANSWER-RETRY-1106).
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
const { pickFollowupCandidate, writeFollowupStatement, FOLLOWUP_CLAIM_LEASE_MS, ANSWERED_ELSEWHERE_REASON } = await import(
  "../../src/lib/followup-queue.js"
);
const { readFollowupOwed } = await import("../../src/lib/followup-owed.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("an occurrence debt answered through another unit of the brand", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const unitX = `itest-unit-x-${randomUUID()}`; // the unit whose run was folded / refused
  const unitY = `itest-unit-y-${randomUUID()}`; // the unit whose run answered

  async function seedPerson(): Promise<{ rowX: string; rowY: string }> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: `${randomUUID()}@example.test`, source: "itest" });
    const rows = await db
      .insert(leadsCampaigns)
      .values([
        { leadId: lead.id, campaignId: unitX, orgId, brandIds: [brandId], status: "served", servedAt: new Date() },
        { leadId: lead.id, campaignId: unitY, orgId, brandIds: [brandId], status: "served", servedAt: new Date() },
      ])
      .returning({ id: leadsCampaigns.id, campaignId: leadsCampaigns.campaignId });
    return { rowX: rows.find((r) => r.campaignId === unitX)!.id, rowY: rows.find((r) => r.campaignId === unitY)!.id };
  }

  /** campaign-service files the occurrence on a unit: schedule-by-email with statedBy (no acting campaign). */
  const occurrence = (id: string, eventId: string, atMs: number) =>
    writeFollowupStatement({
      orgId,
      id,
      kind: "scheduled",
      dueAtIso: new Date(atMs).toISOString(),
      reason: "lead event",
      nowMs: atMs,
      statedBy: { triggerEventId: eventId, triggerId: "lead_event" },
    });

  const owed = (unit: string, nowMs: number) => readFollowupOwed({ orgId, query: { campaignId: unit, heldCampaignIds: [unit] }, nowMs });
  const pick = (unit: string, nowMs: number) =>
    pickFollowupCandidate({ orgId, campaignId: unit, runId: randomUUID(), actingCampaignId: unit, context: { orgId }, nowMs });

  async function rowOf(id: string) {
    const [r] = (await db.execute(sql`
      SELECT followup_due_at, followup_stated_closed_at, followup_stopped_reason FROM leads_campaigns WHERE id = ${id}::uuid
    `)) as unknown as Array<{ followup_due_at: unknown; followup_stated_closed_at: unknown; followup_stopped_reason: string | null }>;
    return r;
  }

  async function cleanup() {
    await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.campaignId, [unitX, unitY]));
    await db.delete(followupResponders).where(inArray(followupResponders.heldCampaignId, [unitX, unitY]));
    await db.execute(sql`DELETE FROM lead_followup_dates WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM followup_actions WHERE org_id = ${orgId}`);
  }
  beforeEach(cleanup);
  afterAll(cleanup);

  it("answered by unit Y: unit X is no longer owed, its occurrence debt closed with the reason", async () => {
    const { rowX, rowY } = await seedPerson();
    const t0 = Date.now() - 10 * 60_000;
    await occurrence(rowX, `ev-x-${randomUUID()}`, t0);
    await occurrence(rowY, `ev-y-${randomUUID()}`, t0);
    expect((await owed(unitX, t0 + 1_000)).owedNow).toBe(true);

    expect((await pick(unitY, t0 + 2_000)).claimed?.id).toBe(rowY);
    // Y answers: a next date three days out.
    await writeFollowupStatement({
      orgId, id: rowY, kind: "acted", dueAtIso: new Date(t0 + 3 * 86_400_000).toISOString(), reason: "answered", nowMs: t0 + 3_000, actingCampaignId: unitY,
    });

    expect(await rowOf(rowX)).toMatchObject({ followup_due_at: null, followup_stopped_reason: ANSWERED_ELSEWHERE_REASON });
    expect((await rowOf(rowX)).followup_stated_closed_at).not.toBeNull();
    const x = await owed(unitX, t0 + 4_000);
    expect(x.owedNow).toBe(false);
    expect(x.nextOwedAt).toBeNull(); // never owed again through X when Y's date comes
    expect((await pick(unitX, t0 + 3 * 86_400_000 + 1_000)).claimed).toBeNull();
  });

  it("Y's answering run FAILED: the person stays owed on Y once the lease ends (ANSWER-RETRY-1106)", async () => {
    const { rowX, rowY } = await seedPerson();
    const t0 = Date.now() - 3 * FOLLOWUP_CLAIM_LEASE_MS;
    await occurrence(rowX, `ev-x-${randomUUID()}`, t0);
    await occurrence(rowY, `ev-y-${randomUUID()}`, t0);
    expect((await pick(unitY, t0 + 1_000)).claimed?.id).toBe(rowY);
    // The run dies: no act, no date. After the lease the person is owed again, on the claiming unit.
    const afterLease = t0 + 1_000 + FOLLOWUP_CLAIM_LEASE_MS + 1_000;
    expect((await owed(unitY, afterLease)).owedNow).toBe(true);
    expect((await owed(unitX, afterLease)).owedNow).toBe(false);
    expect((await pick(unitY, afterLease)).claimed?.id).toBe(rowY);
  });

  it("an occurrence stated AFTER the answer is a new debt: owed on its unit", async () => {
    const { rowX, rowY } = await seedPerson();
    const t0 = Date.now() - 10 * 60_000;
    await occurrence(rowY, `ev-y-${randomUUID()}`, t0);
    expect((await pick(unitY, t0 + 1_000)).claimed?.id).toBe(rowY);
    await writeFollowupStatement({ orgId, id: rowY, kind: "acted", dueAtIso: null, reason: "answered", nowMs: t0 + 2_000, actingCampaignId: unitY });
    // They act again later: a new occurrence names them on X, which a later claim answers through X itself.
    const later = t0 + 5 * 60_000;
    await occurrence(rowX, `ev-x-${randomUUID()}`, later);
    expect((await owed(unitX, later + 1_000)).owedNow).toBe(true);
    expect((await pick(unitX, later + 1_000)).claimed?.id).toBe(rowX);
  });
});
