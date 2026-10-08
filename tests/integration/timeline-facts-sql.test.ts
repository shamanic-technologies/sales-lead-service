/**
 * The labelled timeline (silver lead_timeline_facts) against a REAL database: every source lands as
 * one labelled row, a re-sync writes nothing, a changed verdict relabels the same row, a withdrawn
 * statement is kept and marked, and the read derives the conversation's tags at lead x offer x brand.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const offers = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-leg-client.js", () => ({
  fetchOrgCampaignOffers: vi.fn(async () => offers),
}));
vi.mock("../../src/lib/brand-client.js", () => ({
  getBrandSite: vi.fn(async () => ({ domain: "wellconnected.example", clickDestinationUrl: "https://book.wellconnected.example/x" })),
}));

const { db } = await import("../../src/db/index.js");
const { syncTimelineFacts, readTimeline } = await import("../../src/lib/timeline-facts.js");
const { ingestOutreachFactsPage } = await import("../../src/lib/outreach-fact-feed.js");

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

  let seq = Math.floor(Math.random() * 1e12) * 100;
  function fact(type: string, subjectKey: string, at: string, body: Record<string, unknown>, over: Record<string, unknown> = {}) {
    seq += 1;
    return {
      seq: String(seq), type, subjectKey, supersedesSeq: null, occurredAt: at, recordedAt: at,
      leadEmail: email.toUpperCase(), orgId: org, campaignId: campaign, instantlyCampaignId: "ic",
      brandIds: [brand], transport: "instantly",
      send: null, open: null, click: null, bounce: null, unsubscribe: null, reply: null, withdrawal: null,
      ...body, ...over,
    };
  }
  function replyFact(replyId: string, verdict: Record<string, unknown>, at: string, over: Record<string, unknown> = {}, judgments: Record<string, unknown> = {}) {
    return fact("reply", `reply:${replyId}`, at, {
      reply: {
        replyId, subject: "Re: hello", receivedAt: at,
        verdict: { kind: "k", classification: null, automatedAnswer: false, stopRequested: false, notOurTarget: false,
          handedToPerson: false, positiveSignal: null, declinedOffer: false, notOurTargetReason: null, handoffReason: null, ...verdict },
        judgments: { question: null, proposalType: null, ...judgments }, escalation: null,
      },
    }, over);
  }
  async function feed(...facts: unknown[]) {
    await ingestOutreachFactsPage({ facts, nextCursor: String(seq), hasMore: false });
  }
  const replyId = `r-${randomUUID()}`;

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
    for (const t of ["lead_timeline_facts", "conversion_events", "lead_step_disqualifications", "leads_campaigns", "outreach_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${org}`);
    }
    if (leadId) await db.execute(sql`DELETE FROM leads WHERE id = ${leadId}::uuid`);
  });

  it("stores Christina's no as not_interested and tags the conversation by its last word", async () => {
    await feed(
      fact("email_sent", `ievt:s1-${replyId}`, "2026-09-30T10:00:00.000Z", { send: { step: 1, position: "first", positionBasis: "step", accountEmail: "bria@x" } }),
      fact("email_sent", `ievt:s2-${replyId}`, "2026-10-03T10:00:00.000Z", { send: { step: 2, position: "followup", positionBasis: "step", accountEmail: "bria@x" } }),
      fact("email_sent", `ievt:s3-${replyId}`, "2026-10-07T10:00:00.000Z", { send: { step: 3, position: "followup", positionBasis: "step", accountEmail: "bria@x" } }),
      replyFact(replyId, { classification: "negative", declinedOffer: true }, "2026-10-07T22:13:00.000Z"),
    );
    const first = await syncTimelineFacts(org, brand);
    expect(first).toMatchObject({ outreach: 4, written: 4 });

    const t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.map((i) => [i.label, i.source, i.attributable, i.offerId])).toEqual([
      ["initial_email", "outreach", true, offer],
      ["followup", "outreach", true, offer],
      ["followup", "outreach", true, offer],
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
    const prev = seq;
    await feed(replyFact(replyId, { classification: "positive", positiveSignal: "interest" }, "2026-10-07T22:13:00.000Z", { supersedesSeq: String(prev) }));
    expect((await syncTimelineFacts(org, brand)).written).toBe(1);
    const t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.filter((i) => i.source === "reply").map((i) => i.label)).toEqual(["interested"]);
    expect(t.tags.lastWord).toBe("interested");
  });

  it("labels clicks by where they went, and a withdrawn fact keeps its row, marked", async () => {
    await feed(
      fact("link_clicked", `ievt:c1-${replyId}`, "2026-10-01T10:00:00.000Z", { click: { step: 1, url: "https://www.wellconnected.example/about" } }),
      fact("link_clicked", `ievt:c2-${replyId}`, "2026-10-01T10:01:00.000Z", { click: { step: 1, url: "https://calendly.com/x" } }),
      fact("email_opened", `ievt:o1-${replyId}`, "2026-10-01T09:00:00.000Z", { open: { step: 1 } }),
    );
    await syncTimelineFacts(org, brand);
    let t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.filter((i) => i.url).map((i) => [i.label, i.url])).toEqual([
      ["website_visit", "https://www.wellconnected.example/about"],
      ["link_click", "https://calendly.com/x"],
    ]);
    await feed(fact("withdrawn", `ievt:o1-${replyId}`, "2026-10-02T00:00:00.000Z", {
      withdrawal: { withdrawnSeq: "1", withdrawnType: "email_opened", reason: "source_removed" } }));
    expect((await syncTimelineFacts(org, brand)).written).toBe(1);
    t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId: offer });
    expect(t.items.find((i) => i.label === "opened")?.withdrawnAt).not.toBeNull();
  });

  it("stores an already-a-client reply as paid_client not ours, and the sale it wrote only once", async () => {
    await feed(replyFact(`r-${randomUUID()}`, { notOurTarget: true, notOurTargetReason: "already_customer", classification: "negative" },
      "2026-10-08T09:00:00.000Z", { campaignId: null }));
    await db.execute(sql`
      INSERT INTO conversion_events (brand_id, org_id, event, matched_lead_id, match_confidence, attribution_status,
        source, received_at, caused_by_outreach, stated_caused_by_outreach)
      VALUES (${brand}, ${org}, 'sale', ${leadId}::uuid, 'deterministic', 'attributed', 'reply', NULL, false, false)`);
    await syncTimelineFacts(org, brand);
    for (const offerId of [offer, otherOffer, null]) {
      const t = await readTimeline({ orgId: org, brandId: brand, leadId, offerId });
      const sales = t.items.filter((i) => i.label === "paid_client");
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ source: "reply", attributable: false, attributionBasis: "prospect_said", offerId: null });
      expect(t.tags).toMatchObject({ furthestStep: "paid_client", furthestStepAttributable: false });
    }
  });

  it("keeps a reply on another offer off this offer's page", async () => {
    await feed(replyFact(`r-${randomUUID()}`, { classification: "negative" }, "2026-10-08T10:00:00.000Z", { campaignId: otherCampaign }));
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
