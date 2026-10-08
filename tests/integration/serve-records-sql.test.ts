/**
 * GET /internal/brands/:brandId/serve-records against a REAL database: the brand filter, the
 * no-dedup rule, the per-person projections (current employer, primary email) and the stream.
 */
import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, organizations, leadsOrganizations } = await import(
  "../../src/db/schema.js"
);
const serveRecordsRoutes = (await import("../../src/routes/serve-records.js")).default;
const { streamBasicLeadChunks } = await import("../../src/lib/basic-leads.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("serve-records read against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const c1 = `c1-${tag}`;
  const c2 = `c2-${tag}`;
  const app = express();
  app.use(serveRecordsRoutes);
  const ids: Record<string, string> = {};

  async function person(name: string, opts: { lastName?: string | null; emails?: string[]; company?: { name: string; domain: string | null; website: string | null } }) {
    const [row] = await db
      .insert(leads)
      .values({ firstName: name, lastName: opts.lastName === undefined ? "Doe" : opts.lastName, apolloPersonId: `ap-${name}-${tag}` })
      .returning({ id: leads.id });
    for (const value of opts.emails ?? []) {
      await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value, source: "itest" });
    }
    if (opts.company) {
      const [org] = await db
        .insert(organizations)
        .values({ name: opts.company.name, primaryDomain: opts.company.domain, websiteUrl: opts.company.website })
        .returning({ id: organizations.id });
      await db.insert(leadsOrganizations).values({ leadId: row.id, organizationId: org.id, current: true });
    }
    ids[name] = row.id;
    return row.id;
  }

  async function membership(leadId: string, campaignId: string, over: Partial<typeof leadsCampaigns.$inferInsert> = {}) {
    await db.insert(leadsCampaigns).values({
      leadId,
      campaignId,
      orgId,
      brandIds: [brandId],
      status: "served",
      servedAt: new Date("2026-10-01T10:00:00.000Z"),
      audienceId: "aud-1",
      ...over,
    });
  }

  const get = (brand: string, org: string) =>
    request(app).get(`/internal/brands/${brand}/serve-records`).set("x-api-key", "test-api-key").set("x-org-id", org);

  beforeAll(async () => {
    const ann = await person("ann", { emails: [`ann-${tag}@example.com`], company: { name: "Acme", domain: "acme.com", website: "https://acme.com" } });
    const bob = await person("bob", { lastName: null, company: { name: "NoDomain", domain: null, website: "https://www.nodomain.io/x" } });
    const cat = await person("cat", { emails: [`cat-${tag}@example.com`] });
    // Ann is served under TWO campaigns: two serve runs, two rows (never collapsed to her person).
    await membership(ann, c1, { runId: `run-ann-1-${tag}`, createdAt: new Date("2026-10-01T10:00:00.000Z") });
    await membership(ann, c2, { runId: `run-ann-2-${tag}`, createdAt: new Date("2026-10-02T10:00:00.000Z"), audienceId: "aud-2" });
    // A serve the lifecycle later skipped was still paid for.
    await membership(bob, c1, { runId: `run-bob-${tag}`, status: "skipped", createdAt: new Date("2026-10-03T10:00:00.000Z"), audienceId: null });
    // Buffered, never handed out: no serve run, not a serve record.
    await membership(cat, c1, { status: "buffered", servedAt: null });
    // Another brand of the same org, and the same brand under another org.
    await membership(cat, c2, { runId: `run-cat-other-brand-${tag}`, brandIds: [otherBrandId] });
    await db.insert(leadsCampaigns).values({ leadId: cat, campaignId: `c3-${tag}`, orgId: otherOrgId, brandIds: [brandId], status: "served", runId: `run-cat-other-org-${tag}` });
  }, 60_000);

  it("answers every serve run of the (org, brand), every campaign and status, one row per serve", async () => {
    const res = await get(brandId, orgId);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.serves.map((s: { runId: string }) => s.runId)).toEqual([
      `run-ann-1-${tag}`,
      `run-ann-2-${tag}`,
      `run-bob-${tag}`,
    ]);
    expect(res.body.serves[1]).toEqual({
      runId: `run-ann-2-${tag}`,
      leadId: ids.ann,
      campaignId: c2,
      audienceId: "aud-2",
      servedAt: "2026-10-01T10:00:00.000Z",
      apolloPersonId: `ap-ann-${tag}`,
      email: `ann-${tag}@example.com`,
      firstName: "ann",
      lastName: "Doe",
      company: { name: "Acme", primaryDomain: "acme.com", websiteUrl: "https://acme.com" },
    });
    expect(res.body.serves[2]).toMatchObject({
      leadId: ids.bob,
      audienceId: null,
      email: null,
      lastName: null,
      company: { name: "NoDomain", primaryDomain: null, websiteUrl: "https://www.nodomain.io/x" },
    });
  });

  it("states the same identity as a view=basic row of the same person", async () => {
    const res = await get(brandId, orgId);
    const basic = [];
    for await (const chunk of streamBasicLeadChunks({ orgId, brandId, campaignIds: [c1], statuses: ["buffered", "skipped", "claimed", "served"] }, 100)) {
      basic.push(...chunk);
    }
    for (const b of basic.filter((r) => r.runId)) {
      const s = res.body.serves.find((x: { runId: string }) => x.runId === b.runId);
      expect(s).toBeDefined();
      expect(s.apolloPersonId).toBe(b.leadApolloPersonId);
      expect(s.email).toBe(b.email?.value ?? null);
      expect(s.firstName ?? "").toBe(b.lead?.firstName);
      expect(s.lastName ?? "").toBe(b.lead?.lastName);
      expect(s.company?.name ?? null).toBe(b.lead?.organization?.name ?? null);
      expect(s.company?.primaryDomain ?? null).toBe(b.lead?.organization?.primaryDomain ?? null);
      expect(s.company?.websiteUrl ?? null).toBe(b.lead?.organization?.websiteUrl ?? null);
      expect(s.audienceId).toBe(b.audienceId);
      expect(s.campaignId).toBe(b.campaignId);
    }
  });

  it("an unknown brand is an empty, well-formed body; a missing org is a 400", async () => {
    const res = await get(randomUUID(), orgId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serves: [], count: 0 });
    const noOrg = await request(app).get(`/internal/brands/${brandId}/serve-records`).set("x-api-key", "test-api-key");
    expect(noOrg.status).toBe(400);
  });
});
