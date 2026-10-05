/**
 * What an acting (conversation-leg) campaign did with the people handed to it, executed against a
 * REAL database: the ledger, the queue columns of the handed rows and the booked outcomes are joined
 * in one raw statement with array binds, which a mocked `sql` does not compile.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns, followupActions, conversionEvents } = await import("../../src/db/schema.js");
const { readConversationCounts } = await import("../../src/lib/followup-actions.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("conversation counts against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const heldBy = `itest-held-${randomUUID()}`;
  const acting = `itest-acting-${randomUUID()}`;

  async function seedHanded(
    queue: { dueAt?: Date | null; claimedAt?: Date | null; stoppedReason?: string | null },
    opts: { actions?: Array<"claimed" | "acted">; org?: string } = {},
  ): Promise<{ rowId: string; leadId: string }> {
    const org = opts.org ?? orgId;
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId: heldBy,
        orgId: org,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(),
        followupDueAt: queue.dueAt ?? null,
        followupClaimedAt: queue.claimedAt ?? null,
        followupStoppedReason: queue.stoppedReason ?? null,
      })
      .returning({ id: leadsCampaigns.id });
    for (const action of opts.actions ?? ["claimed"]) {
      await db.insert(followupActions).values({
        orgId: org,
        brandIds: [brandId],
        leadCampaignId: row.id,
        leadId: lead.id,
        heldByCampaignId: heldBy,
        actingCampaignId: acting,
        action,
        occurredAt: new Date(),
      });
    }
    return { rowId: row.id, leadId: lead.id };
  }

  async function book(leadId: string, event: string, withdrawn = false) {
    await db.insert(conversionEvents).values({
      brandId,
      orgId,
      event,
      matchedLeadId: leadId,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "manual",
      withdrawnAt: withdrawn ? new Date() : null,
    });
  }

  async function clean() {
    await db.delete(followupActions).where(eq(followupActions.heldByCampaignId, heldBy));
    await db.delete(conversionEvents).where(eq(conversionEvents.brandId, brandId));
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, heldBy));
  }

  beforeEach(clean);
  afterAll(clean);

  it("a campaign handed nobody answers zeros", async () => {
    expect(await readConversationCounts({ orgId, campaignId: acting, nowMs: Date.now() })).toEqual({
      handed: 0,
      ongoing: 0,
      meetingsBooked: 0,
      dropped: 0,
    });
  });

  it("partitions each handed person once: booked > ongoing > dropped", async () => {
    const now = Date.now();
    // ongoing: owed a next answer
    await seedHanded({ dueAt: new Date(now + 86_400_000) }, { actions: ["claimed", "acted", "claimed", "acted"] });
    // ongoing: being answered right now (live lease, due date released by the claim)
    await seedHanded({ claimedAt: new Date(now - 60_000) });
    // dropped: lease expired, nothing owed
    await seedHanded({ claimedAt: new Date(now - 2 * 3_600_000) });
    // dropped: stopped by the responder
    await seedHanded({ stoppedReason: "The automated responder could not answer: price?" }, { actions: ["claimed"] });
    // booked, even though a due date is still set
    const booked = await seedHanded({ dueAt: new Date(now + 86_400_000) }, { actions: ["claimed", "acted"] });
    await book(booked.leadId, "meeting_booked");
    // a withdrawn booking is no booking: dropped
    const withdrawn = await seedHanded({ stoppedReason: "no_reply_owed" });
    await book(withdrawn.leadId, "meeting_booked", true);
    // a step that is not a booking does not count as one
    const signup = await seedHanded({ stoppedReason: "no_reply_owed" });
    await book(signup.leadId, "signup");
    // another org's ledger row on the same acting campaign id is not ours
    await seedHanded({ dueAt: new Date(now + 86_400_000) }, { org: otherOrgId });

    const counts = await readConversationCounts({ orgId, campaignId: acting, nowMs: now });
    expect(counts).toEqual({ handed: 7, ongoing: 2, meetingsBooked: 1, dropped: 4 });
    expect(counts.handed).toBe(counts.ongoing + counts.meetingsBooked + counts.dropped);
  });

  it("a person whose handed row was deleted (requeued) is dropped, not lost", async () => {
    const { rowId } = await seedHanded({ dueAt: new Date(Date.now() + 86_400_000) });
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.id, rowId));
    expect(await readConversationCounts({ orgId, campaignId: acting, nowMs: Date.now() })).toEqual({
      handed: 1,
      ongoing: 0,
      meetingsBooked: 0,
      dropped: 1,
    });
  });
});
