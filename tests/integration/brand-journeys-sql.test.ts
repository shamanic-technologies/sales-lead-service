/**
 * The brand-wide journey read (`streamBrandJourneys`) against a REAL database: one entry per
 * person x offer, withdrawn facts out, unknown labels kept, our emails compacted into acts,
 * follow-up acts offered through the campaign map, null-offer facts kept apart.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { db, sql } = await import("../../src/db/index.js");
const { leads } = await import("../../src/db/schema.js");
const { upsertTimelineFacts } = await import("../../src/lib/timeline-facts.js");
const { streamBrandJourneys } = await import("../../src/lib/brand-journeys.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("brand journeys read against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const offerA = randomUUID();
  const offerB = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const cA = `cA-${tag}`;
  const cB = `cB-${tag}`;
  const cAct = `cAct-${tag}`;

  async function lead(name: string): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name, lastName: "Doe", apolloPersonId: `ap-${name}-${tag}` }).returning({ id: leads.id });
    return row.id;
  }

  function fact(id: string, leadId: string, label: string, over: Record<string, unknown> = {}) {
    return {
      id: `${id}-${tag}`, org_id: orgId, brand_id: brandId, offer_id: offerA, lead_id: leadId, campaign_id: cA,
      occurred_at: "2026-10-01T10:00:00.000Z", label, source: "outreach", source_ref: id, attributable: true,
      attribution_basis: "reaction_to_our_email", url: null, detail: {}, withdrawn_at: null, ...over,
    } as never;
  }

  it("serves one journey per person x offer with its facts and acts", async () => {
    const p1 = await lead("p1");
    const p2 = await lead("p2");
    await upsertTimelineFacts([
      fact("s1", p1, "initial_email", { attribution_basis: "our_email", occurred_at: "2026-09-01T00:00:00.000Z" }),
      fact("s2", p1, "followup", { attribution_basis: "our_email", occurred_at: "2026-09-05T00:00:00.000Z" }),
      fact("v1", p1, "website_visit", { occurred_at: "2026-09-06T00:00:00.000Z" }),
      fact("paid", p1, "paid_client", { source: "manual", attribution_basis: "person", detail: { event: "sale", valueCents: 250000 }, occurred_at: "2026-09-20T00:00:00.000Z" }),
      fact("gone", p1, "meeting_booked", { withdrawn_at: "2026-09-21T00:00:00.000Z" }),
      fact("vid", p1, "industry_update_video", { campaign_id: "social-1", attribution_basis: null, occurred_at: "2026-09-02T00:00:00.000Z" }),
      // Same person on offer B: its own journey, only its own facts.
      fact("sB", p1, "initial_email", { offer_id: offerB, campaign_id: cB, attribution_basis: "our_email" }),
      fact("iB", p1, "interested", { offer_id: offerB, campaign_id: cB, source: "reply" }),
      // A fact stated on no offer stays apart.
      fact("brandwide", p2, "meeting_attended", { offer_id: null, campaign_id: null, source: "crm", attribution_basis: "rule" }),
      // Another brand never leaks.
      fact("other", p2, "paid_client", { brand_id: otherBrandId }),
    ]);
    const [heldRow] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug)
      VALUES (${p2}::uuid, ${cA}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest') RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    await sql`
      INSERT INTO followup_actions (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, action, occurred_at)
      VALUES (${orgId}, ARRAY[${brandId}]::text[], ${heldRow.id}::uuid, ${p2}::uuid, ${cA}, ${cAct}, 'acted', '2026-09-10T00:00:00Z'),
             (${orgId}, ARRAY[${brandId}]::text[], ${heldRow.id}::uuid, ${p2}::uuid, ${cA}, ${cAct}, 'claimed', '2026-09-09T00:00:00Z')
    `;

    const journeys = [];
    for await (const chunk of streamBrandJourneys(orgId, brandId, new Map([[cAct, offerA]]), 2)) journeys.push(...chunk);

    const j1a = journeys.find((j) => j.leadId === p1 && j.offerId === offerA)!;
    expect(j1a.facts.map((f) => f.label)).toEqual(["industry_update_video", "website_visit", "paid_client"]);
    expect(j1a.facts.find((f) => f.label === "paid_client")).toMatchObject({ valueCents: 250000, attributable: true, campaignId: cA, occurredAt: "2026-09-20T00:00:00.000Z" });
    expect(j1a.acts).toEqual([
      { campaignId: cA, kind: "email", firstAt: "2026-09-01T00:00:00.000Z", lastAt: "2026-09-05T00:00:00.000Z", count: 2 },
    ]);
    expect(j1a.firstActedAt).toBe("2026-09-01T00:00:00.000Z");
    // Emailed under a campaign the person holds no row of: nothing local names the sending workflow.
    expect(j1a.emailSends).toEqual([
      { campaignId: cA, workflowSlug: null, workflowSource: null, firstSentAt: "2026-09-01T00:00:00.000Z", lastSentAt: "2026-09-05T00:00:00.000Z", count: 2 },
    ]);

    const j1b = journeys.find((j) => j.leadId === p1 && j.offerId === offerB)!;
    expect(j1b.facts.map((f) => f.label)).toEqual(["interested"]);
    expect(j1b.acts.map((a) => a.campaignId)).toEqual([cB]);

    const p2Journeys = journeys.filter((j) => j.leadId === p2);
    expect(p2Journeys.map((j) => j.offerId)).toEqual([null, offerA]);
    expect(p2Journeys[0].facts.map((f) => f.label)).toEqual(["meeting_attended"]);
    expect(p2Journeys[0].acts).toEqual([]);
    expect(p2Journeys[1].facts).toEqual([]);
    expect(p2Journeys[1].acts).toEqual([
      { campaignId: cAct, kind: "followup", firstAt: "2026-09-10T00:00:00.000Z", lastAt: "2026-09-10T00:00:00.000Z", count: 1 },
    ]);
    expect(p2Journeys[1].emailSends).toEqual([]);
    expect(journeys).toHaveLength(4);
  });

  it("lists every campaign x workflow that emailed a person, crediting each send to the run holding the row then", async () => {
    // WORKFLOW-SEND-HISTORY-1016: emailed by workflow alpha under campaign cS1, replied, later served by another
    // workflow under cS2 whose row a retry claim then a named serve re-pointed before each send.
    const brand = randomUUID();
    const cS1 = `cS1-${tag}`;
    const cS2 = `cS2-${tag}`;
    const p = await lead("p3");
    const f = (id: string, label: string, campaign: string, at: string, basis = "our_email") =>
      fact(id, p, label, { brand_id: brand, campaign_id: campaign, occurred_at: at, attribution_basis: basis });
    await upsertTimelineFacts([
      f("w1", "initial_email", cS1, "2026-09-01T00:00:00.000Z"),
      f("w2", "followup", cS1, "2026-09-04T00:00:00.000Z"),
      f("w3", "bounced", cS1, "2026-09-05T00:00:00.000Z"),
      f("w4", "interested", cS1, "2026-09-06T00:00:00.000Z", "reaction_to_our_email"),
      f("w5", "initial_email", cS2, "2026-10-12T00:00:00.000Z"),
      f("w6", "followup", cS2, "2026-10-20T00:00:00.000Z"),
    ]);
    await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug, workflow_slug, served_at)
      VALUES (${p}::uuid, ${cS1}, ${orgId}, ARRAY[${brand}]::text[], 'served', 'itest', 'wf-alpha', '2026-08-30T00:00:00Z')
    `;
    const [row2] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug, workflow_slug, served_at)
      VALUES (${p}::uuid, ${cS2}, ${orgId}, ARRAY[${brand}]::text[], 'served', 'itest', 'wf-serving', '2026-10-10T00:00:00Z')
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    await sql`
      INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
      VALUES (${row2.id}::uuid, 'run-claim', 'wf-claimant', '2026-10-11T00:00:00Z', 'retry_claim'),
             (${row2.id}::uuid, 'run-named', 'wf-named', '2026-10-15T00:00:00Z', 'named_serve')
    `;

    const journeys = [];
    for await (const chunk of streamBrandJourneys(orgId, brand, new Map(), 50)) journeys.push(...chunk);
    expect(journeys).toHaveLength(1);
    expect(journeys[0].emailSends).toEqual([
      { campaignId: cS1, workflowSlug: "wf-alpha", workflowSource: "serve", firstSentAt: "2026-09-01T00:00:00.000Z", lastSentAt: "2026-09-04T00:00:00.000Z", count: 2 },
      { campaignId: cS2, workflowSlug: "wf-claimant", workflowSource: "retry_claim", firstSentAt: "2026-10-12T00:00:00.000Z", lastSentAt: "2026-10-12T00:00:00.000Z", count: 1 },
      { campaignId: cS2, workflowSlug: "wf-named", workflowSource: "named_serve", firstSentAt: "2026-10-20T00:00:00.000Z", lastSentAt: "2026-10-20T00:00:00.000Z", count: 1 },
    ]);
    // `acts` is unchanged: one entry per (campaign, kind), bounces included.
    expect(journeys[0].acts.map((a) => [a.campaignId, a.count])).toEqual([[cS1, 3], [cS2, 2]]);
  });
});
