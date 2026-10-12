/**
 * Owner 2026-10-12: a person a sender refused for a reason about its CHANNEL is released to the brand's other pipes
 * that can reach them (src/lib/released-pool.ts), and every pool honours the pipe's reach. Raw SQL: real database.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

// The audience's offer and origin (human-service) and the channel's origins (features-service), as stated.
const audienceOffer = new Map<string, string | null>();
const audienceOrigin = new Map<string, string>();
vi.mock("../../src/lib/sourcing-origin.js", () => ({
  fetchAudienceOfferId: async (id: string) => audienceOffer.get(id) ?? null,
  // LEAK-1012: the released person's source is the audience's OWN list, never asked under the channel (a CRM channel
  // names every audience CRM).
  fetchAudienceOriginSlug: async (id: string, _orgId: string, channel: string | null) => {
    if (channel !== null) throw new Error(`origin asked under channel ${channel}: must be the audience's own list`);
    return audienceOrigin.get(id) ?? null;
  },
  loadOriginsByChannelSlug: async (channel: string) =>
    ({
      "sales-cold-email-outreach": new Set(["sourcing-apollo-cold-filters", "sourcing-crm-contacts"]),
      "cold-whatsapp-outreach": new Set(["sourcing-crm-contacts"]),
    })[channel] ?? null,
}));

import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { claimReleasedLead, releaseForChannel } from "../../src/lib/released-pool.js";
import { claimStockedLead } from "../../src/lib/source-stock.js";
import { loadRetryCandidates } from "../../src/lib/retry-pool.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("released people and the pipe's reach against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const whatsapp = `itest-wa-${randomUUID()}`;
  const email1 = `itest-em-${randomUUID()}`;
  const email2 = `itest-em-${randomUUID()}`;
  const otherOfferEmail = `itest-em-${randomUUID()}`;
  const leadIds: string[] = [];

  async function seed(campaignId: string, opts: { phone?: boolean; audienceId?: string; reason?: string } = {}) {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    leadIds.push(lead.id);
    const email = `${randomUUID()}@itest.example`;
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "apollo" });
    if (opts.phone) {
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "phone", value: `+33${Math.floor(Math.random() * 1e9)}`, source: "crm" });
    }
    await db.insert(leadsCampaigns).values({
      leadId: lead.id,
      campaignId,
      orgId,
      brandIds: [brandId],
      status: "served",
      statusReason: opts.reason ?? "served",
      servedAt: new Date("2026-10-12T08:00:00Z"),
      audienceId: opts.audienceId ?? "aud-apollo",
      featureSlug: "cold-whatsapp-outreach",
    });
    return { leadId: lead.id, email };
  }

  const take = (campaignId: string, featureSlug: string, reachableBy: ("email" | "phone")[], offerId: string | null) =>
    claimReleasedLead({
      orgId,
      campaignId,
      brandIds: [brandId],
      featureSlug,
      reachableBy,
      offerId,
      runId: randomUUID(),
      parentRunId: randomUUID(),
      userId: null,
      workflowSlug: "wf",
      goal: "signup",
      activeGoalId: null,
      brandProfileId: null,
    });

  afterAll(async () => {
    if (leadIds.length) {
      await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.leadId, leadIds));
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
  });

  it("a WhatsApp refusal releases the person: out of that campaign's retry pool, taken ONCE by an email pipe that can reach them", async () => {
    audienceOffer.set("aud-apollo", "offer-a");
    audienceOrigin.set("aud-apollo", "sourcing-apollo-cold-filters");
    const p = await seed(whatsapp);

    // Before the refusal the WhatsApp retry pool would not hand an email-only person back to a phone pipe.
    expect(await loadRetryCandidates({ orgId, campaignId: whatsapp, nowMs: Date.now(), reachableBy: ["phone"] })).toEqual([]);
    expect((await loadRetryCandidates({ orgId, campaignId: whatsapp, nowMs: Date.now() })).map((c) => c.leadId)).toEqual([p.leadId]);

    const released = await releaseForChannel({ orgId, campaignId: whatsapp, email: p.email.toUpperCase(), code: "no_phone_known" });
    expect(released).toEqual([expect.objectContaining({ leadId: p.leadId, alreadyReleased: false })]);
    const again = await releaseForChannel({ orgId, campaignId: whatsapp, email: p.email, code: "no_phone_known" });
    expect(again[0].alreadyReleased).toBe(true);
    // Out of the refusing campaign's retry pool for good.
    expect(await loadRetryCandidates({ orgId, campaignId: whatsapp, nowMs: Date.now() })).toEqual([]);

    // Another WhatsApp pipe cannot reach them; an email pipe of ANOTHER offer may not take them.
    expect(await take(`itest-wa2-${randomUUID()}`, "cold-whatsapp-outreach", ["phone"], "offer-a")).toBeNull();
    expect(await take(otherOfferEmail, "sales-cold-email-outreach", ["email"], "offer-b")).toBeNull();

    const taken = await take(email1, "sales-cold-email-outreach", ["email"], "offer-a");
    expect(taken).toMatchObject({ leadId: p.leadId, email: p.email, releasedFromCampaignId: whatsapp, audienceId: "aud-apollo" });
    const [row] = await db
      .select()
      .from(leadsCampaigns)
      .where(and(eq(leadsCampaigns.campaignId, email1), eq(leadsCampaigns.leadId, p.leadId)));
    expect(row).toMatchObject({ status: "served", statusReason: "released_from_channel", featureSlug: "sales-cold-email-outreach" });

    // Once only.
    expect(await take(email2, "sales-cold-email-outreach", ["email"], "offer-a")).toBeNull();
  });

  it("a phone pipe's stock and retry pool only hand out people carrying a phone", async () => {
    const source = `itest-src-${randomUUID()}`;
    const outreach = `itest-wa-${randomUUID()}`;
    const noPhone = await seed(source, { reason: "source_found" });
    const withPhone = await seed(source, { reason: "source_found", phone: true });
    const stocked = await claimStockedLead({
      orgId,
      sourceCampaignIds: [source],
      outreachCampaignId: outreach,
      brandIds: [brandId],
      featureSlug: "cold-whatsapp-outreach",
      runId: randomUUID(),
      parentRunId: randomUUID(),
      userId: null,
      workflowSlug: "wf",
      goal: null,
      activeGoalId: null,
      brandProfileId: null,
      reachableBy: ["phone"],
      askFit: async () => ({ fits: true }),
    });
    expect(stocked.lead?.leadId).toBe(withPhone.leadId);
    expect(stocked.lead?.leadId).not.toBe(noPhone.leadId);
  });
});
