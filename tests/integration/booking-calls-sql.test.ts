/**
 * The `booking_call` bucket's evidence against a REAL database: a person an AI Instant Call
 * campaign (leg conversation_to_booking_call) acted on is in it; an act by another leg's campaign,
 * a mere claim, another brand or another org is not. The array binds and the brand containment do
 * not compile under a mocked `sql`, so this file runs them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const legCalls: string[] = [];
const callCampaign = `itest-call-${randomUUID()}`;
const bookingCampaign = `itest-booking-${randomUUID()}`;

vi.mock("../../src/lib/campaign-leg-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-leg-client.js")>()),
  fetchOrgCampaignLegs: async ({ orgId }: { orgId: string }) => {
    legCalls.push(orgId);
    return new Map<string, string | null>([
      [callCampaign, "conversation_to_booking_call"],
      [bookingCampaign, "conversation_to_meeting_booked"],
    ]);
  },
}));

const { db } = await import("../../src/db/index.js");
const { leads, followupActions } = await import("../../src/db/schema.js");
const { fetchBookingCallLeadIds } = await import("../../src/lib/booking-calls.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("booking-call evidence against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const heldBy = `itest-held-${randomUUID()}`;
  const ids: Record<string, string> = {};

  async function lead(name: string): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name }).returning({ id: leads.id });
    ids[name] = row.id;
    return row.id;
  }

  async function act(leadId: string, over: Partial<typeof followupActions.$inferInsert> = {}) {
    await db.insert(followupActions).values({
      orgId,
      brandIds: [brandId],
      leadCampaignId: randomUUID(),
      leadId,
      heldByCampaignId: heldBy,
      actingCampaignId: callCampaign,
      action: "acted",
      occurredAt: new Date(),
      source: "acted_by_email",
      ...over,
    });
  }

  beforeAll(async () => {
    await act(await lead("called"));
    await act(await lead("calledBackfill"), { source: "twilio_backfill" });
    await act(await lead("booking"), { actingCampaignId: bookingCampaign });
    await act(await lead("claimedOnly"), { action: "claimed" });
    await act(await lead("otherBrand"), { brandIds: [randomUUID()] });
    await act(await lead("otherOrg"), { orgId: randomUUID() });
    await act(await lead("noActing"), { actingCampaignId: null });
    await lead("nothing");
  });

  afterAll(async () => {
    await db.delete(followupActions).where(eq(followupActions.heldByCampaignId, heldBy));
  });

  it("holds exactly the people a booking-call campaign acted on, at the brand", async () => {
    const got = await fetchBookingCallLeadIds(orgId, brandId, Object.values(ids));
    expect([...got].sort()).toEqual([ids.called, ids.calledBackfill].sort());
  });

  it("without a brand, reads the whole org (another brand's call counts, another org's does not)", async () => {
    const got = await fetchBookingCallLeadIds(orgId, undefined, Object.values(ids));
    expect([...got].sort()).toEqual([ids.called, ids.calledBackfill, ids.otherBrand].sort());
  });

  it("asks campaign-service nothing when nobody holds an act", async () => {
    legCalls.length = 0;
    const got = await fetchBookingCallLeadIds(orgId, brandId, [ids.nothing, ids.claimedOnly]);
    expect(got.size).toBe(0);
    expect(legCalls).toEqual([]);
  });
});
