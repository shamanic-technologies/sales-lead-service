/**
 * Tactic "Fresh contacts only" (FRESH-CONTACTS-1015) against a REAL database: the predicate reads the bronze copy of
 * instantly-service's outreach facts (`outreach_facts`), and every pool applies it through `reachClauses`. A mocked
 * `sql` compiles neither the array bind nor the interval, so the statements run here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { loadRetryCandidates } from "../../src/lib/retry-pool.js";
import { leadRecentlyEmailed } from "../../src/lib/recently-emailed.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("fresh contacts only: who the brand emailed inside the window", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const campaignId = `itest-fresh-${randomUUID()}`;
  const scope = { window: "3_months" as const, brandIds: [brandId] };
  const leadIds: Record<string, string> = {};
  const subjects: string[] = [];
  let seq = BigInt(Date.now()) * 1000n;

  async function seedLead(key: string, emails: string[]): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${key}` }).returning({ id: leads.id });
    for (const email of emails) {
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "apollo" });
    }
    await db.insert(leadsCampaigns).values({
      leadId: lead.id, campaignId, orgId, brandIds: [brandId], status: "served", servedAt: new Date(Date.now() - 60_000),
    });
    leadIds[key] = lead.id;
    return lead.id;
  }

  async function fact(p: { type: string; email: string; brandIds: string[]; daysAgo: number; subject?: string }): Promise<string> {
    const subject = p.subject ?? `itest:${randomUUID()}`;
    subjects.push(subject);
    seq += 1n;
    await db.execute(sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, campaign_id, brand_ids, raw)
      VALUES (${seq.toString()}::bigint, ${subject}, ${p.type}, now() - make_interval(days => ${p.daysAgo}), ${p.email.toLowerCase()},
              ${orgId}, 'c', ${sql.param(p.brandIds)}::text[], '{}'::jsonb)`);
    return subject;
  }

  beforeAll(async () => {
    const u = randomUUID().slice(0, 8);
    await seedLead("emailedLastWeek", [`Week-${u}@itest.example`]);
    await fact({ type: "email_sent", email: `week-${u}@itest.example`, brandIds: [brandId], daysAgo: 7 });

    await seedLead("emailedFourMonthsAgo", [`old-${u}@itest.example`]);
    await fact({ type: "email_sent", email: `old-${u}@itest.example`, brandIds: [brandId], daysAgo: 125 });

    await seedLead("emailedByAnotherBrand", [`other-${u}@itest.example`]);
    await fact({ type: "email_sent", email: `other-${u}@itest.example`, brandIds: [otherBrandId], daysAgo: 3 });

    await seedLead("sendWithdrawn", [`withdrawn-${u}@itest.example`]);
    const s = await fact({ type: "email_sent", email: `withdrawn-${u}@itest.example`, brandIds: [brandId], daysAgo: 5 });
    await fact({ type: "withdrawn", email: `withdrawn-${u}@itest.example`, brandIds: [brandId], daysAgo: 4, subject: s });

    await seedLead("onlyOpened", [`opened-${u}@itest.example`]);
    await fact({ type: "email_opened", email: `opened-${u}@itest.example`, brandIds: [brandId], daysAgo: 2 });

    // Two addresses: the brand emailed the SECOND one.
    await seedLead("secondAddressEmailed", [`first-${u}@itest.example`, `second-${u}@itest.example`]);
    await fact({ type: "email_sent", email: `second-${u}@itest.example`, brandIds: [otherBrandId, brandId], daysAgo: 30 });

    await seedLead("neverEmailed", [`never-${u}@itest.example`]);
  });

  afterAll(async () => {
    const ids = Object.values(leadIds);
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
    await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, ids));
    await db.delete(leads).where(inArray(leads.id, ids));
    await db.execute(sql`DELETE FROM outreach_facts WHERE subject_key = ANY(${sql.param(subjects)}::text[])`);
  });

  it("names exactly the people the brand emailed inside 3 months, on any registered address", async () => {
    const hits: Record<string, boolean> = {};
    for (const [key, id] of Object.entries(leadIds)) hits[key] = await leadRecentlyEmailed(id, scope);
    expect(hits).toEqual({
      emailedLastWeek: true,
      emailedFourMonthsAgo: false,
      emailedByAnotherBrand: false,
      sendWithdrawn: false,
      onlyOpened: false,
      secondAddressEmailed: true,
      neverEmailed: false,
    });
  });

  it("a pool asked with the window skips them without touching their rows; a pool not asked hands everyone out", async () => {
    const asked = await loadRetryCandidates({ orgId, campaignId, nowMs: Date.now(), limit: 50, recentlyEmailed: scope });
    expect(new Set(asked.map((c) => c.leadId))).toEqual(
      new Set([leadIds.emailedFourMonthsAgo, leadIds.emailedByAnotherBrand, leadIds.sendWithdrawn, leadIds.onlyOpened, leadIds.neverEmailed]),
    );

    // Regression: not asked = today's pool, byte-identical population.
    const notAsked = await loadRetryCandidates({ orgId, campaignId, nowMs: Date.now(), limit: 50 });
    expect(new Set(notAsked.map((c) => c.leadId))).toEqual(new Set(Object.values(leadIds)));

    // Skipped is not consumed: every row is still an unclaimed served row of the campaign.
    const rows = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
    expect(rows.every((r) => r.status === "served" && r.retryClaimedAt === null)).toBe(true);
  });
});
