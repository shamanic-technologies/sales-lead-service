/**
 * lead-service's own audience-less filings per address, against a REAL database (LEAD-SOURCE-AT-SEND-1016):
 * a CRM signup filing and a social engager filing of (org, brand), and a person the org stated, are each
 * read back by address (case-folded); another org or brand, and an ordinary serve, add nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns, leadContactMethods, brandPersonStatements } = await import("../../src/db/schema.js");
const { loadLocalFilings } = await import("../../src/lib/lead-provenance.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead provenance filings against a real database", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const marie = `marie-${tag}@acme.test`;
  const paul = `paul-${tag}@acme.test`;
  const leadIds: string[] = [];

  beforeAll(async () => {
    const [m] = await db.insert(leads).values({ firstName: "Marie" }).returning({ id: leads.id });
    const [p] = await db.insert(leads).values({ firstName: "Paul" }).returning({ id: leads.id });
    leadIds.push(m.id, p.id);
    await db.insert(leadContactMethods).values([
      { leadId: m.id, channel: "email", value: marie, source: "test" },
      { leadId: p.id, channel: "email", value: paul, source: "test" },
    ]);
    await db.insert(leadsCampaigns).values([
      { leadId: m.id, campaignId: `signups:${brandId}`, orgId, brandIds: [brandId], status: "served", statusReason: "crm_signup", servedAt: new Date("2026-10-01T10:00:00Z") },
      { leadId: m.id, campaignId: `social-${tag}`, orgId, brandIds: [brandId], status: "served", statusReason: "social_engagement" },
      { leadId: p.id, campaignId: `cold-${tag}`, orgId, brandIds: [brandId], status: "served" },
      { leadId: p.id, campaignId: `signups:${brandId}`, orgId: otherOrgId, brandIds: [brandId], status: "served", statusReason: "crm_signup" },
    ]);
    await db.insert(brandPersonStatements).values({
      orgId, brandId, email: paul, source: "trigger_event", sourceRef: `ev-${tag}`, campaignId: `cold-${tag}`,
    });
  });

  afterAll(async () => {
    await db.delete(brandPersonStatements).where(eq(brandPersonStatements.brandId, brandId));
    await db.delete(leadsCampaigns).where(inArray(leadsCampaigns.leadId, leadIds));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  });

  it("reads every filing kind of (org, brand) by address", async () => {
    const out = await loadLocalFilings(orgId, brandId, [marie, paul, `nobody-${tag}@acme.test`]);
    const kinds = (e: string) => (out.get(e) ?? []).map((f) => f.kind).sort();
    expect(kinds(marie)).toEqual(["crm_signup", "social_engagement"]);
    expect(out.get(marie)!.find((f) => f.kind === "crm_signup")!.firstAt).toBe("2026-10-01T10:00:00.000Z");
    expect(kinds(paul)).toEqual(["stated_by_org"]);
    expect(out.has(`nobody-${tag}@acme.test`)).toBe(false);
  });

  it("another org or brand sees none of them", async () => {
    expect((await loadLocalFilings(otherOrgId, brandId, [marie])).size).toBe(0);
    expect((await loadLocalFilings(orgId, randomUUID(), [marie, paul])).size).toBe(0);
  });
});
