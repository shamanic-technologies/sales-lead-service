/**
 * LEAD-REACHED-STEP-1106 against a REAL database: the Unibox list filtered on a step REACHED at some point keeps a
 * person who visited the site then booked a meeting (their rung is Meeting booked, they still reached Website visit),
 * counts them in `total` and on the lifecycle counts, narrows inside an offer/campaign scope, and pages.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const catalogue = {
  object: "step",
  lifecycleLadder: [
    { key: "lead_found", rank: 1, label: "Lead found" },
    { key: "engaged", rank: 3, label: "Engaged" },
    { key: "meeting_booked", rank: 5, label: "Meeting booked" },
  ],
  rows: [
    { key: "lead_found", lifecycleRank: 1 },
    { key: "website_visit", lifecycleRank: 3 },
    { key: "meeting_booked", lifecycleRank: 5 },
  ],
};
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const u = String(url);
    if (u.endsWith("/public/catalogue/steps")) return json(catalogue);
    if (u.includes("/sales-funnel-campaigns?")) return json({ salesFunnelCampaigns: [] });
    if (u.includes("/campaigns?")) return json({ campaigns: [] });
    throw new Error(`unexpected fetch ${u}`);
  },
}));

const { db } = await import("../../src/db/index.js");
const { readUniboxPage, readUniboxLifecycleCounts, resetLifecycleCatalogueCache } = await import("../../src/lib/unibox-model.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("unibox list: people who reached a step", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const campaignId = `camp-${randomUUID()}`;
  const visitedThenBooked = randomUUID();
  const visitedOnly = randomUUID();
  const bookedNoVisit = randomUUID();
  const foundOnly = randomUUID();
  const visitedOtherCampaign = randomUUID();
  const leadOf = new Map<string, string>();

  const steps = (...s: string[]) => JSON.stringify(s.map((step, i) => ({ step, at: `2026-11-0${i + 1}T10:00:00.000Z` })));

  beforeAll(async () => {
    resetLifecycleCatalogueCache();
    const rows: Array<[string, string | null, number | null, string, string]> = [
      [visitedThenBooked, "meeting_booked", 5, steps("lead_found", "website_visit", "meeting_booked"), "2026-11-06T10:00:00.000Z"],
      [visitedOnly, "engaged", 3, steps("lead_found", "website_visit"), "2026-11-05T10:00:00.000Z"],
      [bookedNoVisit, "meeting_booked", 5, steps("lead_found", "meeting_booked"), "2026-11-04T10:00:00.000Z"],
      [foundOnly, "lead_found", 1, steps("lead_found"), "2026-11-03T10:00:00.000Z"],
      [visitedOtherCampaign, "engaged", 3, steps("website_visit"), "2026-11-02T10:00:00.000Z"],
    ];
    for (const [human, key, rank, s, at] of rows) {
      const [lead] = (await db.execute(sql`INSERT INTO leads (human_id) VALUES (${human}::uuid) RETURNING id::text`)) as unknown as Array<{ id: string }>;
      leadOf.set(human, lead.id);
      await db.execute(sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
        VALUES (${lead.id}::uuid, ${human === visitedOtherCampaign ? `other-${campaignId}` : campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', now())
      `);
      await db.execute(sql`
        INSERT INTO unibox_rows (org_id, brand_id, human_id, company_key, lead_ids, lifecycle_key, lifecycle_rank, steps,
          interest, conversation, contactability, fit, last_activity_at)
        VALUES (${orgId}, ${brandId}, ${human}::uuid, '', ARRAY[${lead.id}]::uuid[], ${key}, ${rank}, ${s}::jsonb,
          'not_asked', 'no_reply_yet', 'contactable', 'fit', ${at}::timestamptz)
      `);
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM unibox_rows WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param([...leadOf.values()])}::uuid[])`);
  });

  it("keeps everyone who reached the step, including who went further, and counts them", async () => {
    const page = await readUniboxPage(scope, { reachedSteps: ["website_visit"] }, { limit: 50, cursor: null });
    expect(page.rows.map((r) => r.humanId)).toEqual([visitedThenBooked, visitedOnly, visitedOtherCampaign]);
    expect(page.total).toBe(3);
    // The person who went further stands on their own rung, served with the lead vocabulary.
    const further = page.rows[0];
    expect(further.lifecycle?.key).toBe("meeting_booked");
    expect(further.leadState.lifecycle?.key).toBe("meeting_booked");
    const counts = await readUniboxLifecycleCounts(scope, { reachedSteps: ["website_visit"] });
    expect(counts.total).toBe(3);
    expect(counts.byLifecycle).toMatchObject({ meeting_booked: 1, engaged: 2, lead_found: 0 });
  });

  it("several steps = any of", async () => {
    const page = await readUniboxPage(scope, { reachedSteps: ["website_visit", "meeting_booked"] }, { limit: 50, cursor: null });
    expect(page.total).toBe(4);
    expect(page.rows.map((r) => r.humanId)).not.toContain(foundOnly);
  });

  it("narrows inside a campaign scope and stacks with the other filters", async () => {
    const scoped = await readUniboxPage(scope, { reachedSteps: ["website_visit"], campaignIds: [campaignId] }, { limit: 50, cursor: null });
    expect(scoped.rows.map((r) => r.humanId)).toEqual([visitedThenBooked, visitedOnly]);
    expect(scoped.total).toBe(2);
    const counts = await readUniboxLifecycleCounts(scope, { reachedSteps: ["website_visit"], campaignIds: [campaignId] });
    expect(counts.total).toBe(2);
    const stacked = await readUniboxPage(scope, { reachedSteps: ["website_visit"], lifecycle: ["meeting_booked"] }, { limit: 50, cursor: null });
    expect(stacked.rows.map((r) => r.humanId)).toEqual([visitedThenBooked]);
  });

  it("pages the filtered set with its cursor, in every order", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p = await readUniboxPage(scope, { reachedSteps: ["website_visit"] }, { limit: 1, cursor });
      expect(p.total).toBe(3);
      seen.push(...p.rows.map((r) => r.humanId));
      cursor = p.nextCursor;
    } while (cursor);
    expect(seen).toEqual([visitedThenBooked, visitedOnly, visitedOtherCampaign]);
    const sorted = await readUniboxPage(scope, { reachedSteps: ["website_visit"] }, { limit: 50, cursor: null, sort: "stage_asc" });
    expect(sorted.rows.map((r) => r.humanId)).toEqual([visitedOnly, visitedOtherCampaign, visitedThenBooked]);
  });
});
