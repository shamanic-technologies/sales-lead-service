/**
 * GET /orgs/brands/:brandId/never-cold-contact against a REAL database: a booked meeting, an
 * attended meeting or a sale closes the person to cold outreach by the brand forever; a
 * withdrawn statement, an unattributed row, another brand or another org does not.
 */
import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, conversionEvents, crmFacts } = await import("../../src/db/schema.js");
const routes = (await import("../../src/routes/never-cold-contact.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("never-cold-contact read against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(routes);

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
        event: "meeting_booked",
        matchedLeadId: leadId,
        matchConfidence: "deterministic",
        attributionStatus: "attributed",
        source: "crm",
        receivedAt: new Date("2026-10-07T16:04:20.000Z"),
        ...over,
      })
      .returning({ id: conversionEvents.id });
    return row.id;
  }

  async function crmFact(
    over: Partial<typeof crmFacts.$inferInsert> & { emails: string[]; type: string },
  ): Promise<string> {
    const factId = randomUUID();
    await db.insert(crmFacts).values({
      factId,
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:${over.emails[0] ?? randomUUID()}`,
      fullName: null,
      phones: [],
      occurredAt: new Date("2026-06-18T10:00:00.000Z"),
      dateBasis: "occurred_at",
      source: "posthog",
      sourceRef: `ref-${randomUUID()}`,
      payload: {},
      raw: { itest: true },
      ...over,
    });
    return factId;
  }

  const get = (brand: string, org: string, email?: string) => {
    const q = email === undefined ? "" : `?email=${encodeURIComponent(email)}`;
    return request(app)
      .get(`/orgs/brands/${brand}/never-cold-contact${q}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", org);
  };

  beforeAll(async () => {
    await outcome(await lead("booked", [addr("booked")]), { source: "crm" });
    await outcome(await lead("attended", [addr("attended")]), { event: "meeting_attended", source: "manual" });
    await outcome(await lead("sold", [addr("sold")]), { event: "sale", source: "tracker", receivedAt: null });
    await outcome(await lead("legacy", [addr("legacy")]), { event: "purchase" });
    const both = await lead("both", [addr("both"), `Alias-${tag}@Example.com`]);
    await outcome(both, { event: "meeting_booked", receivedAt: new Date("2025-01-01T00:00:00.000Z") });
    await outcome(both, { event: "sale", source: "manual" });
    // Not closed: withdrawn, unattributed, a step that is not a meeting/sale, another brand/org.
    await outcome(await lead("withdrawn", [addr("withdrawn")]), { withdrawnAt: new Date() });
    await outcome(await lead("review", [addr("review")]), { attributionStatus: "needs_review" });
    await outcome(await lead("signup", [addr("signup")]), { event: "signup" });
    await outcome(await lead("otherbrand", [addr("otherbrand")]), { brandId: otherBrandId });
    await outcome(await lead("otherorg", [addr("otherorg")]), { orgId: otherOrgId });
    // CRM people (lead or not): a signup, a payment closes them; a visit, a withdrawn fact,
    // another brand or org does not.
    await crmFact({ emails: [addr("crmsignup")], type: "signup" });
    await crmFact({ emails: [`CrmPay-${tag}@Example.com`], type: "payment", source: "stripe" });
    await crmFact({ emails: [addr("crmvisit")], type: "website_visit" });
    const pulled = await crmFact({ emails: [addr("crmpulled")], type: "signup" });
    await crmFact({ emails: [addr("crmpulled")], type: "withdrawn", withdrawnOf: pulled });
    await crmFact({ emails: [addr("crmotherbrand")], type: "signup", brandId: otherBrandId });
    await crmFact({ emails: [addr("crmotherorg")], type: "signup", orgId: otherOrgId });
  }, 60_000);

  it("closes a person the brand's CRM shows signed up or paying, lead or not", async () => {
    const res = await get(brandId, orgId);
    expect(res.status).toBe(200);
    expect(res.body.emails).toContain(addr("crmsignup"));
    expect(res.body.emails).toContain(`crmpay-${tag}@example.com`);
    for (const name of ["crmvisit", "crmpulled", "crmotherbrand", "crmotherorg"]) {
      expect(res.body.emails).not.toContain(addr(name));
    }
    const signup = res.body.crmPeople.find((p: { emails: string[] }) => p.emails.includes(addr("crmsignup")));
    expect(signup).toMatchObject({ types: ["signup"], sources: ["posthog"], firstAt: "2026-06-18T10:00:00.000Z" });
    for (const name of ["crmsignup", "crmpay"]) {
      const one = name === "crmsignup" ? addr(name) : `CRMPAY-${tag}@example.com`;
      const r = await get(brandId, orgId, one);
      expect(r.body.emails).toEqual([one.toLowerCase()]);
      expect(r.body.leads).toEqual([]);
    }
    for (const name of ["crmvisit", "crmpulled", "crmotherbrand"]) {
      expect((await get(brandId, orgId, addr(name))).body).toMatchObject({ emails: [], leads: [], crmPeople: [] });
    }
  });

  it("lists booked, attended and sale, whoever observed them", async () => {
    const res = await get(brandId, orgId);
    expect(res.status).toBe(200);
    expect(res.body.emails.filter((e: string) => !e.startsWith("crm"))).toEqual(
      [addr("booked"), addr("attended"), addr("sold"), addr("legacy"), addr("both"), `alias-${tag}@example.com`].sort(),
    );
    const byLead = new Map(res.body.leads.map((l: { leadId: string }) => [l.leadId, l]));
    expect(byLead.size).toBe(5);
    expect(byLead.get(ids.booked)).toMatchObject({ steps: ["meeting_booked"], sources: ["crm"], firstAt: "2026-10-07T16:04:20.000Z" });
    expect(byLead.get(ids.attended)).toMatchObject({ steps: ["meeting_attended"], sources: ["manual"] });
    expect(byLead.get(ids.sold)).toMatchObject({ steps: ["sale"], sources: ["tracker"], firstAt: null });
    expect(byLead.get(ids.legacy)).toMatchObject({ steps: ["sale"] });
    expect(byLead.get(ids.both)).toMatchObject({
      steps: ["meeting_booked", "sale"],
      sources: ["crm", "manual"],
      firstAt: "2025-01-01T00:00:00.000Z",
    });
  });

  it("the one-address check agrees with the set", async () => {
    const all = (await get(brandId, orgId)).body.emails as string[];
    for (const email of all) {
      const res = await get(brandId, orgId, email.toUpperCase());
      expect(res.body.emails).toEqual([email]);
      expect(res.body.leads.length + res.body.crmPeople.length).toBe(1);
    }
    for (const name of ["withdrawn", "review", "signup", "otherbrand", "otherorg", "nobody"]) {
      const res = await get(brandId, orgId, addr(name));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ emails: [], leads: [] });
    }
  });

  it("another brand of the same org is not closed by this brand's meetings", async () => {
    expect((await get(otherBrandId, orgId)).body.emails).toEqual([addr("crmotherbrand"), addr("otherbrand")]);
  });

  it("withdrawing the booked statement drops the person on the next read", async () => {
    const id = await lead("changedmind", [addr("changedmind")]);
    const eventId = await outcome(id, { source: "manual" });
    expect((await get(brandId, orgId, addr("changedmind"))).body.emails).toEqual([addr("changedmind")]);
    const { eq } = await import("drizzle-orm");
    await db.update(conversionEvents).set({ withdrawnAt: new Date() }).where(eq(conversionEvents.id, eventId));
    expect((await get(brandId, orgId, addr("changedmind"))).body.emails).toEqual([]);
    expect((await get(brandId, orgId)).body.emails).not.toContain(addr("changedmind"));
  });
});
