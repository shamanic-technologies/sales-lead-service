/**
 * The read model, executed against a REAL database.
 *
 * A count is a GROUP BY over the model's rows, a page an ORDER BY ... LIMIT with a keyset cursor,
 * a search an ILIKE over a joined text column, and freshness is a trigger writing a change log that
 * a read applies before it answers. A mocked `sql` compiles none of that, so this file runs it:
 * seeded people, a delivery layer and a campaign-service stubbed at the HTTP-client boundary, and
 * everything between them real.
 *
 * The properties under test are the ones the Leads page is owed: the counts and the pages describe
 * the same set; a person's statement is on the VERY NEXT read; a pushed evidence change is too; a
 * read that has nothing new to apply asks the delivery layer nothing; and a model past its bound is
 * rebuilt rather than served.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

let gatewayCalls: string[][] = [];
let statusByEmail: Record<string, Record<string, unknown>> = {};
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) => {
    gatewayCalls.push(items.map((i) => i.email));
    return Promise.resolve({
      results: items
        .filter((i) => statusByEmail[i.email])
        .map((i) => ({ email: i.email, broadcast: { brand: statusByEmail[i.email] } })),
    });
  },
}));

let legByCampaign = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-leg-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-leg-client.js")>()),
  fetchOrgCampaignLegs: () => Promise.resolve(legByCampaign),
  fetchOrgCampaignOffers: () => Promise.resolve(new Map([...legByCampaign.keys()].map((id) => [id, null]))),
}));

// The replies, each with its own verdict (instantly-service), stubbed at the HTTP-client boundary.
let repliesByEmail: Record<string, Array<{ receivedAt: string; kind: string; classification: string }>> = {};
vi.mock("../../src/lib/reply-verdicts-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/reply-verdicts-client.js")>()),
  fetchReplyVerdicts: (emails: string[]) =>
    Promise.resolve(
      emails.flatMap((email) =>
        (repliesByEmail[email] ?? []).map((r, i) => ({
          replyId: `${email}-${i}`,
          leadEmail: email,
          instantlyCampaignId: "i",
          campaignId: [...legByCampaign.keys()][0] ?? null,
          brandIds: [brandIdForReplies],
          transport: "instantly",
          fromEmail: email,
          subject: null,
          receivedAt: r.receivedAt,
          verdict: { kind: r.kind, classification: r.classification, producerType: "model", producer: "m", attribution: "exact", confidence: null, decidedAt: r.receivedAt, automatedAnswer: false, stopRequested: false, notOurTarget: false, handedToPerson: false },
          verdictCount: 1,
        })),
      ),
    ),
}));
let brandIdForReplies = "";

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, leadsOrganizations, organizations, conversionEvents } =
  await import("../../src/db/schema.js");
const model = await import("../../src/lib/lead-read-model.js");
const evidence = await import("../../src/lib/lead-delivery-evidence.js");
const { decodeLeadCursor } = await import("../../src/lib/lead-list-query.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("the read model against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `itest-model-${randomUUID()}`;
  const scope = model.readModelScopeFor(
    { orgId, brandId, statuses: ["buffered", "claimed", "served"] },
    brandId,
    true,
  );

  const people: Array<{ rowId: string; leadId: string; email: string }> = [];

  async function seed(p: { first: string; last: string; title: string; company: string; email: string; at: string }) {
    const [lead] = await db
      .insert(leads)
      .values({ firstName: p.first, lastName: p.last, name: `${p.first} ${p.last}` })
      .returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: p.email, source: "itest" });
    const [org] = await db
      .insert(organizations)
      .values({ name: p.company, primaryDomain: `${p.company.toLowerCase()}.test` })
      .returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId: lead.id, organizationId: org.id, title: p.title, current: true });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId,
        orgId,
        brandIds: [brandId],
        status: "served",
        createdAt: new Date(p.at),
      })
      .returning({ id: leadsCampaigns.id });
    people.push({ rowId: row.id, leadId: lead.id, email: p.email });
  }

  beforeAll(async () => {
    await seed({ first: "Jane", last: "Roe", title: "Head of Growth", company: "Acme", email: "jane@acme.test", at: "2026-01-01T00:00:00Z" });
    await seed({ first: "John", last: "Doe", title: "CFO", company: "Globex", email: "john@globex.test", at: "2026-01-02T00:00:00Z" });
    await seed({ first: "Ten", last: "Percent_Off", title: "Owner", company: "Disco", email: "ten@disco.test", at: "2026-01-03T00:00:00Z" });
    await seed({ first: "Ada", last: "Byron", title: "Founder", company: "Engines", email: "ada@engines.test", at: "2026-01-04T00:00:00Z" });
  }, 60_000);

  beforeEach(() => {
    brandIdForReplies = brandId;
    repliesByEmail = {
      "ten@disco.test": [{ receivedAt: "2026-02-03T00:00:00.000Z", kind: "positive_kind", classification: "positive" }],
    };
    gatewayCalls = [];
    legByCampaign = new Map([[campaignId, "start_to_website_visit"]]);
    statusByEmail = {
      "jane@acme.test": { contacted: true, sent: true, firstSentAt: "2026-02-01T00:00:00.000Z" },
      "john@globex.test": { contacted: true, sent: true, clicked: true, firstClickedAt: "2026-02-02T00:00:00.000Z" },
      "ten@disco.test": {
        contacted: true,
        sent: true,
        replied: true,
        replyClassification: "positive",
        firstRepliedAt: "2026-02-03T00:00:00.000Z",
      },
    };
  });

  afterAll(async () => {
    await sql`DELETE FROM lead_read_models WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_read_changes WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_delivery_evidence WHERE org_id = ${orgId}`;
    await db.delete(conversionEvents).where(eq(conversionEvents.orgId, orgId));
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    await db.delete(leads).where(inArray(leads.id, people.map((p) => p.leadId)));
  });

  it("counts every bucket and every standing off one model, and the standings sum to the total", async () => {
    const m = await model.ensureReadModel(scope);
    const buckets = await model.readModelBucketCounts(m, null);
    expect(buckets.total).toBe(4);
    expect(buckets.counts).toMatchObject({ contacted: 3, website_visit: 1, positive_reply: 1, sale: 0 });
    // All three contacted were sent and nobody bounced: all three delivered. Interested = John
    // (visit) + Ten (reply).
    expect(buckets.people).toEqual({ sent: 3, delivered: 3, interested: 2 });
    const standings = await model.readModelStandingCounts(m, null);
    expect(standings.total).toBe(4);
    expect(Object.values(standings.counts).reduce((a, b) => a + b, 0)).toBe(4);
    expect(standings.counts.not_contacted).toBe(1); // Ada was served and nothing reached her
  });

  it("splits sales_interest by funnel stage — a partition, stored per row, pageable per stage", async () => {
    // John clicked on a visit-led funnel: sales_interest at its entry. Ada books a meeting.
    const [booked] = await db
      .insert(conversionEvents)
      .values({
        brandId,
        orgId,
        event: "meeting_booked",
        matchedLeadId: people[3].leadId,
        leadCampaignId: people[3].rowId,
        matchConfidence: "exact",
        attributionStatus: "attributed",
        source: "manual",
        costCents: 0,
      })
      .returning({ id: conversionEvents.id });
    try {
      const m = await model.ensureReadModel(scope);
      const { counts, stages } = await model.readModelStandingAndStageCounts(m, null);
      expect(counts.sales_interest).toBe(2);
      expect(Object.fromEntries(stages)).toEqual({ website_visit: 1, meeting_booked: 1 });
      expect([...stages.values()].reduce((a, b) => a + b, 0)).toBe(counts.sales_interest);
      // The plain count answers exactly as before.
      expect((await model.readModelStandingCounts(m, null)).counts).toEqual(counts);

      const page = await model.readModelPage(m, {
        tokens: null,
        bucket: null,
        standings: null,
        stages: ["meeting_booked"],
        sort: "activity",
        page: { limit: 10, cursor: null, offset: null },
      });
      expect(page.total).toBe(1);
      const ids: string[] = [];
      for await (const chunk of page.ids(10)) ids.push(...chunk);
      expect(ids).toEqual([people[3].rowId]);
    } finally {
      await db
        .update(conversionEvents)
        .set({ withdrawnAt: new Date() })
        .where(eq(conversionEvents.id, booked.id));
    }
  });

  it("asks the delivery layer NOTHING when there is nothing new to apply", async () => {
    await model.ensureReadModel(scope);
    gatewayCalls = [];
    await model.ensureReadModel(scope);
    await model.ensureReadModel(scope);
    expect(gatewayCalls).toEqual([]);
  });

  it("searches the person, their title, their company and their address — every word, literally", async () => {
    const m = await model.ensureReadModel(scope);
    const count = async (tokens: string[]) => (await model.readModelBucketCounts(m, tokens)).total;
    expect(await count(["jane"])).toBe(1);
    expect(await count(["acme"])).toBe(1);
    expect(await count(["cfo"])).toBe(1);
    expect(await count(["globex.test"])).toBe(1);
    expect(await count(["jane", "acme"])).toBe(1);
    expect(await count(["jane", "globex"])).toBe(0);
    expect(await count(["percent_off"])).toBe(1);
    expect(await count(["percentaoff"])).toBe(0);
    // A word never matches ACROSS two fields.
    expect(await count(["roehead"])).toBe(0);
  });

  it("pages a bucket by activity, newest first, and a cursor walk visits each person exactly once", async () => {
    const m = await model.ensureReadModel(scope);
    const first = await model.readModelPage(m, {
      tokens: null,
      bucket: "contacted",
      standings: null,
      sort: "activity",
      page: { limit: 2, cursor: null, offset: null },
    });
    expect(first.total).toBe(3);
    const ids: string[] = [];
    for await (const chunk of first.ids(10)) ids.push(...chunk);
    expect(ids).toEqual([people[2].rowId, people[1].rowId]); // reply (Feb 3) then click (Feb 2)
    expect(first.nextCursor).toBeTruthy();
    const second = await model.readModelPage(m, {
      tokens: null,
      bucket: "contacted",
      standings: null,
      sort: "activity",
      page: { limit: 2, cursor: decodeLeadCursor(first.nextCursor), offset: null },
    });
    const rest: string[] = [];
    for await (const chunk of second.ids(10)) rest.push(...chunk);
    expect(rest).toEqual([people[0].rowId]);
    expect(second.nextCursor).toBeNull();
  });

  it("walks the created order unbounded, in (created_at, id) order", async () => {
    const m = await model.ensureReadModel(scope);
    const all = await model.readModelPage(m, {
      tokens: null,
      bucket: null,
      standings: null,
      sort: "created",
      page: { limit: null, cursor: null, offset: null },
    });
    const ids: string[] = [];
    for await (const chunk of all.ids(1)) ids.push(...chunk);
    expect(ids).toEqual(people.map((p) => p.rowId));
  });

  it("shows a person's close-won on the VERY NEXT read, and its withdrawal on the one after", async () => {
    await model.ensureReadModel(scope);
    const [won] = await db
      .insert(conversionEvents)
      .values({
        brandId,
        orgId,
        event: "sale",
        matchedLeadId: people[3].leadId,
        leadCampaignId: people[3].rowId,
        matchConfidence: "exact",
        attributionStatus: "attributed",
        source: "manual",
        valueCents: 100_00,
        costCents: 0,
      })
      .returning({ id: conversionEvents.id });

    const after = await model.ensureReadModel(scope);
    expect((await model.readModelBucketCounts(after, null)).counts.sale).toBe(1);
    expect((await model.readModelStandingCounts(after, null)).counts.customer).toBe(1);
    const page = await model.readModelPage(after, {
      tokens: null,
      bucket: null,
      standings: ["customer"],
      sort: "activity",
      page: { limit: 20, cursor: null, offset: null },
    });
    const ids: string[] = [];
    for await (const chunk of page.ids(20)) ids.push(...chunk);
    expect(ids).toEqual([people[3].rowId]);
    // The statement is ours; applying it asked the delivery layer nothing.
    expect(gatewayCalls).toEqual([]);

    await db.update(conversionEvents).set({ withdrawnAt: new Date() }).where(eq(conversionEvents.id, won.id));
    const withdrawn = await model.ensureReadModel(scope);
    expect((await model.readModelBucketCounts(withdrawn, null)).counts.sale).toBe(0);
    expect((await model.readModelStandingCounts(withdrawn, null)).counts.customer).toBe(0);
  });

  it("asks again, on the next read, about an address whose evidence was pushed as changed — and only that one", async () => {
    await model.ensureReadModel(scope);
    statusByEmail["jane@acme.test"] = { contacted: true, sent: true, unsubscribed: true };
    await model.noteEvidenceChanged(orgId, ["Jane@Acme.test"]);
    gatewayCalls = [];
    const m = await model.ensureReadModel(scope);
    expect(gatewayCalls).toEqual([["jane@acme.test"]]);
    expect((await model.readModelStandingCounts(m, null)).counts.opted_out).toBe(1);
    // Applied once: the next read asks nothing again.
    gatewayCalls = [];
    await model.ensureReadModel(scope);
    expect(gatewayCalls).toEqual([]);
  });

  it("refreshes a model past its bound IN PLACE instead of serving it, asking everyone again", async () => {
    const before = await model.ensureReadModel(scope);
    await sql`
      UPDATE lead_read_models SET evidence_at = now() - interval '6 minutes' WHERE id = ${before.id}
    `;
    // What the model was built from is as old as the model: nothing recent enough to reuse.
    await sql`
      UPDATE lead_delivery_evidence SET fetched_at = now() - interval '6 minutes' WHERE org_id = ${orgId}
    `;
    evidence.resetEvidenceConfirmations();
    gatewayCalls = [];
    const after = await model.ensureReadModel(scope);
    // Same model, re-derived where it stands: no second copy written, none retired.
    expect(after.id).toBe(before.id);
    expect(after.evidenceAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(gatewayCalls.flat().sort()).toEqual(
      ["jane@acme.test", "john@globex.test", "ten@disco.test", "ada@engines.test"].sort(),
    );
    const models = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM lead_read_models WHERE org_id = ${orgId} AND retired_at IS NOT NULL
    `;
    expect(models[0].n).toBe(0);
    expect((await model.readModelBucketCounts(after, null)).total).toBe(4);
  });

  it("a refresh where nothing moved writes NO model row and NO evidence row", async () => {
    const m = await model.ensureReadModel(scope);
    const rowVersions = async () =>
      sql<Array<{ id: string; x: string }>>`
        SELECT id::text AS id, xmin::text AS x FROM lead_read_model_rows WHERE model_id = ${m.id} ORDER BY id
      `;
    const evidenceVersions = async () =>
      sql<Array<{ email: string; x: string }>>`
        SELECT email, xmin::text AS x FROM lead_delivery_evidence WHERE org_id = ${orgId} ORDER BY email
      `;
    const rowsBefore = await rowVersions();
    const evidenceBefore = await evidenceVersions();
    await sql`UPDATE lead_read_models SET evidence_at = now() - interval '6 minutes' WHERE id = ${m.id}`;
    await sql`UPDATE lead_delivery_evidence SET fetched_at = now() - interval '6 minutes' WHERE org_id = ${orgId}`;
    const evidenceStaled = await evidenceVersions();
    evidence.resetEvidenceConfirmations();
    gatewayCalls = [];
    await model.ensureReadModel(scope);
    // Everyone was asked again (the bound demands it) ...
    expect(gatewayCalls.flat()).toHaveLength(3 + 1);
    // ... and since every answer and every derived row is unchanged, nothing was rewritten.
    expect(await rowVersions()).toEqual(rowsBefore);
    expect(await evidenceVersions()).toEqual(evidenceStaled);
    expect(evidenceStaled).not.toEqual(evidenceBefore);
    // The answers asked just now count as fresh: the next read asks nothing.
    gatewayCalls = [];
    await model.ensureReadModel(scope);
    expect(gatewayCalls).toEqual([]);
  });

  it("a refresh picks up evidence NOBODY pushed, and writes only the person it moved", async () => {
    const m = await model.ensureReadModel(scope);
    const version = async (rowId: string) =>
      (
        await sql<Array<{ x: string }>>`
          SELECT xmin::text AS x FROM lead_read_model_rows WHERE model_id = ${m.id} AND id = ${rowId}
        `
      )[0].x;
    const adaBefore = await version(people[3].rowId);
    const janeBefore = await version(people[0].rowId);
    statusByEmail["ada@engines.test"] = { contacted: true, sent: true, firstSentAt: "2026-02-04T00:00:00.000Z" };
    await sql`UPDATE lead_read_models SET evidence_at = now() - interval '6 minutes' WHERE id = ${m.id}`;
    await sql`UPDATE lead_delivery_evidence SET fetched_at = now() - interval '6 minutes' WHERE org_id = ${orgId}`;
    evidence.resetEvidenceConfirmations();
    const after = await model.ensureReadModel(scope);
    expect((await model.readModelBucketCounts(after, null)).counts.contacted).toBe(4);
    expect(await version(people[3].rowId)).not.toBe(adaBefore);
    expect(await version(people[0].rowId)).toBe(janeBefore);
    delete statusByEmail["ada@engines.test"];
  });

  it("a refresh removes a person who left the scope without any statement", async () => {
    const m = await model.ensureReadModel(scope);
    await db.update(leadsCampaigns).set({ status: "skipped" }).where(eq(leadsCampaigns.id, people[2].rowId));
    try {
      await sql`UPDATE lead_read_models SET evidence_at = now() - interval '6 minutes' WHERE id = ${m.id}`;
      const after = await model.ensureReadModel(scope);
      expect(after.id).toBe(m.id);
      expect((await model.readModelBucketCounts(after, null)).total).toBe(3);
    } finally {
      await db.update(leadsCampaigns).set({ status: "served" }).where(eq(leadsCampaigns.id, people[2].rowId));
    }
    await sql`UPDATE lead_read_models SET evidence_at = now() - interval '6 minutes' WHERE id = ${m.id}`;
    expect((await model.readModelBucketCounts(await model.ensureReadModel(scope), null)).total).toBe(4);
  });

  it("drops a person who leaves the scope on the next read after their statement moves", async () => {
    await model.ensureReadModel(scope);
    await db.update(leadsCampaigns).set({ status: "skipped" }).where(eq(leadsCampaigns.id, people[1].rowId));
    // A statement on that person is what the change log carries; their row is recomputed from
    // the CURRENT relation, which no longer holds them under the default statuses.
    await db.insert(conversionEvents).values({
      brandId,
      orgId,
      event: "signup",
      matchedLeadId: people[1].leadId,
      matchConfidence: "exact",
      attributionStatus: "attributed",
      source: "manual",
      costCents: 0,
    });
    const m = await model.ensureReadModel(scope);
    expect((await model.readModelBucketCounts(m, null)).total).toBe(3);
    await db.update(leadsCampaigns).set({ status: "served" }).where(eq(leadsCampaigns.id, people[1].rowId));
  });

  describe("held across threads: a catch-up and a refresh of one scope never interleave", () => {
    const scopeLock = () => import("../../src/lib/scope-lock.js");
    let other: ReturnType<typeof import("postgres").default> | null = null;

    beforeAll(async () => {
      const locks = await scopeLock();
      locks.enableCrossThreadLocks(process.env.LEAD_SERVICE_DATABASE_URL!, 2);
      const postgres = (await import("postgres")).default;
      // Another thread, as far as Postgres can tell: its own session.
      other = postgres(process.env.LEAD_SERVICE_DATABASE_URL!, { max: 4, prepare: false });
    });

    afterAll(async () => {
      await other?.end();
    });

    async function holdElsewhere(namespace: string) {
      const locks = await scopeLock();
      const key = locks.advisoryKey(namespace, model.readModelKey(scope));
      const conn = await other!.reserve();
      await conn`SELECT pg_advisory_lock(${key}::bigint)`;
      return async () => {
        await conn`SELECT pg_advisory_unlock(${key}::bigint)`;
        conn.release();
      };
    }

    const settledWithin = <T>(p: Promise<T>, ms: number) =>
      Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

    it("a read with nothing new to apply answers without waiting behind a refresh in progress", async () => {
      await model.ensureReadModel(scope);
      const release = await holdElsewhere("read-model");
      const releaseRefresh = await holdElsewhere("read-model-refresh");
      try {
        expect(await settledWithin(model.ensureReadModel(scope), 2_000)).toBe(true);
      } finally {
        await release();
        await releaseRefresh();
      }
    });

    it("a read with a statement to apply waits for the other thread's chunk, then shows it", async () => {
      await model.ensureReadModel(scope);
      const release = await holdElsewhere("read-model");
      const [won] = await db
        .insert(conversionEvents)
        .values({
          brandId,
          orgId,
          event: "sale",
          matchedLeadId: people[0].leadId,
          leadCampaignId: people[0].rowId,
          matchConfidence: "exact",
          attributionStatus: "attributed",
          source: "manual",
          valueCents: 100_00,
          costCents: 0,
        })
        .returning({ id: conversionEvents.id });
      let read: Promise<Awaited<ReturnType<typeof model.ensureReadModel>>>;
      try {
        read = model.ensureReadModel(scope);
        expect(await settledWithin(read, 500)).toBe(false);
      } finally {
        await release();
      }
      const m = await read!;
      expect((await model.readModelStandingCounts(m, null)).counts.customer).toBe(1);
      await db.update(conversionEvents).set({ withdrawnAt: new Date() }).where(eq(conversionEvents.id, won.id));
      await model.ensureReadModel(scope);
    });

    it("sees a lock the other thread holds as busy (what lets a change feed read skip a reconcile in progress)", async () => {
      const locks = await scopeLock();
      expect(await locks.scopeLockBusy("read-model", model.readModelKey(scope))).toBe(false);
      const release = await holdElsewhere("read-model");
      try {
        expect(await locks.scopeLockBusy("read-model", model.readModelKey(scope))).toBe(true);
      } finally {
        await release();
      }
    });
  });
});
