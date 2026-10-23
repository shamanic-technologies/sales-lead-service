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
const { sql } = await import("drizzle-orm");
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
    // A WhatsApp writer: known by human + phone only. A merged-away human id points at the canonical one; a recorded
    // duplicate lead of the same human answers by its survivor.
    const human = randomUUID();
    const atomic = randomUUID();
    ids.human = human;
    ids.atomic = atomic;
    const [w] = await db.insert(leads).values({ firstName: "Wa", humanId: human }).returning({ id: leads.id });
    const digits = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
    await db.insert(leadContactMethods).values({ leadId: w.id, channel: "phone", value: `+33 6 ${digits.slice(0, 2)} ${digits.slice(2)}`, source: "itest" });
    await db.insert(leadsCampaigns).values({ leadId: w.id, campaignId: `wa-${tag}`, orgId, brandIds: [brandId], status: "served" });
    ids.wa = w.id;
    ids.waPhone = `0033 6${digits}`;
    const [dup] = await db.insert(leads).values({ firstName: "Wa dup", humanId: human }).returning({ id: leads.id });
    await db.insert(leadsCampaigns).values({ leadId: dup.id, campaignId: `wa2-${tag}`, orgId, brandIds: [brandId], status: "served" });
    await db.execute(sql`INSERT INTO lead_identity_duplicates (lead_id, survivor_lead_id, human_id, company_id, reason) VALUES (${dup.id}::uuid, ${w.id}::uuid, ${human}::uuid, ${randomUUID()}::uuid, 'itest')`);
    await db.execute(sql`INSERT INTO human_aliases (atomic_human_id, human_id, event_id) VALUES (${atomic}::uuid, ${human}::uuid, 1)`);
  });

  it("answers a person known by human id (aliases followed, duplicate = survivor) or E.164 phone; a bad key never 400s the batch", async () => {
    const res = await resolve([
      { orgId, humanId: ids.human },
      { orgId, humanId: ids.atomic },
      { orgId, phone: ids.waPhone },
      { orgId, humanId: "not-a-uuid", phone: "06 12" },
      { orgId: otherOrgId, humanId: ids.human },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([
      { leadId: ids.wa, matchedBy: "human_id" },
      { leadId: ids.wa, matchedBy: "human_id" },
      { leadId: ids.wa, matchedBy: "phone" },
      { leadId: null, matchedBy: null },
      { leadId: null, matchedBy: null },
    ]);
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
