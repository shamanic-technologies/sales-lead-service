/**
 * The timeline-journeys answer cache (`brand-journeys-cache.ts`) against a REAL database: a held answer is served
 * again only while no input of the read moved for its org (migration 0128's triggers), a write still OPEN when the
 * answer was read invalidates it once committed, and a busy table that cannot move the read (a lease on a
 * membership row) leaves it alone.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { db, sql } = await import("../../src/db/index.js");
const { leads } = await import("../../src/db/schema.js");
const { upsertTimelineFacts } = await import("../../src/lib/timeline-facts.js");
const cache = await import("../../src/lib/brand-journeys-cache.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("timeline-journeys answer cache against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const campaignId = `c-${tag}`;
  const key = cache.journeysCacheKey(orgId, brandId, new Map());

  beforeEach(() => cache.resetJourneysCache());

  async function lead(name: string): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name, lastName: "Doe", apolloPersonId: `ap-${name}-${randomUUID()}` }).returning({ id: leads.id });
    return row.id;
  }

  function fact(id: string, leadId: string, label: string, over: Record<string, unknown> = {}) {
    return {
      id: `${id}-${tag}`, org_id: orgId, brand_id: brandId, offer_id: null, lead_id: leadId, campaign_id: campaignId,
      occurred_at: "2026-10-01T10:00:00.000Z", label, source: "outreach", source_ref: id, attributable: true,
      attribution_basis: "our_email", url: null, detail: {}, withdrawn_at: null, ...over,
    } as never;
  }

  async function fill(): Promise<void> {
    const xmin = await cache.journeysSnapshotXmin();
    cache.rememberJourneys(key, orgId, xmin, "BODY");
  }

  it("the key ignores the order the offers came in", () => {
    expect(cache.journeysCacheKey("o", "b", new Map([["c2", "x"], ["c1", null]]))).toBe(
      cache.journeysCacheKey("o", "b", new Map([["c1", null], ["c2", "x"]])),
    );
  });

  it("serves the held answer while nothing moved, and forgets it once a timeline fact of the org is written", async () => {
    const p = await lead("p1");
    await upsertTimelineFacts([fact("s1", p, "initial_email")]);
    await fill();
    expect(await cache.cachedJourneys(key)).toBe("BODY");

    // Another org's write does not touch this org's answer.
    await sql`INSERT INTO journey_input_changes (org_id) VALUES (${otherOrgId})`;
    expect(await cache.cachedJourneys(key)).toBe("BODY");

    await upsertTimelineFacts([fact("v1", p, "website_visit", { attribution_basis: "reaction_to_our_email" })]);
    expect(await cache.cachedJourneys(key)).toBeNull();
    // Forgotten, not re-validated.
    expect(await cache.cachedJourneys(key)).toBeNull();
  });

  it("every input table of the read invalidates it", async () => {
    const p = await lead("p2");
    await upsertTimelineFacts([fact("s2", p, "initial_email")]);
    const [row] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug, workflow_slug)
      VALUES (${p}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest', 'wf-a') RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;

    const writes: Array<[string, () => Promise<unknown>]> = [
      ["outreach fact", () => sql`
        INSERT INTO outreach_facts (seq, subject_key, type, lead_email, org_id, campaign_id, brand_ids, raw)
        VALUES (${Math.floor(Math.random() * 1e12)}, ${`s2-${tag}`}, 'email_sent', 'p2@example.com', ${orgId}, ${campaignId},
                ARRAY[${brandId}]::text[], '{"transport":"smtp"}'::jsonb)`],
      ["follow-up act", () => sql`
        INSERT INTO followup_actions (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, action, occurred_at)
        VALUES (${orgId}, ARRAY[${brandId}]::text[], ${row.id}::uuid, ${p}::uuid, ${campaignId}, 'act', 'acted', now())`],
      ["re-point before a send", () => sql`
        INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
        VALUES (${row.id}::uuid, ${randomUUID()}, 'wf-b', '2026-09-01T00:00:00Z', 'retry_claim')`],
      ["membership workflow", () => sql`UPDATE leads_campaigns SET workflow_slug = 'wf-c' WHERE id = ${row.id}::uuid`],
      ["membership removed", () => sql`DELETE FROM leads_campaigns WHERE id = ${row.id}::uuid`],
      ["withdrawn fact", () => sql`UPDATE lead_timeline_facts SET withdrawn_at = now() WHERE id = ${`s2-${tag}`}`],
    ];
    for (const [what, write] of writes) {
      await fill();
      expect(await cache.cachedJourneys(key), `${what}: held before`).toBe("BODY");
      await write();
      expect(await cache.cachedJourneys(key), `${what}: forgotten after`).toBeNull();
    }
  });

  it("a membership write or re-point that cannot move the read leaves the answer held", async () => {
    const p = await lead("p3");
    await upsertTimelineFacts([fact("s3", p, "initial_email")]);
    const [row] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug)
      VALUES (${p}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest') RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    await fill();
    await sql`UPDATE leads_campaigns SET retry_claimed_at = now(), sent_at = now() WHERE id = ${row.id}::uuid`;
    // A re-point after every send of the row: no send is credited to it.
    await sql`
      INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
      VALUES (${row.id}::uuid, ${randomUUID()}, 'wf-later', now(), 'retry_claim')
    `;
    // A new membership of a person with no send under that campaign.
    const q = await lead("q3");
    await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug)
      VALUES (${q}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest')
    `;
    expect(await cache.cachedJourneys(key)).toBe("BODY");
  });

  it("a write still open when the answer was read invalidates it once it commits", async () => {
    const p = await lead("p4");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const open = sql.begin(async (tx) => {
      await (tx as unknown as typeof sql)`
        INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, campaign_id, label, source, source_ref, attribution_basis, detail)
        VALUES (${`late-${tag}`}, ${orgId}, ${brandId}, ${p}::uuid, ${campaignId}, 'initial_email', 'outreach', 'late', 'our_email', '{}'::jsonb)
      `;
      started();
      await gate;
    });
    await begun;
    await fill(); // read while the writer is still open: its fact is not in the answer
    expect(await cache.cachedJourneys(key)).toBe("BODY");
    release();
    await open;
    expect(await cache.cachedJourneys(key)).toBeNull();
  });

  it("an answer past its age is recomputed", async () => {
    const xmin = await cache.journeysSnapshotXmin();
    cache.rememberJourneys(key, orgId, xmin, "BODY", 0);
    expect(await cache.cachedJourneys(key, cache.JOURNEYS_CACHE_MAX_AGE_MS + 1)).toBeNull();
  });
});
