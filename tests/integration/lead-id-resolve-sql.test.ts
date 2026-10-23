/**
 * POST /internal/leads/ids/resolve against a REAL database (COST-ACCOUNTING-1023-P1): the three keys, the org/brand
 * scope, and "nothing minted" for a person nobody kept.
 */
import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns } = await import("../../src/db/schema.js");
const routes = (await import("../../src/routes/lead-id-resolve.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead id resolve against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(express.json());
  app.use(routes);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const [a] = await db.insert(leads).values({ firstName: "Ana", apolloPersonId: `ap-${tag}`, linkedinUrl: `https://www.linkedin.com/in/ana-${tag}/` }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: a.id, channel: "email", value: `Ana-${tag}@Example.com`, source: "itest" });
    await db.insert(leadsCampaigns).values({ leadId: a.id, campaignId: `c-${tag}`, orgId, brandIds: [brandId], status: "served" });
    ids.ana = a.id;
    // Known to the registry, never kept by any org: nothing answers for it.
    const [b] = await db.insert(leads).values({ firstName: "Bo", apolloPersonId: `bo-${tag}` }).returning({ id: leads.id });
    ids.bo = b.id;
  });

  const resolve = (people: unknown[]) => request(app).post("/internal/leads/ids/resolve").set("x-api-key", process.env.LEAD_SERVICE_API_KEY ?? "test").send({ people });

  it("answers by apollo person id, email (case-folded) and LinkedIn handle, in that order", async () => {
    const res = await resolve([
      { orgId, apolloPersonId: `ap-${tag}`, email: "nobody@example.com" },
      { orgId, email: `ana-${tag}@example.COM` },
      { orgId, linkedinUrl: `https://linkedin.com/in/ANA-${tag}?trk=x` },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([
      { leadId: ids.ana, matchedBy: "apollo_person_id" },
      { leadId: ids.ana, matchedBy: "email" },
      { leadId: ids.ana, matchedBy: "linkedin_url" },
    ]);
  });

  it("answers only for a lead OF the org (and of one of the brands when named); never mints", async () => {
    const res = await resolve([
      { orgId: otherOrgId, apolloPersonId: `ap-${tag}` },
      { orgId, brandIds: [otherBrandId], apolloPersonId: `ap-${tag}` },
      { orgId, brandIds: [otherBrandId, brandId], apolloPersonId: `ap-${tag}` },
      { orgId, apolloPersonId: `bo-${tag}` },
      { orgId, apolloPersonId: `never-${tag}` },
    ]);
    expect(res.body.people).toEqual([
      { leadId: null, matchedBy: null },
      { leadId: null, matchedBy: null },
      { leadId: ids.ana, matchedBy: "apollo_person_id" },
      { leadId: null, matchedBy: null },
      { leadId: null, matchedBy: null },
    ]);
  });

  it("refuses an item naming no key", async () => {
    expect((await resolve([{ orgId }])).status).toBe(400);
  });
});
