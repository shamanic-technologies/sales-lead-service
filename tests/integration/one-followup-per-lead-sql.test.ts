/**
 * ONE NEXT FOLLOW-UP DATE PER LEAD (ONE-FOLLOWUP-PER-LEAD-1103), against a real database.
 *
 * Doc Dinners 2026-11-02: Thomas replied to the cold email (row B, campaign C). The meeting-booking responder (campaign
 * R) answered him on its own row A and set his next follow-up 3 days out, on A only; 16 s later an untriggered tick of
 * the same responder claimed him again through B (its predecessor list), whose due date still said "now", and a second
 * reply went out. The WHEN of a follow-up is the person's ONE date at the brand: this file replays that sequence.
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
const { claimFollowup, pickFollowupCandidate, writeFollowupStatement } = await import("../../src/lib/followup-queue.js");
const { readFollowupOwed } = await import("../../src/lib/followup-owed.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("one next follow-up date per lead, whatever row a claim goes through", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const cold = `itest-cold-${randomUUID()}`; // C: the cold-email campaign (predecessor)
  const responder = `itest-responder-${randomUUID()}`; // R: the reactive meeting-booking campaign
  let leadId = "";

  async function seedPerson(): Promise<{ rowA: string; rowB: string }> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    leadId = lead.id;
    await db.insert(leadContactMethods).values({ leadId, channel: "email", value: `${randomUUID()}@example.test`, source: "itest" });
    const rows = await db
      .insert(leadsCampaigns)
      .values([
        { leadId, campaignId: responder, orgId, brandIds: [brandId], status: "served", servedAt: new Date() },
        { leadId, campaignId: cold, orgId, brandIds: [brandId], status: "served", servedAt: new Date() },
      ])
      .returning({ id: leadsCampaigns.id, campaignId: leadsCampaigns.campaignId });
    return { rowA: rows.find((r) => r.campaignId === responder)!.id, rowB: rows.find((r) => r.campaignId === cold)!.id };
  }

  async function cleanup() {
    await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.campaignId, [cold, responder]));
    await db.delete(followupResponders).where(inArray(followupResponders.heldCampaignId, [cold, responder]));
    await db.execute(sql`DELETE FROM lead_followup_dates WHERE org_id = ${orgId}`);
  }

  async function personDate(): Promise<{ nextFollowupAt: Date | null; basis: string }> {
    const [d] = (await db.execute(sql`
      SELECT next_followup_at, basis FROM lead_followup_dates WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ${leadId}::uuid
    `)) as unknown as Array<{ next_followup_at: Date | string | null; basis: string }>;
    return { nextFollowupAt: d.next_followup_at === null ? null : new Date(d.next_followup_at), basis: d.basis };
  }

  const pick = (campaignId: string, nowMs: number) =>
    pickFollowupCandidate({ orgId, campaignId, runId: randomUUID(), actingCampaignId: responder, context: { orgId }, nowMs });

  beforeEach(cleanup);
  afterAll(cleanup);

  it("Thomas: answered through row A, never claimed again through row B before the single next date", async () => {
    const { rowA, rowB } = await seedPerson();
    const t0 = Date.now();
    // 19:34:52 the reply is observed on the cold row (an observer: no acting campaign).
    await writeFollowupStatement({ orgId, id: rowB, kind: "scheduled", dueAtIso: new Date(t0 - 1_000).toISOString(), reason: "replied", nowMs: t0 });
    // The occurrence names him on the responder's own row.
    await writeFollowupStatement({ orgId, id: rowA, kind: "scheduled", dueAtIso: new Date(t0).toISOString(), reason: "occurrence", nowMs: t0, actingCampaignId: responder });

    // 19:35:xx the responder claims him through its own row and answers, next follow-up 3 days out.
    const first = await pick(responder, t0 + 1_000);
    expect(first.claimed?.id).toBe(rowA);
    const next = new Date(t0 + 3 * 86_400_000).toISOString();
    await writeFollowupStatement({ orgId, id: rowA, kind: "acted", dueAtIso: next, reason: "answered", nowMs: t0 + 2_000, actingCampaignId: responder });

    // 16 s later the untriggered tick goes through the predecessor's row: nobody is due.
    const second = await pick(cold, t0 + 18_000);
    expect(second.claimed).toBeNull();
    expect((await personDate()).nextFollowupAt?.toISOString()).toBe(next);

    // The owed read agrees: nobody owed now, next at the single date.
    const owed = await readFollowupOwed({ orgId, query: { campaignId: responder, heldCampaignIds: [cold, responder] }, nowMs: t0 + 18_000 });
    expect(owed.owedNow).toBe(false);
    expect(owed.nextOwedAt).toBe(next);

    // Once the date comes, ONE of the rows is claimable again, and only one.
    const later = t0 + 3 * 86_400_000 + 1_000;
    const [x, y] = await Promise.all([pick(cold, later), pick(responder, later)]);
    expect([x.claimed, y.claimed].filter(Boolean)).toHaveLength(1);
  });

  it("two claims of one person through two rows at the same instant: exactly one wins", async () => {
    const { rowA, rowB } = await seedPerson();
    const t0 = Date.now();
    await writeFollowupStatement({ orgId, id: rowB, kind: "scheduled", dueAtIso: new Date(t0 - 1_000).toISOString(), reason: "replied", nowMs: t0 });
    await writeFollowupStatement({ orgId, id: rowA, kind: "scheduled", dueAtIso: new Date(t0 - 1_000).toISOString(), reason: "replied", nowMs: t0 });

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimFollowup({ id: i % 2 ? rowA : rowB, nowMs: t0 + 1_000, runId: randomUUID(), actingCampaignId: responder })),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await personDate()).basis).toBe("not_yet");
  });

  it("an answer naming no next date moves the person a send gap out, so the other row is not due when the lease ends", async () => {
    const { rowA, rowB } = await seedPerson();
    const t0 = Date.now();
    await writeFollowupStatement({ orgId, id: rowB, kind: "scheduled", dueAtIso: new Date(t0 - 1_000).toISOString(), reason: "replied", nowMs: t0 });
    await writeFollowupStatement({ orgId, id: rowA, kind: "scheduled", dueAtIso: new Date(t0).toISOString(), reason: "occurrence", nowMs: t0, actingCampaignId: responder });
    expect((await pick(responder, t0 + 1_000)).claimed?.id).toBe(rowA);
    await writeFollowupStatement({ orgId, id: rowA, kind: "acted", dueAtIso: null, reason: "answered", nowMs: t0 + 2_000, actingCampaignId: responder });

    expect((await pick(cold, t0 + 2 * 60 * 60_000)).claimed).toBeNull();
    const d = await personDate();
    expect(d.basis).toBe("send");
    expect(d.nextFollowupAt!.getTime()).toBe(t0 + 2_000 + 7 * 86_400_000);
  });

  it("a reply observed after our answer brings the single date back to now", async () => {
    const { rowA, rowB } = await seedPerson();
    const t0 = Date.now();
    await writeFollowupStatement({ orgId, id: rowA, kind: "scheduled", dueAtIso: new Date(t0).toISOString(), reason: "occurrence", nowMs: t0, actingCampaignId: responder });
    expect((await pick(responder, t0 + 1_000)).claimed?.id).toBe(rowA);
    await writeFollowupStatement({ orgId, id: rowA, kind: "acted", dueAtIso: new Date(t0 + 3 * 86_400_000).toISOString(), reason: "answered", nowMs: t0 + 2_000, actingCampaignId: responder });
    // They write back an hour later: the observer states the debt on the cold row, due now.
    const replyAt = t0 + 60 * 60_000;
    await writeFollowupStatement({ orgId, id: rowB, kind: "scheduled", dueAtIso: new Date(replyAt).toISOString(), reason: "replied again", nowMs: replyAt });
    expect((await pick(cold, replyAt + 1_000)).claimed?.id).toBe(rowB);
  });
});
