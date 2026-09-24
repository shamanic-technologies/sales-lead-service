/**
 * The lead change feed, against a REAL database and through the real routes.
 *
 * The property under test is the one the consumer is owed: take the snapshot, apply every answer
 * after it, and you hold EXACTLY what a full `GET /orgs/leads?view=compact` returns — through a new
 * serve, a person who leaves the scope, a renamed person, an announced delivery change and an
 * unannounced one (caught by the reconcile). A mocked `sql` compiles none of the triggers, the
 * version counter or the keyset reads, so this runs them; only the delivery layer is stubbed, at
 * its HTTP-client boundary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

let statusByEmail: Record<string, Record<string, unknown>> = {};
let gatewayCalls = 0;
vi.mock("../../src/lib/email-gateway-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/email-gateway-client.js")>()),
  checkDeliveryStatus: (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) => {
    gatewayCalls += 1;
    return Promise.resolve({
      results: items
        .filter((i) => statusByEmail[i.email])
        .map((i) => ({ email: i.email, broadcast: { brand: statusByEmail[i.email] } })),
    });
  },
}));

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, leadsOrganizations, organizations } = await import(
  "../../src/db/schema.js"
);
const feedLib = await import("../../src/lib/lead-change-feed.js");
const { noteEvidenceChanged, readModelScopeFor } = await import("../../src/lib/lead-read-model.js");
const leadsRoutes = (await import("../../src/routes/leads.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

type Row = { id: string } & Record<string, unknown>;

describe.skipIf(!hasRealDatabase)("the lead change feed against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignA = `itest-feed-a-${randomUUID()}`;
  const campaignB = `itest-feed-b-${randomUUID()}`;
  const app = express();
  app.use(express.json());
  app.use(leadsRoutes);
  const leadIds: string[] = [];
  const people: Record<string, { leadId: string; rowId: string }> = {};

  const get = (path: string) => request(app).get(path).set("x-api-key", "test-api-key").set("x-org-id", orgId);

  async function seed(key: string, email: string, campaignId: string, at: string) {
    const [lead] = await db
      .insert(leads)
      .values({ firstName: key, lastName: "Test", name: `${key} Test` })
      .returning({ id: leads.id });
    leadIds.push(lead.id);
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "itest" });
    const [org] = await db
      .insert(organizations)
      .values({ name: `${key} Co`, primaryDomain: `${key.toLowerCase()}.test` })
      .returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId: lead.id, organizationId: org.id, title: "Owner", current: true });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId, orgId, brandIds: [brandId], status: "served", servedAt: new Date(at), createdAt: new Date(at) })
      .returning({ id: leadsCampaigns.id });
    people[key] = { leadId: lead.id, rowId: row.id };
  }

  async function fullCompact(): Promise<Map<string, Row>> {
    const res = await get(`/orgs/leads?view=compact&brandId=${brandId}`);
    expect(res.status).toBe(200);
    return new Map((res.body.leads as Row[]).map((r) => [r.id, r]));
  }

  async function changes(since?: string) {
    const res = await get(
      `/orgs/leads/changes?brandId=${brandId}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
    );
    return res;
  }

  function apply(copy: Map<string, Row>, body: { full: boolean; leads: Row[]; removed: string[] }) {
    const next = body.full ? new Map<string, Row>() : new Map(copy);
    for (const row of body.leads) next.set(row.id, row);
    for (const id of body.removed) next.delete(id);
    return next;
  }

  function sorted(m: Map<string, Row>) {
    return [...m.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  beforeAll(async () => {
    statusByEmail = {
      "jane@feed.test": { contacted: true, sent: true, firstSentAt: "2026-02-01T00:00:00.000Z" },
      "john@feed.test": { contacted: true, clicked: true, firstClickedAt: "2026-02-02T00:00:00.000Z" },
    };
    await seed("Jane", "jane@feed.test", campaignA, "2026-01-01T00:00:00Z");
    await seed("John", "john@feed.test", campaignA, "2026-01-02T00:00:00Z");
    await seed("Ada", "ada@feed.test", campaignB, "2026-01-03T00:00:00Z");
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM lead_change_feeds WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_read_changes WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_delivery_evidence WHERE org_id = ${orgId}`;
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  });

  let copy = new Map<string, Row>();
  let cursor = "";

  it("answers the whole scope first, row for row what view=compact returns", async () => {
    const res = await changes();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ full: true, reason: "no_cursor", removed: [] });
    expect(res.body.cursor).toMatch(/^lf1\./);
    copy = apply(copy, res.body);
    cursor = res.body.cursor;
    expect(sorted(copy)).toEqual(sorted(await fullCompact()));
    expect(copy.size).toBe(3);
  });

  it("answers nothing when nothing changed, and asks the delivery layer nothing", async () => {
    gatewayCalls = 0;
    const res = await changes(cursor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ full: false, reason: null, leads: [], removed: [] });
    expect(gatewayCalls).toBe(0);
    cursor = res.body.cursor;
  });

  it("delivers a new serve, a leaver, a rename and an announced reply — and nothing else", async () => {
    await seed("Neo", "neo@feed.test", campaignB, "2026-01-04T00:00:00Z");
    await db.update(leadsCampaigns).set({ status: "skipped" }).where(eq(leadsCampaigns.id, people.John.rowId));
    await db.update(leads).set({ firstName: "Augusta" }).where(eq(leads.id, people.Ada.leadId));
    statusByEmail["jane@feed.test"] = {
      contacted: true,
      sent: true,
      replied: true,
      replyClassification: "positive",
      firstSentAt: "2026-02-01T00:00:00.000Z",
      firstRepliedAt: "2026-02-05T00:00:00.000Z",
    };
    await noteEvidenceChanged(orgId, ["JANE@feed.test"]);

    const res = await changes(cursor);
    expect(res.status).toBe(200);
    expect(res.body.full).toBe(false);
    expect((res.body.leads as Row[]).map((r) => r.id).sort()).toEqual(
      [people.Jane.rowId, people.Ada.rowId, people.Neo.rowId].sort(),
    );
    expect(res.body.removed).toEqual([people.John.rowId]);
    copy = apply(copy, res.body);
    cursor = res.body.cursor;
    const full = await fullCompact();
    expect(sorted(copy)).toEqual(sorted(full));
    expect(full.get(people.Jane.rowId)).toMatchObject({ replied: true, replyClassification: "positive" });
    expect((full.get(people.Ada.rowId)!.lead as { firstName: string }).firstName).toBe("Augusta");
  });

  it("follows a person's winning row when they are served again under another campaign", async () => {
    // Ada's newer serve wins the per-person dedup: her old row leaves, the new one arrives.
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: people.Ada.leadId,
        campaignId: campaignA,
        orgId,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date("2026-03-01T00:00:00Z"),
        createdAt: new Date("2026-03-01T00:00:00Z"),
      })
      .returning({ id: leadsCampaigns.id });
    const res = await changes(cursor);
    expect(res.body.removed).toEqual([people.Ada.rowId]);
    expect((res.body.leads as Row[]).map((r) => r.id)).toEqual([row.id]);
    copy = apply(copy, res.body);
    cursor = res.body.cursor;
    expect(sorted(copy)).toEqual(sorted(await fullCompact()));
  });

  it("catches delivery evidence nobody announced at the next reconcile", async () => {
    statusByEmail["neo@feed.test"] = { contacted: true, sent: true, opened: true };
    // Unannounced: the next delta does not know about it yet...
    const before = await changes(cursor);
    expect(before.body.leads).toEqual([]);
    cursor = before.body.cursor;
    // ...the reconcile does, once the stored answer is older than what it accepts.
    await sql`UPDATE lead_delivery_evidence SET fetched_at = now() - interval '10 minutes' WHERE org_id = ${orgId}`;
    const feed = await feedLib.openChangeFeed(
      readModelScopeFor({ orgId, brandId, statuses: ["buffered", "claimed", "served"] }, brandId, true),
    );
    expect(await feedLib.reconcileFeed(feed)).toBe(1);
    const res = await changes(cursor);
    expect((res.body.leads as Row[]).map((r) => r.id)).toEqual([people.Neo.rowId]);
    copy = apply(copy, res.body);
    cursor = res.body.cursor;
    expect(sorted(copy)).toEqual(sorted(await fullCompact()));
  });

  it("tells a caller its position is gone, and answers the whole scope instead", async () => {
    await sql`DELETE FROM lead_change_feeds WHERE org_id = ${orgId}`;
    const res = await changes(cursor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ full: true, reason: "feed_replaced", removed: [] });
    expect(sorted(apply(new Map(), res.body))).toEqual(sorted(await fullCompact()));
    cursor = res.body.cursor;
  });

  it("refuses a position it did not issue, one from another scope, and page-shaping parameters", async () => {
    expect((await changes("nonsense")).status).toBe(400);
    expect((await changes(feedLib.encodeFeedPosition({ feedId: randomUUID(), version: "1" }))).status).toBe(200);
    const other = await get(`/orgs/leads/changes?campaignId=${campaignA}&brandId=${brandId}`);
    // campaign-service is not reachable here, so the identity falls back to the named row; either
    // way it is a different scope from the brand's.
    expect(other.status).toBe(200);
    const crossed = await changes(other.body.cursor);
    expect(crossed.status).toBe(400);
    const decoded = feedLib.decodeFeedPosition(cursor);
    const ahead = feedLib.encodeFeedPosition({ feedId: decoded.feedId, version: "999999" });
    expect((await changes(ahead)).status).toBe(400);
    expect((await get(`/orgs/leads/changes?brandId=${brandId}&limit=5`)).status).toBe(400);
    expect((await get(`/orgs/leads/changes?brandId=${brandId}&view=basic`)).status).toBe(400);
  });
});
