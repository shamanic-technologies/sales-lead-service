/**
 * LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): the stock hand-off (src/lib/source-stock.ts) and the own-run tally
 * (src/lib/source-leads-found.ts) run against a REAL database: raw SQL that a mocked `db` cannot fail.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { claimStockedLead, type AskAudienceFit } from "../../src/lib/source-stock.js";

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

  async function seedFound(campaignId: string, servedAt: string, opts: { email?: boolean; reason?: string; verdict?: string } = {}): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    leadIds.push(lead.id);
    if (opts.email !== false) {
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: `${randomUUID()}@itest.example`, source: "apollo", ...(opts.verdict ? { verificationVerdict: opts.verdict } : {}) });
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

  const fitsAlways: AskAudienceFit = async () => ({ fits: true });
  const claimAll = (outreachCampaignId: string, sources = [source], askFit: AskAudienceFit = fitsAlways, acceptedEmails?: "as_found") =>
    claimStockedLead({
      ...(acceptedEmails ? { acceptedEmails } : {}),
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
      askFit,
    });
  const claim = async (outreachCampaignId: string, sources = [source]) => (await claimAll(outreachCampaignId, sources)).lead;

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

  it("as_found stock hands the person as the source found them, unknown verdict included (UNKNOWN-RESTORE-1016)", async () => {
    const s = `itest-src-${randomUUID()}`;
    const unknown = await seedFound(s, "2026-10-12T01:00:00Z", { verdict: "unknown" });
    const catchAll = await seedFound(s, "2026-10-12T02:00:00Z", { verdict: "catch_all" });
    const first = await claimAll(`itest-out-${randomUUID()}`, [s], fitsAlways, "as_found");
    const second = await claimAll(`itest-out-${randomUUID()}`, [s], fitsAlways, "as_found");
    expect([first.lead?.leadId, second.lead?.leadId].sort()).toEqual([unknown, catchAll].sort());
  });

  it("two outreach runs racing never take the same person", async () => {
    const s = `itest-src-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await seedFound(s, `2026-10-12T0${i}:00:00Z`);
    const got = await Promise.all([claim(`itest-out-${randomUUID()}`, [s]), claim(`itest-out-${randomUUID()}`, [s]), claim(`itest-out-${randomUUID()}`, [s]), claim(`itest-out-${randomUUID()}`, [s])]);
    const ids = got.filter(Boolean).map((g) => g!.leadId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("a found lead that no longer fits its audience is set aside with the owner's reason, never handed, and the next one is", async () => {
    const s = `itest-src-${randomUUID()}`;
    const out = `itest-out-${randomUUID()}`;
    const answered = await seedFound(s, "2026-10-12T01:00:00Z");
    const stillFits = await seedFound(s, "2026-10-12T02:00:00Z");
    const asked: Array<{ audienceId: string; email: string }> = [];
    const askFit: AskAudienceFit = async (q) => {
      asked.push(q);
      return asked.length === 1 ? { fits: false, reason: "Answered on WhatsApp since being found" } : { fits: true };
    };

    const got = await claimAll(out, [s], askFit);
    expect(got.lead?.leadId).toBe(stillFits);
    expect(got.setAside).toEqual([
      expect.objectContaining({ leadId: answered, sourceCampaignId: s, audienceId: "aud-1", reason: "Answered on WhatsApp since being found" }),
    ]);
    expect(asked.map((q) => q.audienceId)).toEqual(["aud-1", "aud-1"]);

    const rows = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, s));
    const aside = rows.find((r) => r.leadId === answered)!;
    expect(aside).toMatchObject({ status: "served", sourceHandedAt: null, sourceSetAsideReason: "Answered on WhatsApp since being found" });
    expect(aside.sourceSetAsideAt).not.toBeNull();
    // Only the lead that still fits was filed under the outreach campaign.
    const outRows = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, out));
    expect(outRows.map((r) => r.leadId)).toEqual([stillFits]);

    // Set aside for good: another outreach campaign is never handed it, nor asked about it.
    asked.length = 0;
    const again = await claimAll(`itest-out-${randomUUID()}`, [s], async (q) => {
      asked.push(q);
      return { fits: true };
    });
    expect(again).toEqual({ lead: null, setAside: [] });
    expect(asked).toHaveLength(0);
  });

  it("the owner unable to answer fails the claim: nothing handed, nothing set aside", async () => {
    const s = `itest-src-${randomUUID()}`;
    const lead = await seedFound(s, "2026-10-12T01:00:00Z");
    await expect(
      claimAll(`itest-out-${randomUUID()}`, [s], async () => {
        throw new Error("human-service down");
      }),
    ).rejects.toThrow("human-service down");
    const [row] = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.leadId, lead));
    expect(row).toMatchObject({ sourceHandedAt: null, sourceSetAsideAt: null });
    expect((await claimAll(`itest-out-${randomUUID()}`, [s])).lead?.leadId).toBe(lead);
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
