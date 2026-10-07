/**
 * Qualification checks against a REAL database: a company is observed and judged ONCE per
 * question, whatever the number of its leads; a second run reuses everything and pays nothing;
 * the lead read serves the stored answer. Vendors are faked at the client boundary (treg meter,
 * chat-service, cloudflare, prices); the SQL is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const tregCalls: Array<{ endpointId: string; params: unknown }> = [];
vi.mock("../../src/lib/treg-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeMeter {
    async call(req: { endpointId: string; params: unknown }) {
      tregCalls.push(req);
      return { status: 200, body: { markdown: "Welcome. Subscribe to our weekly newsletter." }, chargedMicro: 1000, contentType: "application/json" };
    }
  }
  return { ...actual, TregMeter: FakeMeter };
});
const judgeCalls: unknown[] = [];
vi.mock("../../src/lib/qualification-judge.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    judgeYesNo: async (state: unknown) => {
      judgeCalls.push(state);
      return { probabilities: { answerable: 0.95, holds: 0.9 }, model: "jev-1.13.0" };
    },
  };
});
vi.mock("../../src/lib/chat-complete-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, complete: async () => ({ content: "The homepage invites visitors to a weekly newsletter.", json: null, model: "flash-lite", tokensInput: 1, tokensOutput: 1 }) };
});
vi.mock("../../src/lib/price-client.js", () => ({ priceCentsPerUnit: async () => 0.0005 }));

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns, organizations, leadsOrganizations } = await import("../../src/db/schema.js");
const { runCriterionOnLeads, readLeadQualification, recentServedLeadIds, leadsOfBrand } = await import("../../src/lib/qualification-run.js");
const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
const { BUILTIN_PROBES } = await import("../../src/lib/qualification-probes.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("qualification checks, against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const sharedDomain = `shared-${tag}.com`;
  const otherDomain = `other-${tag}.com`;
  const ids: string[] = [];
  const identity = { orgId, userId: randomUUID(), runId: randomUUID(), brandId };
  const criterion = {
    id: randomUUID(),
    orgId,
    brandId,
    question: `Does the company run a newsletter? ${tag}`,
    probe: BUILTIN_PROBES.homepage_text.spec,
    mode: "mention",
    createdByUserId: null,
    createdAt: new Date(),
    archivedAt: null,
  };

  async function seedLead(domain: string, servedAt: Date): Promise<string> {
    const [lead] = await db.insert(leads).values({ firstName: `L-${tag}` }).returning({ id: leads.id });
    const [org] = await db.insert(organizations).values({ name: domain, primaryDomain: domain }).returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId: lead.id, organizationId: org.id, current: true });
    await db.insert(leadsCampaigns).values({ leadId: lead.id, campaignId: `camp-${tag}`, orgId, brandIds: [brandId], status: "served", servedAt });
    return lead.id;
  }

  beforeAll(async () => {
    ids.push(await seedLead(sharedDomain, new Date(Date.now() - 3000)));
    ids.push(await seedLead(sharedDomain, new Date(Date.now() - 2000)));
    ids.push(await seedLead(otherDomain, new Date(Date.now() - 1000)));
  });

  afterAll(async () => {
    tregCalls.length = 0;
  });

  it("picks the brand's latest served leads and recognises its own leads only", async () => {
    expect(await recentServedLeadIds(orgId, brandId, 3)).toEqual([ids[2], ids[1], ids[0]]);
    const owned = await leadsOfBrand(orgId, brandId, [ids[0], randomUUID()]);
    expect([...owned]).toEqual([ids[0]]);
  });

  it("checks each company once: the second lead at the same company is reused and free", async () => {
    const rows = await runCriterionOnLeads(criterion, ids, identity);
    expect(tregCalls.map((c) => (c.params as { url: string }).url).sort()).toEqual([`https://${otherDomain}`, `https://${sharedDomain}`].sort());
    expect(judgeCalls).toHaveLength(2);
    expect(rows.map((r) => [r.domain, r.verdict, r.reused])).toEqual([
      [sharedDomain, "yes", false],
      [sharedDomain, "yes", true],
      [otherDomain, "yes", false],
    ]);
    expect(rows[0].probeCostUsd).toBeGreaterThan(0);
    expect(rows[1].probeCostUsd).toBe(0);
    expect(rows[0].evidence).toBe("The homepage invites visitors to a weekly newsletter.");
  });

  it("a second run on the same companies observes, judges and pays nothing", async () => {
    tregCalls.length = 0;
    judgeCalls.length = 0;
    const rows = await runCriterionOnLeads(criterion, ids, identity);
    expect(tregCalls).toHaveLength(0);
    expect(judgeCalls).toHaveLength(0);
    expect(rows.every((r) => r.reused && r.probeCostUsd === 0)).toBe(true);
  });

  it("the lead read serves the stored answer, and not_checked for a question nobody asked", async () => {
    const lead = (await buildFullLeadsBatch([ids[1]])).get(ids[1])!;
    const other = { ...criterion, id: randomUUID(), question: `Never asked ${tag}` };
    const read = await readLeadQualification(lead, [criterion, other]);
    expect(read.domain).toBe(sharedDomain);
    expect(read.checks.map((c) => c.verdict)).toEqual(["yes", "not_checked"]);
    expect(read.checks[0].evidence).toContain("newsletter");
  });
});
