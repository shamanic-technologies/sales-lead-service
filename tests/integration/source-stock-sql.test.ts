/**
 * LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): the stock hand-off (src/lib/source-stock.ts) and the own-run tally
 * (src/lib/source-leads-found.ts) run against a REAL database: raw SQL that a mocked `db` cannot fail.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { claimStockedLead } from "../../src/lib/source-stock.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("source stock against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const source = `itest-src-${randomUUID()}`;
  const otherSource = `itest-src-${randomUUID()}`;
  const outreach = `itest-out-${randomUUID()}`;
  const outreach2 = `itest-out-${randomUUID()}`;
  const leadIds: string[] = [];

  async function seedFound(campaignId: string, servedAt: string, opts: { email?: boolean; reason?: string } = {}): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    leadIds.push(lead.id);
    if (opts.email !== false) {
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: `${randomUUID()}@itest.example`, source: "apollo" });
    }
    await db.insert(leadsCampaigns).values({
      leadId: lead.id,
      campaignId,
      orgId,
      brandIds: [brandId],
      status: "served",
      statusReason: opts.reason ?? "source_found",
      servedAt: new Date(servedAt),
      audienceId: "aud-1",
      buyingSignal: { type: "hiring", occurredOn: "2026-10-01", fact: "Acme hires", source: "apollo:job_postings", sourceUrl: null },
      featureSlug: "sourcing-apollo-cold-filters",
    });
    return lead.id;
  }

  const claim = (outreachCampaignId: string, sources = [source]) =>
    claimStockedLead({
      orgId,
      sourceCampaignIds: sources,
      outreachCampaignId,
      brandIds: [brandId],
      featureSlug: "sales-cold-email-outreach",
      runId: randomUUID(),
      parentRunId: randomUUID(),
      userId: null,
      workflowSlug: "cold-email-x",
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

  it("hands the OLDEST found lead to the outreach campaign once, files it there, and never hands it again", async () => {
    const older = await seedFound(source, "2026-10-12T08:00:00Z");
    const newer = await seedFound(source, "2026-10-12T09:00:00Z");
    await seedFound(source, "2026-10-12T07:00:00Z", { email: false }); // no email: never served (identity is email-first)
    await seedFound(otherSource, "2026-10-12T06:00:00Z"); // a source that does not feed this campaign
    await seedFound(source, "2026-10-12T05:00:00Z", { reason: "served" }); // a serve, not a find

    const first = await claim(outreach);
    expect(first).toMatchObject({ leadId: older, sourceCampaignId: source, audienceId: "aud-1", goal: "signup" });
    expect(first?.buyingSignal?.type).toBe("hiring");

    const [outRow] = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, outreach));
    expect(outRow).toMatchObject({ leadId: older, status: "served", statusReason: "served", featureSlug: "sales-cold-email-outreach", audienceId: "aud-1", brandIds: [brandId] });
    expect((outRow.buyingSignal as { type: string }).type).toBe("hiring");

    const second = await claim(outreach2);
    expect(second?.leadId).toBe(newer);
    expect(await claim(outreach)).toBeNull();

    const sourceRows = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, source));
    const handed = sourceRows.filter((r) => r.sourceHandedAt !== null);
    expect(handed.map((r) => r.sourceHandedToCampaignId).sort()).toEqual([outreach, outreach2].sort());
    // The source keeps its finds: still served, still the source's.
    expect(sourceRows.every((r) => r.status === "served")).toBe(true);
  });

  it("two outreach runs racing never take the same person", async () => {
    const s = `itest-src-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await seedFound(s, `2026-10-12T0${i}:00:00Z`);
    const got = await Promise.all([claim(`itest-out-${randomUUID()}`, [s]), claim(`itest-out-${randomUUID()}`, [s]), claim(`itest-out-${randomUUID()}`, [s]), claim(`itest-out-${randomUUID()}`, [s])]);
    const ids = got.filter(Boolean).map((g) => g!.leadId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("the own-run tally counts finds per source campaign", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ recordedSince: null, counts: [] }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    try {
      const { readSourceLeadsFound } = await import("../../src/lib/source-leads-found.js");
      const got = await readSourceLeadsFound();
      const row = got.counts.find((c) => c.campaignId === source);
      expect(row).toMatchObject({ campaignId: source, ownRuns: 3, onDemand: 0, found: 3, firstAt: "2026-10-12T07:00:00.000Z", lastAt: "2026-10-12T09:00:00.000Z" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
