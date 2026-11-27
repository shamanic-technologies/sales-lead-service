/**
 * GMAPS-SET-ASIDE-1127-REOPEN (2026-11-27): a find set aside at handover because its audience COULD NOT judge it is
 * judged again (src/lib/source-stock-rejudge.ts) and, fitting now, goes back into the source's stock and is handed on;
 * a find set aside for a real "no longer fits" is never touched. Against a REAL database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { claimStockedLead, type AskAudienceFit } from "../../src/lib/source-stock.js";
import { rejudgeCannotJudgeFinds, type AskStillFits } from "../../src/lib/source-stock-rejudge.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

const NEVER_FOUND = "This audience never found this business, so it cannot say whether it still fits";

describe.skipIf(!hasRealDatabase)("source stock re-judge against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const source = `itest-src-${randomUUID()}`;
  const outreach = `itest-out-${randomUUID()}`;
  const leadIds: string[] = [];
  const emailOf = new Map<string, string>();

  async function seedFound(servedAt: string): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    leadIds.push(lead.id);
    const email = `${randomUUID()}@itest.example`;
    emailOf.set(lead.id, email);
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "google_maps" });
    await db.insert(leadsCampaigns).values({
      leadId: lead.id,
      campaignId: source,
      orgId,
      brandIds: [brandId],
      status: "served",
      statusReason: "source_found",
      servedAt: new Date(servedAt),
      audienceId: "aud-gmaps",
      featureSlug: "sourcing-google-maps",
    });
    return lead.id;
  }

  const claim = (askFit: AskAudienceFit) =>
    claimStockedLead({
      orgId,
      sourceCampaignIds: [source],
      outreachCampaignId: outreach,
      brandIds: [brandId],
      featureSlug: "sales-cold-email-outreach",
      runId: randomUUID(),
      parentRunId: randomUUID(),
      userId: null,
      workflowSlug: "cold-email-x",
      goal: "signup",
      activeGoalId: null,
      brandProfileId: null,
      acceptedEmails: "as_found",
      askFit,
    });

  async function rowOf(leadId: string) {
    const [row] = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.leadId, leadId));
    return row;
  }

  afterAll(async () => {
    if (leadIds.length) {
      await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.leadId, leadIds));
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
  });

  it("re-opens a cannot-judge set-aside that fits now, keeps a real no-fit set aside, and hands the re-opened find on", async () => {
    const pharmacy = await seedFound("2026-11-20T08:00:00Z");
    const released = await seedFound("2026-11-20T09:00:00Z");
    const alreadyOut = await seedFound("2026-11-20T10:00:00Z");

    // Handover, before human-service could judge Google Maps finds: two cannot-judge 422s, one real "no longer fits".
    const before = await claim(async ({ email }) =>
      email === emailOf.get(alreadyOut)
        ? { fits: false, reason: "Is our own staff" }
        : { fits: false, reason: NEVER_FOUND, cannotJudge: "not_found_by_audience" },
    );
    expect(before.lead).toBeNull();
    expect(before.setAside).toHaveLength(3);
    expect((await rowOf(pharmacy)).sourceSetAsideCannotJudge).toBe("not_found_by_audience");
    expect((await rowOf(alreadyOut)).sourceSetAsideCannotJudge).toBeNull();

    // human-service now judges them: the pharmacy fits, the other business was released (a real no-fit).
    const asked: string[] = [];
    const ask: AskStillFits = async (q) => {
      asked.push(q.email as string);
      expect(q).toMatchObject({ orgId, brandId, audienceId: "aud-gmaps" });
      return q.email === emailOf.get(pharmacy) ? { fits: true } : { fits: false, reason: "Released by the brand" };
    };

    const dry = await rejudgeCannotJudgeFinds({ dryRun: true, orgId, sourceCampaignId: source, ask });
    expect(dry).toMatchObject({ asked: 2, reopened: 1, noLongerFits: [{ reason: "Released by the brand", rows: 1 }], stillCannotJudge: [] });
    expect((await rowOf(pharmacy)).sourceSetAsideAt).not.toBeNull(); // dry run wrote nothing

    const real = await rejudgeCannotJudgeFinds({ dryRun: false, orgId, sourceCampaignId: source, ask });
    expect(real).toMatchObject({ asked: 2, reopened: 1 });
    expect(asked).not.toContain(emailOf.get(alreadyOut)); // a real no-fit is never asked again

    const reopened = await rowOf(pharmacy);
    expect(reopened.sourceSetAsideAt).toBeNull();
    expect(reopened.sourceSetAsideReason).toBeNull();
    expect(reopened.sourceSetAsideCannotJudge).toBeNull();
    const stillOut = await rowOf(released);
    expect(stillOut.sourceSetAsideAt).not.toBeNull();
    expect(stillOut.sourceSetAsideReason).toBe("Released by the brand");
    expect(stillOut.sourceSetAsideCannotJudge).toBeNull(); // a real verdict now: never re-opened
    const untouched = await rowOf(alreadyOut);
    expect(untouched.sourceSetAsideReason).toBe("Is our own staff");
    expect(untouched.sourceSetAsideRejudgedAt).toBeNull();

    // Idempotent: nothing left to re-judge.
    expect(await rejudgeCannotJudgeFinds({ dryRun: false, orgId, sourceCampaignId: source, ask })).toMatchObject({ asked: 0, reopened: 0 });

    // The re-opened find is handed on as any find.
    const after = await claim(async () => ({ fits: true }));
    expect(after.lead?.leadId).toBe(pharmacy);
    const filed = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, outreach));
    expect(filed.map((r) => r.leadId)).toEqual([pharmacy]);
  });

  it("a find still not judgeable stays set aside with the new code, and the sweep skips it until it is due again", async () => {
    const lead = await seedFound("2026-11-21T08:00:00Z");
    await claim(async () => ({ fits: false, reason: NEVER_FOUND, cannotJudge: "not_found_by_audience" }));

    const stillNot: AskStillFits = async () => ({ fits: false, reason: "No person of this org holds this address", cannotJudge: "person_unknown" });
    const first = await rejudgeCannotJudgeFinds({ dryRun: false, orgId, sourceCampaignId: source, ask: stillNot });
    expect(first.stillCannotJudge).toEqual([{ code: "person_unknown", rows: 1 }]);
    const row = await rowOf(lead);
    expect(row.sourceSetAsideAt).not.toBeNull();
    expect(row.sourceSetAsideCannotJudge).toBe("person_unknown");
    expect(row.sourceSetAsideRejudgedAt).not.toBeNull();

    // The sweep's daily gate: asked a moment ago = not asked again.
    const swept = await rejudgeCannotJudgeFinds({ dryRun: false, orgId, askedBeforeMs: 60_000, ask: stillNot });
    expect(swept.asked).toBe(0);
  });

  it("human-service unreachable stops the pass and leaves the row as it was", async () => {
    const lead = await seedFound("2026-11-22T08:00:00Z");
    await claim(async () => ({ fits: false, reason: NEVER_FOUND, cannotJudge: "not_found_by_audience" }));
    await expect(
      rejudgeCannotJudgeFinds({ dryRun: false, orgId, sourceCampaignId: source, ask: async () => { throw new Error("human-service down"); } }),
    ).rejects.toThrow(/down/);
    const row = await rowOf(lead);
    expect(row.sourceSetAsideCannotJudge).toBe("not_found_by_audience");
  });
});
