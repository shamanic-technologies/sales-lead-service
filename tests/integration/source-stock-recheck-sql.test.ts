/**
 * LEAK-1012 part 2 (2026-10-13): a source's stock asked again whether each find is its own, and finds handed back to
 * the source they belong to (src/lib/source-stock-recheck.ts), against a REAL database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { adoptSetAsideFinds, recheckSourceStock } from "../../src/lib/source-stock-recheck.js";
import type { SourceAudienceJudge } from "../../src/lib/source-stock-belongs.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("source stock recheck against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const whatsappSource = `itest-src-${randomUUID()}`;
  const emailSource = `itest-src-${randomUUID()}`;
  const leadIds: string[] = [];

  async function seedFound(campaignId: string, audienceId: string, opts: { handed?: boolean } = {}): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    leadIds.push(lead.id);
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: `${randomUUID()}@itest.example`, source: "crm" });
    await db.insert(leadsCampaigns).values({
      leadId: lead.id,
      campaignId,
      orgId,
      brandIds: [brandId],
      status: "served",
      statusReason: "source_found",
      servedAt: new Date("2026-10-12T10:00:00Z"),
      audienceId,
      featureSlug: "sourcing-crm-contacts",
      ...(opts.handed ? { sourceHandedAt: new Date(), sourceHandedToCampaignId: "itest-outreach" } : {}),
    });
    return lead.id;
  }

  // WhatsApp's source targets aud-phone; the email source targets aud-email; aud-apollo is nobody's here.
  const owns: Record<string, string> = { [whatsappSource]: "aud-phone", [emailSource]: "aud-email" };
  const judge: SourceAudienceJudge = async (sourceCampaignId, audienceId) =>
    owns[sourceCampaignId] === audienceId ? { belongs: true } : { belongs: false, reason: `not ${sourceCampaignId}'s: ${audienceId}` };

  afterAll(async () => {
    if (leadIds.length) {
      await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.leadId, leadIds));
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
  });

  it("sets aside every unhanded find of an audience that is not the source's, and gives the right ones to their source", async () => {
    const own = await seedFound(whatsappSource, "aud-phone");
    const apollo = await seedFound(whatsappSource, "aud-apollo");
    const emailPeople = [await seedFound(whatsappSource, "aud-email"), await seedFound(whatsappSource, "aud-email")];
    const handedEmail = await seedFound(whatsappSource, "aud-email", { handed: true });

    const dry = await recheckSourceStock({ orgId, sourceCampaignId: whatsappSource, dryRun: true, judge });
    expect(dry.setAside.map((s) => [s.audienceId, s.rows])).toEqual([["aud-apollo", 1], ["aud-email", 2]]);
    expect(dry.after).toEqual(dry.before);

    const done = await recheckSourceStock({ orgId, sourceCampaignId: whatsappSource, dryRun: false, judge });
    expect(done.before).toEqual([
      { audienceId: "aud-apollo", inStock: 1 },
      { audienceId: "aud-email", inStock: 2 },
      { audienceId: "aud-phone", inStock: 1 },
    ]);
    expect(done.after).toEqual([{ audienceId: "aud-phone", inStock: 1 }]);
    const [apolloRow] = await db.select().from(leadsCampaigns).where(and(eq(leadsCampaigns.leadId, apollo), eq(leadsCampaigns.campaignId, whatsappSource)));
    expect(apolloRow.sourceSetAsideReason).toBe(`not ${whatsappSource}'s: aud-apollo`);
    const [ownRow] = await db.select().from(leadsCampaigns).where(and(eq(leadsCampaigns.leadId, own), eq(leadsCampaigns.campaignId, whatsappSource)));
    expect(ownRow.sourceSetAsideAt).toBeNull();
    const [handedRow] = await db.select().from(leadsCampaigns).where(and(eq(leadsCampaigns.leadId, handedEmail), eq(leadsCampaigns.campaignId, whatsappSource)));
    expect(handedRow.sourceSetAsideAt).toBeNull(); // already handed: history, never rewritten

    // Idempotent: nothing left to set aside.
    expect((await recheckSourceStock({ orgId, sourceCampaignId: whatsappSource, dryRun: false, judge })).setAside).toEqual([]);

    const adoption = await adoptSetAsideFinds({ orgId, sourceCampaignId: emailSource, fromSourceCampaignId: whatsappSource, dryRun: false, judge });
    expect(adoption.audiences).toEqual([
      { audienceId: "aud-apollo", candidates: 1, adopted: 0, refusedReason: `not ${emailSource}'s: aud-apollo` },
      { audienceId: "aud-email", candidates: 2, adopted: 2, refusedReason: null },
    ]);
    expect(adoption.after).toEqual([{ audienceId: "aud-email", inStock: 2 }]);
    const adopted = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, emailSource));
    expect(adopted.map((r) => r.leadId).sort()).toEqual([...emailPeople].sort());
    expect(adopted.every((r) => r.statusReason === "source_found" && r.sourceHandedAt === null && r.audienceId === "aud-email")).toBe(true);
    expect(adopted[0].statusDetails).toContain(`Re-filed from source campaign ${whatsappSource}`);

    // A second adoption files nobody twice.
    const again = await adoptSetAsideFinds({ orgId, sourceCampaignId: emailSource, fromSourceCampaignId: whatsappSource, dryRun: false, judge });
    expect(again.audiences.find((a) => a.audienceId === "aud-email")?.adopted).toBe(0);
  });
});
