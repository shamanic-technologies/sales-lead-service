/**
 * The labelled timeline (silver lead_timeline_facts) against a REAL database: every source lands as
 * one labelled row, a re-sync writes nothing, a changed verdict relabels the same row, a withdrawn
 * statement is kept and marked, and the read derives the conversation's tags at lead x offer x brand.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ReplyVerdictView } from "../../src/lib/reply-verdicts-client.js";

const replies: ReplyVerdictView[] = [];
vi.mock("../../src/lib/reply-verdicts-client.js", () => ({
  fetchReplyVerdicts: vi.fn(async () => replies),
}));
const offers = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-leg-client.js", () => ({
  fetchOrgCampaignOffers: vi.fn(async () => offers),
}));

const { db } = await import("../../src/db/index.js");
const { syncTimelineFacts, readTimeline } = await import("../../src/lib/timeline-facts.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("labelled timeline against a real database", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const offer = randomUUID();
  const otherOffer = randomUUID();
  const campaign = `itest-camp-${randomUUID()}`;
  const otherCampaign = `itest-camp-${randomUUID()}`;
  const email = `christina-${randomUUID()}@example.test`;
  let leadId = "";
  let rowId = "";

  function reply(id: string, over: Partial<NonNullable<ReplyVerdictView["verdict"]>>, at: string, campaignId = campaign): ReplyVerdictView {
    return {
      replyId: id,
      leadEmail: email.toUpperCase(),
      instantlyCampaignId: "ic",
      campaignId,
      brandIds: [brand],
      transport: "instantly",
      fromEmail: email,
      subject: "Re: hello",
      receivedAt: at,
      verdict: {
        kind: "k", classification: null, producerType: "model", producer: "p", attribution: "a",
        confidence: null, decidedAt: null, automatedAnswer: false, stopRequested: false,
        notOurTarget: false, handedToPerson: false, ...over,
      },
      verdictCount: 1,
    };
  }

  beforeEach(async () => {
    if (leadId) return;
    offers.set(campaign, offer);
    offers.set(otherCampaign, otherOffer);
    const lead = (await db.execute(sql`INSERT INTO leads (id) VALUES (gen_random_uuid()) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leadId = lead[0].id;
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${leadId}::uuid, 'email', ${email}, 'itest')`);
    const lc = (await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${leadId}::uuid, ${campaign}, ${org}, ARRAY[${brand}]::text[], 'served', now())
      RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    rowId = lc[0].id;
  });

  afterAll(async () => {
    for (const t of ["lead_timeline_facts", "conversion_events", "lead_step_disqualifications", "leads_campaigns"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${org}`);
    }
    if (leadId) await db.execute(sql`DELETE FROM leads WHERE id = ${leadId}::uuid`);
  });

  it("stores Christina's no as not_interested and tags the conversation by its last word", async () => {
    replies.push(reply(`r-${randomUUID()}`, { classification: "negative" }, "2026-10-07T22:13:00.000Z"));
    const first = await syncTimelineFacts(org, brand);
    expect(first).toMatchObject({ replies: 1, written: 1 });

    const t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.map((i) => [i.label, i.source, i.attributable, i.offerId])).toEqual([
      ["not_interested", "reply", true, offer],
    ]);
    expect(t.tags).toEqual({
      lastWord: "not_interested",
      lastWordAt: "2026-10-07T22:13:00.000Z",
      furthestStep: "contacted",
      furthestStepAttributable: true,
    });

    expect((await syncTimelineFacts(org, brand)).written).toBe(0);
  });

  it("relabels the same row when the verdict changes, never a second row", async () => {
    replies[0] = { ...replies[0], verdict: { ...replies[0].verdict!, classification: "positive" } };
    expect((await syncTimelineFacts(org, brand)).written).toBe(1);
    const t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.map((i) => i.label)).toEqual(["interested"]);
    expect(t.tags.lastWord).toBe("interested");
  });

  it("stores an already-a-client sale as paid_client not ours, at the brand, on every offer page", async () => {
    await db.execute(sql`
      INSERT INTO conversion_events (brand_id, org_id, event, matched_lead_id, match_confidence, attribution_status,
        source, received_at, caused_by_outreach, stated_caused_by_outreach)
      VALUES (${brand}, ${org}, 'sale', ${leadId}::uuid, 'deterministic', 'attributed', 'reply', NULL, false, false)`);
    await syncTimelineFacts(org, brand);
    for (const offerId of [offer, otherOffer, null]) {
      const t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId });
      const sale = t.items.find((i) => i.label === "paid_client");
      expect(sale).toMatchObject({ source: "reply_statement", attributable: false, attributionBasis: "person", offerId: null });
      expect(t.tags).toMatchObject({ furthestStep: "paid_client", furthestStepAttributable: false });
    }
  });

  it("keeps a reply on another offer off this offer's page", async () => {
    replies.push(reply(`r-${randomUUID()}`, { classification: "negative" }, "2026-10-08T10:00:00.000Z", otherCampaign));
    await syncTimelineFacts(org, brand);
    const here = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(here.tags.lastWord).toBe("interested");
    const there = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: otherOffer });
    expect(there.tags.lastWord).toBe("not_interested");
  });

  it("stores a stated never as not_interested and marks it withdrawn when taken back", async () => {
    await db.execute(sql`
      INSERT INTO lead_step_disqualifications (lead_id, lead_campaign_id, campaign_id, brand_id, org_id, step, source)
      VALUES (${leadId}::uuid, ${rowId}::uuid, ${campaign}, ${brand}, ${org}, 'meeting_booked', 'manual')`);
    await syncTimelineFacts(org, brand);
    let t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    const never = t.items.find((i) => i.source === "never");
    expect(never).toMatchObject({ label: "not_interested", withdrawnAt: null, attributionBasis: "stated_on_our_lead" });
    expect(t.tags.lastWord).toBe("not_interested");

    await db.execute(sql`UPDATE lead_step_disqualifications SET withdrawn_at = now() WHERE org_id = ${org}`);
    expect((await syncTimelineFacts(org, brand)).written).toBe(1);
    t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.find((i) => i.source === "never")?.withdrawnAt).not.toBeNull();
    expect(t.tags.lastWord).toBe("interested");
  });
});
