/**
 * The timeline-journeys answer cache (`brand-journeys-cache.ts`) against a REAL database, through the route: a held
 * answer is served again while nothing moved; once an input of the read moves, ONLY the leads it names are re-read
 * (migration 0144's triggers) and the body served is byte for byte the whole read's; a write still OPEN when the answer
 * was read is caught once committed; a busy table that cannot move the read (a lease on a membership row) leaves it
 * alone; an org-wide note means a whole re-read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";

let offers = new Map<string, string | null>();
/** Which leads each journey read asked for ("*" = the whole brand). */
const rec = vi.hoisted(() => ({ seen: [] as string[][] }));
vi.mock("../../src/lib/campaign-leg-client.js", () => ({ fetchOrgCampaignOffers: async () => offers }));
vi.mock("../../src/lib/brand-journeys.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/brand-journeys.js")>();
  return {
    ...real,
    streamBrandJourneys: (o: string, b: string, of: ReadonlyMap<string, string | null>, size: number, ids?: readonly string[]) => {
      rec.seen.push(ids === undefined ? ["*"] : [...ids].sort());
      return real.streamBrandJourneys(o, b, of, size, ids);
    },
  };
});
vi.mock("../../src/lib/outreach-fact-feed.js", () => ({ loadOutreachFeedState: async () => ({ cursor: "1", caughtUp: true }) }));

const { db, sql } = await import("../../src/db/index.js");
const { leads } = await import("../../src/db/schema.js");
const { upsertTimelineFacts } = await import("../../src/lib/timeline-facts.js");
const cache = await import("../../src/lib/brand-journeys-cache.js");
const journeys = await import("../../src/lib/brand-journeys.js");
const routes = (await import("../../src/routes/brand-journeys.js")).default;
const { settleOpenTransactions } = await import("../helpers/settle-transactions.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("timeline-journeys answer cache against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const offerA = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const campaignId = `c-${tag}`;
  const actCampaign = `act-${tag}`;
  const app = express();
  app.use(routes);

  beforeEach(() => {
    cache.resetJourneysCache();
    offers = new Map([[actCampaign, offerA]]);
  });

  async function lead(name: string): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name, lastName: "Doe", apolloPersonId: `ap-${name}-${randomUUID()}` }).returning({ id: leads.id });
    return row.id;
  }

  function fact(id: string, leadId: string, label: string, over: Record<string, unknown> = {}) {
    return {
      id: `${id}-${tag}`, org_id: orgId, brand_id: brandId, offer_id: offerA, lead_id: leadId, campaign_id: campaignId,
      occurred_at: "2026-10-01T10:00:00.000Z", label, source: "outreach", source_ref: id, attributable: true,
      attribution_basis: "our_email", url: null, detail: {}, withdrawn_at: null, ...over,
    } as never;
  }

  /**
   * A read of the route. By default every transaction open before it has ended first (another file's included), so the
   * answer it holds remembers an xmin above every write this test made: "nothing moved since" is then a fact, not a race.
   * `settle: false` = read while a write of OURS is still open (the test of that case).
   */
  const get = async ({ settle = true }: { settle?: boolean } = {}) => {
    if (settle) await settleOpenTransactions(db);
    const res = await request(app).get(`/internal/brands/${brandId}/timeline-journeys`).set("x-api-key", "test-api-key").set("x-org-id", orgId).buffer(true).parse((r, cb) => {
      let data = "";
      r.on("data", (c: Buffer) => (data += c.toString()));
      r.on("end", () => cb(null, data));
    });
    expect(res.status).toBe(200);
    return res.body as string;
  };

  /** The whole read, as the route writes it with nothing held. */
  async function wholeBody(): Promise<string> {
    const all = [];
    const n = rec.seen.length;
    for await (const chunk of journeys.streamBrandJourneys(orgId, brandId, offers, 3)) all.push(...chunk);
    rec.seen.length = n;
    return `{"brandId":${JSON.stringify(brandId)},"journeys":[${all.map((j) => JSON.stringify(j)).join(",")}],"count":${all.length},"factCount":${all.reduce((n, j) => n + j.facts.length, 0)}}`;
  }

  /** Record the journey reads from now on. */
  function rereads() {
    rec.seen.length = 0;
    return { seen: rec.seen, restore: () => {} };
  }

  it("the key ignores the order the offers came in", () => {
    expect(cache.journeysCacheKey("o", "b", new Map([["c2", "x"], ["c1", null]]))).toBe(
      cache.journeysCacheKey("o", "b", new Map([["c1", null], ["c2", "x"]])),
    );
  });

  it("re-reads only the leads an input write names, and serves the whole read's exact bytes", async () => {
    const p = await lead("p1");
    const q = await lead("q1");
    await upsertTimelineFacts([
      fact("s1", p, "initial_email"),
      fact("v1", p, "website_visit", { attribution_basis: "reaction_to_our_email", occurred_at: "2026-10-02T10:00:00.000Z" }),
      fact("s1q", q, "initial_email"),
    ]);
    const [row] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug, workflow_slug)
      VALUES (${p}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest', 'wf-a') RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;

    const first = await get();
    expect(first).toBe(await wholeBody());

    const r = rereads();
    try {
      // Nothing moved: served as held, nothing read.
      expect(await get()).toBe(first);
      expect(r.seen).toEqual([]);
      // Another org's write does not touch this org's answer.
      await sql`INSERT INTO journey_input_changes (org_id, lead_id) VALUES (${otherOrgId}, ${p}::uuid)`;
      expect(await get()).toBe(first);
      expect(r.seen).toEqual([]);

      const writes: Array<[string, string, () => Promise<unknown>]> = [
        ["timeline fact", q, () => upsertTimelineFacts([fact("m1q", q, "meeting_booked", { attribution_basis: "rule", source: "crm" })])],
        ["outreach fact (by its subject)", p, () => sql`
          INSERT INTO outreach_facts (seq, subject_key, type, lead_email, org_id, campaign_id, brand_ids, raw)
          VALUES (${Math.floor(Math.random() * 1e12)}, ${`s1-${tag}`}, 'email_sent', 'p1@example.com', ${orgId}, ${campaignId},
                  ARRAY[${brandId}]::text[], '{"transport":"smtp"}'::jsonb)`],
        ["follow-up act", p, () => sql`
          INSERT INTO followup_actions (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, action, occurred_at)
          VALUES (${orgId}, ARRAY[${brandId}]::text[], ${row.id}::uuid, ${p}::uuid, ${campaignId}, ${actCampaign}, 'acted', '2026-10-03T00:00:00Z')`],
        ["re-point before a send", p, () => sql`
          INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
          VALUES (${row.id}::uuid, ${randomUUID()}, 'wf-b', '2026-09-01T00:00:00Z', 'retry_claim')`],
        ["membership workflow", p, () => sql`UPDATE leads_campaigns SET workflow_slug = 'wf-c' WHERE id = ${row.id}::uuid`],
        ["membership removed", p, () => sql`DELETE FROM leads_campaigns WHERE id = ${row.id}::uuid`],
        ["withdrawn fact (a lead leaves the answer)", q, () => sql`UPDATE lead_timeline_facts SET withdrawn_at = now() WHERE lead_id = ${q}::uuid`],
      ];
      for (const [what, leadId, write] of writes) {
        r.seen.length = 0;
        await write();
        const body = await get();
        expect(r.seen, `${what}: re-read only that lead`).toEqual([[leadId]]);
        expect(body, `${what}: same bytes as the whole read`).toBe(await wholeBody());
      }
      // A lead appearing for the first time takes its place in the order.
      const n = await lead("n1");
      r.seen.length = 0;
      await upsertTimelineFacts([fact("s1n", n, "initial_email")]);
      const body = await get();
      expect(r.seen).toEqual([[n]]);
      expect(body).toBe(await wholeBody());
    } finally {
      r.restore();
    }
  });

  it("a membership write or re-point that cannot move the read leaves the answer held", async () => {
    const p = await lead("p3");
    await upsertTimelineFacts([fact("s3", p, "initial_email")]);
    const [row] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug)
      VALUES (${p}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest') RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    await get();
    const r = rereads();
    try {
      await sql`UPDATE leads_campaigns SET retry_claimed_at = now(), sent_at = now() WHERE id = ${row.id}::uuid`;
      await sql`
        INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
        VALUES (${row.id}::uuid, ${randomUUID()}, 'wf-later', now(), 'retry_claim')
      `;
      const q = await lead("q3");
      await sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, feature_slug)
        VALUES (${q}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'itest')
      `;
      await get();
      expect(r.seen).toEqual([]);
    } finally {
      r.restore();
    }
  });

  it("a write still open when the answer was read is re-read once it commits", async () => {
    const p = await lead("p4");
    await get();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let started!: () => void;
    const begun = new Promise<void>((res) => { started = res; });
    const open = sql.begin(async (tx) => {
      await (tx as unknown as typeof sql)`
        INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, campaign_id, label, source, source_ref, attribution_basis, detail)
        VALUES (${`late-${tag}`}, ${orgId}, ${brandId}, ${p}::uuid, ${campaignId}, 'initial_email', 'outreach', 'late', 'our_email', '{}'::jsonb)
      `;
      started();
      await gate;
    });
    await begun;
    const before = await get({ settle: false }); // read while the writer is still open: its fact is not in the answer
    expect(before).not.toContain(p);
    release();
    await open;
    const after = await get();
    expect(after).toContain(p);
    expect(after).toBe(await wholeBody());
  });

  it("identical reads at once re-read the moved lead once and all serve the same (gzipped) bytes", async () => {
    const p = await lead("p5");
    await upsertTimelineFacts([fact("s5", p, "initial_email")]);
    await get();
    const r = rereads();
    await upsertTimelineFacts([fact("v5", p, "website_visit", { attribution_basis: "reaction_to_our_email" })]);
    const bodies = await Promise.all(Array.from({ length: 6 }, () => get()));
    expect(r.seen).toEqual([[p]]);
    const want = await wholeBody();
    for (const b of bodies) expect(b).toBe(want);
    const gz = await request(app).get(`/internal/brands/${brandId}/timeline-journeys`).set("x-api-key", "test-api-key").set("x-org-id", orgId).set("accept-encoding", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(JSON.stringify(gz.body)).toBe(JSON.stringify(JSON.parse(want)));
  });

  it("an org-wide note re-reads the whole answer; an answer past its age too", async () => {
    await get();
    const r = rereads();
    try {
      await sql`INSERT INTO journey_input_changes (org_id) VALUES (${orgId})`;
      await get();
      expect(r.seen).toEqual([["*"]]);
    } finally {
      r.restore();
    }
    expect(await cache.cachedJourneys("never-held", async () => new Map())).toBeNull();
  });
});
