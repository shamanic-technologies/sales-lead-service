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

let funnelByCampaign = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-funnel-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-funnel-client.js")>()),
  fetchOrgCampaignFunnelKeys: () => Promise.resolve(funnelByCampaign),
}));

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, leadsOrganizations, organizations, conversionEvents } =
  await import("../../src/db/schema.js");
const model = await import("../../src/lib/lead-read-model.js");
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
    gatewayCalls = [];
    funnelByCampaign = new Map([[campaignId, "sales_meetings_from_website"]]);
    statusByEmail = {
      "jane@acme.test": { contacted: true, sent: true, firstSentAt: "2026-02-01T00:00:00.000Z" },
      "john@globex.test": { contacted: true, clicked: true, firstClickedAt: "2026-02-02T00:00:00.000Z" },
      "ten@disco.test": {
        contacted: true,
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

  it("rebuilds a model past its bound instead of serving it, and retires the old one", async () => {
    const before = await model.ensureReadModel(scope);
    await sql`
      UPDATE lead_read_models SET evidence_at = now() - interval '6 minutes' WHERE id = ${before.id}
    `;
    // What the model was built from is as old as the model: nothing recent enough to reuse.
    await sql`
      UPDATE lead_delivery_evidence SET fetched_at = now() - interval '6 minutes' WHERE org_id = ${orgId}
    `;
    gatewayCalls = [];
    const after = await model.ensureReadModel(scope);
    expect(after.id).not.toBe(before.id);
    expect(gatewayCalls.flat().sort()).toEqual(
      ["jane@acme.test", "john@globex.test", "ten@disco.test", "ada@engines.test"].sort(),
    );
    const old = await sql<Array<{ scope_key: string | null; retired_at: Date | null }>>`
      SELECT scope_key, retired_at FROM lead_read_models WHERE id = ${before.id}
    `;
    expect(old[0].scope_key).toBeNull();
    expect(old[0].retired_at).not.toBeNull();
    // The retired model still reads whole — a read that held it across the swap is not emptied.
    expect((await model.readModelBucketCounts(before, null)).total).toBe(4);
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
});
