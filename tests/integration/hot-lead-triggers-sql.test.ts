/**
 * HOT-LEAD-PROPOSAL-1019 against a REAL database: a relation that NEWLY becomes a hot lead (lead yes AND wants
 * business yes) rings campaign-service's trigger door ONCE (src/lib/hot-lead-triggers.ts). The siblings (answers,
 * members, offers, catalogue, door) are faked through the pass's deps; the door's bodies are recorded.
 *
 *   transition to hot fires exactly once; staying hot fires nothing; hot -> not -> hot fires twice (a new episode);
 *   the brand's own team and staff fire nothing; a brand's first pass fires nothing (no back-fill);
 *   every active offer's campaigns run (one event per offer); a trigger the catalogue does not serve yet is kept.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { detectHotLeads } = await import("../../src/lib/hot-lead-triggers.js");
type Deps = import("../../src/lib/hot-lead-triggers.js").HotLeadDeps;
type Answers = import("../../src/lib/hot-lead-triggers.js").HotAnswers;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

const HOT: Answers = {
  lead: { state: "yes", basis: "evidence" },
  wantsBusiness: { state: "yes", basis: "judgment", confidence: 0.8, at: "2026-10-19T08:00:00.000Z" },
  lastInboundAt: "2026-10-19T07:59:00.000Z",
};
const COLD: Answers = { ...HOT, wantsBusiness: { state: "no", basis: "judgment", confidence: 0.1, at: "2026-10-19T08:00:00.000Z" } };

describe.skipIf(!hasRealDatabase)("hot lead trigger (real Postgres)", () => {
  const orgs: string[] = [];
  let org: string;
  let brand: string;
  let offerA: string;
  let offers: string[];
  let hot: Map<string, boolean>;
  let posts: Array<{ orgId: string; body: Record<string, unknown> }>;
  let served: boolean;
  const members = new Set(["teammate@acme.io"]);

  const deps = (): Deps => ({
    async answers(_scope, keys) {
      return new Map(keys.map((k) => [`${k.humanId}|${k.companyKey}`, hot.get(k.humanId) ? HOT : COLD]));
    },
    async members() {
      return members;
    },
    async activeOffers() {
      return offers;
    },
    async leadOf() {
      return null;
    },
    async catalogueServesTrigger() {
      return served;
    },
    async post(orgId, body) {
      posts.push({ orgId, body });
      return { status: 201, text: JSON.stringify({ event: { id: `evt-${posts.length}` } }) };
    },
  });

  async function subject(email: string, name = "Prospect"): Promise<string> {
    const human = randomUUID();
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name, emails, phones, relation_keys, wrote_to_us)
      VALUES (${org}, ${brand}, ${human}::uuid, '', ${name}, ARRAY[${email}]::text[], '{}'::text[], ARRAY[${`rel-${human}`}]::text[], true)`);
    return human;
  }
  const pass = () => detectHotLeads({ orgId: org, brandId: brand }, deps());

  beforeEach(async () => {
    org = randomUUID();
    orgs.push(org);
    brand = randomUUID();
    offerA = randomUUID();
    offers = [offerA];
    hot = new Map();
    posts = [];
    served = true;
  });

  afterAll(async () => {
    for (const t of ["relationship_subjects", "hot_lead_brands", "hot_lead_states", "hot_lead_fires"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ANY(${sql.param(orgs)}::text[])`);
    }
  });

  it("first pass is history; a transition fires exactly once; staying hot fires nothing", async () => {
    const already = await subject("already@client.io");
    hot.set(already, true);
    expect((await pass()).armed).toBe(true);
    expect(posts).toHaveLength(0);

    const newcomer = await subject("newcomer@client.io", "Marie Curie");
    hot.set(newcomer, true);
    await pass();
    expect(posts).toHaveLength(1);
    const body = posts[0].body;
    expect(body).toMatchObject({
      triggerId: "hot_lead",
      brandId: brand,
      offerId: offerA,
      person: { email: "newcomer@client.io", name: "Marie Curie" },
      item: { kind: "hot_lead", humanId: newcomer, relationKey: `rel-${newcomer}`, episode: 1, wantsBusiness: { state: "yes" } },
    });
    expect(String(body.idempotencyKey)).toContain(`${newcomer}:-:1`);

    // Re-reads, re-judgments, restarts: nothing more.
    await pass();
    await pass();
    expect(posts).toHaveLength(1);
  });

  it("hot -> not -> hot is a new fact: fires twice, each with its own key", async () => {
    await pass(); // arm
    const h = await subject("back@client.io");
    hot.set(h, true);
    await pass();
    hot.set(h, false);
    await pass();
    expect(posts).toHaveLength(1);
    hot.set(h, true);
    await pass();
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => (p.body.item as { episode: number }).episode)).toEqual([1, 2]);
    expect(posts[0].body.idempotencyKey).not.toBe(posts[1].body.idempotencyKey);
  });

  it("the brand's own team and staff fire nothing (recorded skipped)", async () => {
    await pass();
    const mate = await subject("Teammate+x@acme.io");
    const staff = await subject("someone@distribute.you");
    hot.set(mate, true);
    hot.set(staff, true);
    const p = await pass();
    expect(posts).toHaveLength(0);
    expect(p.skipped).toBe(2);
    const reasons = (await db.execute(sql`
      SELECT skip_reason FROM hot_lead_fires WHERE org_id = ${org} ORDER BY skip_reason`)) as unknown as Array<{ skip_reason: string }>;
    expect(reasons.map((r) => r.skip_reason)).toEqual(["own_team", "staff"]);
    await pass();
    expect(posts).toHaveLength(0);
  });

  it("every active offer's campaigns run, once each", async () => {
    const offerB = randomUUID();
    offers = [offerA, offerB];
    await pass();
    const h = await subject("two@client.io");
    hot.set(h, true);
    await pass();
    await pass();
    expect(posts.map((p) => p.body.offerId).sort()).toEqual([offerA, offerB].sort());
  });

  it("a trigger the catalogue does not serve yet is kept pending, then delivered once it does", async () => {
    await pass();
    const h = await subject("early@client.io");
    hot.set(h, true);
    served = false;
    const first = await pass();
    expect(first.delivery.retry).toBe(1);
    expect(posts).toHaveLength(0);
    served = true;
    await db.execute(sql`UPDATE hot_lead_fires SET next_attempt_at = now() WHERE org_id = ${org}`);
    await pass();
    expect(posts).toHaveLength(1);
    const [row] = (await db.execute(sql`SELECT status, campaign_event_id FROM hot_lead_fires WHERE org_id = ${org}`)) as unknown as Array<{ status: string; campaign_event_id: string }>;
    expect(row).toEqual({ status: "delivered", campaign_event_id: "evt-1" });
  });
});
