/**
 * POST /internal/brands/:brandId/leads/by-address against a REAL database (MON-DB-HOT-1112-LEAD-BY-ADDRESS).
 *
 * (1) For every address, the rows equal what the full `GET /orgs/leads?view=basic&sort=activity&status=all`
 *     walk holds for it (crm-service's old read): same row ids, leadIds, campaignIds, disqualification,
 *     company, human, same order among an address's rows: an address with ONE row (a person served
 *     under two campaigns = one deduped row), an address with TWO rows (case variants on two leads,
 *     ordered by activity from delivery evidence, the opposite of serve order), one with NONE.
 * (2) It never creates, refreshes or marks read a read model or a change feed.
 * (3) A lead served after the model was built is answered at once.
 * Siblings are stubbed at their client boundaries only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

let statusByEmail: Record<string, Record<string, unknown>> = {};
vi.mock("../../src/lib/email-gateway-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/email-gateway-client.js")>()),
  checkDeliveryStatus: (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) =>
    Promise.resolve({
      results: items
        .filter((i) => statusByEmail[i.email])
        .map((i) => ({ email: i.email, broadcast: { brand: statusByEmail[i.email] } })),
    }),
}));

let legByCampaign = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-leg-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-leg-client.js")>()),
  fetchOrgCampaignLegs: () => Promise.resolve(legByCampaign),
  fetchOrgCampaignOffers: () => Promise.resolve(new Map([...legByCampaign.keys()].map((id) => [id, null]))),
}));
vi.mock("../../src/lib/reply-verdicts-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/reply-verdicts-client.js")>()),
  fetchReplyVerdicts: () => Promise.resolve([]),
  createReplyVerdictsMemo: () => ({ fetch: () => Promise.resolve([]) }),
}));
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: () => Promise.resolve({ byAudienceId: {}, byEmail: {} }),
  resolveBrandMembershipsByEmail: () => Promise.resolve(new Map()),
}));
vi.mock("../../src/lib/sourcing-origin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sourcing-origin.js")>()),
  loadOriginNamesByList: () => Promise.resolve(new Map()),
}));
vi.mock("../../src/lib/offer-card-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/offer-card-client.js")>()),
  createOfferCardResolver: () => ({ resolve: () => Promise.resolve(new Map()) }),
}));

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns } = await import("../../src/db/schema.js");
const { setDisqualification } = await import("../../src/lib/lead-disqualification.js");
const leadsRoutes = (await import("../../src/routes/leads.js")).default;
const byAddressRoutes = (await import("../../src/routes/leads-by-address.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

type Row = Record<string, unknown> & { id: string; email: string };

describe.skipIf(!hasRealDatabase)("leads by address against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const cA = `itest-bya-a-${tag}`;
  const cB = `itest-bya-b-${tag}`;
  const app = express();
  app.use(express.json());
  app.use(byAddressRoutes);
  app.use(leadsRoutes);
  const made: string[] = [];
  const ann = `ann-${tag}@example.com`;
  const twinUpper = `Twin-${tag}@Example.com`;
  const twinLower = `twin-${tag}@example.com`;
  const nobody = `nobody-${tag}@example.com`;
  const lateComer = `late-${tag}@example.com`;
  let annLead = "";

  async function person(email: string, name: string): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name, lastName: "Test" }).returning({ id: leads.id });
    made.push(row.id);
    await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value: email, source: "itest" });
    return row.id;
  }
  async function serve(leadId: string, campaignId: string, at: string) {
    await db.insert(leadsCampaigns).values({
      leadId, campaignId, orgId, brandIds: [brandId], status: "served", servedAt: new Date(at), createdAt: new Date(at),
    });
  }

  const byAddress = (emails: string[]) =>
    request(app)
      .post(`/internal/brands/${brandId}/leads/by-address`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .send({ emails });

  /** crm-service's old read: the whole list, then the rows whose email equals the address, in order. */
  async function listRowsOf(addresses: string[]): Promise<Map<string, Row[]>> {
    const res = await request(app)
      .get(`/orgs/leads?brandId=${brandId}&view=basic&sort=activity&status=all`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId);
    expect(res.status).toBe(200);
    const out = new Map<string, Row[]>(addresses.map((a) => [a.toLowerCase(), []]));
    for (const row of res.body.leads as Row[]) out.get(row.email.toLowerCase())?.push(row);
    return out;
  }

  const project = (r: Row) => ({
    id: r.id, leadId: r.leadId, campaignId: r.campaignId, disqualification: r.disqualification, company: r.company, human: r.human,
  });

  async function modelsAndFeeds() {
    const models = await sql`SELECT row_to_json(m)::text AS j FROM lead_read_models m WHERE org_id = ${orgId} ORDER BY id`;
    const feeds = await sql`SELECT row_to_json(f)::text AS j FROM lead_change_feeds f WHERE org_id = ${orgId} ORDER BY id`;
    return JSON.stringify([models, feeds]);
  }

  beforeAll(async () => {
    legByCampaign = new Map([[cA, "start_to_conversation"], [cB, "start_to_conversation"]]);
    annLead = await person(ann, "Ann");
    await serve(annLead, cA, "2026-10-01T10:00:00.000Z");
    await serve(annLead, cB, "2026-10-02T10:00:00.000Z");
    await setDisqualification({ orgId, brandId, leadId: annLead, offerId: null, note: "left the role", statedByUserId: "u", leadCampaignId: null });
    // Two leads on case variants of one address: the older serve replied lately, so activity puts it FIRST.
    const older = await person(twinUpper, "TwinOld");
    await serve(older, cA, "2026-09-01T10:00:00.000Z");
    const newer = await person(twinLower, "TwinNew");
    await serve(newer, cB, "2026-10-10T10:00:00.000Z");
    statusByEmail = {
      [twinUpper]: { contacted: true, sent: true, replied: true, firstSentAt: "2026-09-02T00:00:00.000Z", firstRepliedAt: "2026-11-05T00:00:00.000Z" },
    };
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM lead_disqualification_marks WHERE org_id = ${orgId}`;
    await sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_read_models WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_change_feeds WHERE org_id = ${orgId}`;
    if (made.length) await sql`DELETE FROM leads WHERE id = ANY(${made}::uuid[])`;
  });

  it("opens no read model and no change feed", async () => {
    const before = await modelsAndFeeds();
    expect(before).toBe("[[],[]]");
    const res = await byAddress([ann, twinLower, nobody]);
    expect(res.status).toBe(200);
    expect(await modelsAndFeeds()).toBe(before);
  });

  it("answers every address with exactly the list's rows for it, in the list's order", async () => {
    const asked = [ann, twinUpper, nobody, ann.toUpperCase()];
    const res = await byAddress(asked);
    expect(res.status).toBe(200);
    // Lower-cased, de-duplicated, in the order asked; nobody answered with an empty list.
    expect(res.body.addresses.map((a: { email: string }) => a.email)).toEqual([ann, twinLower, nobody]);
    expect(res.body.count).toBe(3);

    const list = await listRowsOf([ann, twinLower, nobody]);
    for (const answer of res.body.addresses as Array<{ email: string; leads: Row[] }>) {
      expect(answer.leads.map(project)).toEqual(list.get(answer.email)!.map(project));
    }
    const byEmail = new Map((res.body.addresses as Array<{ email: string; leads: Row[] }>).map((a) => [a.email, a.leads]));
    expect(byEmail.get(ann)).toHaveLength(1);
    expect(byEmail.get(ann)![0].disqualification).toMatchObject({ note: "left the role" });
    expect(byEmail.get(twinLower)!.map((r) => r.email)).toEqual([twinUpper, twinLower]);
    expect(byEmail.get(nobody)).toEqual([]);
  });

  it("leaves the brand model as the list left it, and sees a lead served after it", async () => {
    await listRowsOf([ann]);
    const before = await modelsAndFeeds();
    expect(before).not.toBe("[[],[]]");

    const late = await person(lateComer, "Late");
    await serve(late, cB, new Date().toISOString());
    const res = await byAddress([lateComer]);
    expect(res.status).toBe(200);
    expect(res.body.addresses[0].leads.map((r: Row) => r.leadId)).toEqual([late]);
    expect(await modelsAndFeeds()).toBe(before);
  });

  it("refuses an unreadable body", async () => {
    expect((await byAddress([])).status).toBe(400);
    expect((await byAddress([""])).status).toBe(400);
  });
});
