/**
 * GET /orgs/brands/:brandId/won-leads against a REAL database. A mocked `sql` compiles none of
 * the statement (the array bind, the lateral email aggregation, the EXISTS narrowing), so the
 * definition of "won" is proven here, on the rows every other outcome read already counts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, conversionEvents } = await import("../../src/db/schema.js");
const wonLeadsRoutes = (await import("../../src/routes/won-leads.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("won-leads read against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(wonLeadsRoutes);

  const addr = (name: string) => `${name}-${tag}@example.com`;
  const ids: Record<string, string> = {};

  async function lead(name: string, emails: string[]): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name }).returning({ id: leads.id });
    for (const value of emails) {
      await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value, source: "itest" });
    }
    ids[name] = row.id;
    return row.id;
  }

  async function outcome(
    leadId: string,
    over: Partial<typeof conversionEvents.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(conversionEvents)
      .values({
        orgId,
        brandId,
        event: "sale",
        matchedLeadId: leadId,
        matchConfidence: "deterministic",
        attributionStatus: "attributed",
        source: "manual",
        receivedAt: new Date("2026-05-12T16:03:36.845Z"),
        ...over,
      })
      .returning({ id: conversionEvents.id });
    return row.id;
  }

  const get = (brand: string, org: string, email?: string) => {
    const q = email === undefined ? "" : `?email=${encodeURIComponent(email)}`;
    return request(app)
      .get(`/orgs/brands/${brand}/won-leads${q}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", org);
  };

  beforeAll(async () => {
    // Won three ways, plus a legacy spelling; one of them known under two addresses.
    await outcome(await lead("stated", [addr("stated"), `Alias-${tag}@Example.com`]), { source: "manual" });
    await outcome(await lead("tracked", [addr("tracked")]), { source: "tracker" });
    await outcome(await lead("crm", [addr("crm")]), { source: "crm", receivedAt: null });
    await outcome(await lead("legacy", [addr("legacy")]), { event: "purchase" });
    // Not won: a withdrawn sale, an unattributed sale, a meeting, and a sale for ANOTHER brand
    // and for ANOTHER org on the same brand.
    await outcome(await lead("withdrawn", [addr("withdrawn")]), { withdrawnAt: new Date() });
    await outcome(await lead("review", [addr("review")]), { attributionStatus: "needs_review" });
    await outcome(await lead("meeting", [addr("meeting")]), { event: "meeting_booked" });
    await outcome(await lead("otherbrand", [addr("otherbrand")]), { brandId: otherBrandId });
    await outcome(await lead("otherorg", [addr("otherorg")]), { orgId: otherOrgId });
  }, 60_000);

  it("answers every live, attributed sale of the (org, brand), whoever observed it", async () => {
    const res = await get(brandId, orgId);
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual(
      [addr("crm"), addr("legacy"), addr("stated"), addr("tracked"), `alias-${tag}@example.com`].sort(),
    );
    const byLead = new Map(res.body.wonLeads.map((l: { leadId: string }) => [l.leadId, l]));
    expect(byLead.size).toBe(4);
    expect(byLead.get(ids.stated)).toMatchObject({
      emails: [`alias-${tag}@example.com`, addr("stated")].sort(),
      wonAt: "2026-05-12T16:03:36.845Z",
      sources: ["manual"],
    });
    expect(byLead.get(ids.crm)).toMatchObject({ wonAt: null, sources: ["crm"] });
    expect(byLead.get(ids.tracked)).toMatchObject({ sources: ["tracker"] });
  });

  it("the one-address check agrees with the set, case-insensitively and on either address", async () => {
    const all = (await get(brandId, orgId)).body.emails as string[];
    for (const email of all) {
      const res = await get(brandId, orgId, email.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.body.emails).toEqual([email]);
      expect(res.body.wonLeads).toHaveLength(1);
    }
    for (const name of ["withdrawn", "review", "meeting", "otherbrand", "otherorg", "nobody"]) {
      const res = await get(brandId, orgId, addr(name));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ emails: [], wonLeads: [] });
    }
  });

  it("another brand of the same org never won them", async () => {
    const res = await get(otherBrandId, orgId);
    expect(res.body.emails).toEqual([addr("otherbrand")]);
    expect((await get(otherBrandId, orgId, addr("stated"))).body.emails).toEqual([]);
  });

  it("withdrawing the sale statement removes the person on the next read", async () => {
    const id = await lead("changedmind", [addr("changedmind")]);
    const eventId = await outcome(id);
    expect((await get(brandId, orgId, addr("changedmind"))).body.emails).toEqual([addr("changedmind")]);
    const { eq } = await import("drizzle-orm");
    await db.update(conversionEvents).set({ withdrawnAt: new Date() }).where(eq(conversionEvents.id, eventId));
    expect((await get(brandId, orgId, addr("changedmind"))).body.emails).toEqual([]);
    expect((await get(brandId, orgId)).body.emails).not.toContain(addr("changedmind"));
  });
});
