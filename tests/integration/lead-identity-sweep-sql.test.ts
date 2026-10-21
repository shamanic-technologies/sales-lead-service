/**
 * The identity sweep against a REAL database (human-service and brand-service mocked at the client):
 * the current employer resolved once, a name-only employer left NULL with its reason, firmographics
 * written once and again only when the row changes, every lead given its human and its company, a lead
 * waiting while its employer is unresolved, a key human-service refuses leaving the lead without a
 * human, and the read-model triggers never fired.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";

const resolveHuman = vi.fn();
const resolveCompanies = vi.fn();
const writeCompanyFacts = vi.fn();
vi.mock("../../src/lib/human-identity-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/human-identity-client.js")>()),
  resolveHuman: (...a: unknown[]) => resolveHuman(...a),
}));
// The brand card the relationship judge reads (LEADS-JUDGE-BRAND-1021): a brand with no active offer here.
vi.mock("../../src/lib/brand-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-client.js")>()),
  getActiveOffers: async () => [],
}));
vi.mock("../../src/lib/company-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/company-client.js")>()),
  resolveCompanies: (...a: unknown[]) => resolveCompanies(...a),
  writeCompanyFacts: (...a: unknown[]) => writeCompanyFacts(...a),
}));

import { db } from "../../src/db/index.js";
import { leads, leadContactMethods, leadsOrganizations, organizations } from "../../src/db/schema.js";
import { pushEmployerFacts, resolveEmployers, resolveLeads } from "../../src/lib/lead-identity-sweep.js";
import { HumanIdentityError } from "../../src/lib/human-identity-client.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead identity sweep", () => {
  const tag = randomUUID().slice(0, 8);
  const companyA = randomUUID();
  const humanOf = new Map<string, string>();
  const leadIds: string[] = [];
  const orgIds: string[] = [];

  beforeEach(() => {
    resolveHuman.mockReset();
    resolveCompanies.mockReset();
    writeCompanyFacts.mockReset();
    resolveCompanies.mockImplementation(async (inputs: Array<{ ref: string; domain: string | null }>) =>
      inputs.map((c, index) => ({
        index,
        ref: c.ref,
        brandId: c.domain === `${tag}-a.com` ? companyA : null,
        domain: c.domain,
        matchedBy: c.domain ? "domain" : null,
        created: false,
        unresolvedReason: c.domain ? null : "no_safe_identity",
      })),
    );
    writeCompanyFacts.mockResolvedValue({ written: 1, skippedAbsent: 0, keptNewer: 0 });
    resolveHuman.mockImplementation(async (k: { emails?: string[] }) => {
      const email = k.emails?.[0] ?? "none";
      if (email.startsWith("bad")) throw new HumanIdentityError("400 bad key", 400);
      if (!humanOf.has(email)) humanOf.set(email, randomUUID());
      return { humanId: humanOf.get(email)!, atomicHumanId: null, created: true, mergedHumanIds: [], separatedHumanIds: [] };
    });
  });

  async function org(name: string, domain: string | null): Promise<string> {
    const [o] = await db.insert(organizations).values({ name, primaryDomain: domain, industry: "x" }).returning({ id: organizations.id });
    orgIds.push(o.id);
    return o.id;
  }
  async function lead(email: string, orgId: string | null): Promise<string> {
    const [l] = await db.insert(leads).values({ firstName: email }).returning({ id: leads.id });
    leadIds.push(l.id);
    await db.insert(leadContactMethods).values({ leadId: l.id, channel: "email", value: email, source: "test" });
    if (orgId) await db.insert(leadsOrganizations).values({ leadId: l.id, organizationId: orgId, current: true });
    return l.id;
  }
  const leadRow = async (id: string) =>
    ((await db.execute(sql`SELECT human_id::text, company_id::text, identity_resolved_at FROM leads WHERE id = ${id}`)) as unknown as Array<{
      human_id: string | null;
      company_id: string | null;
      identity_resolved_at: Date | null;
    }>)[0];

  afterAll(async () => {
    if (leadIds.length) await db.delete(leads).where(inArray(leads.id, leadIds));
    if (orgIds.length) await db.delete(organizations).where(inArray(organizations.id, orgIds));
  });

  it("resolves employers, writes their facts once, then gives every lead its human and company", async () => {
    const a = await org("A", `${tag}-a.com`);
    const nameOnly = await org(`NameOnly ${tag}`, null);
    const l1 = await lead(`one-${tag}@a.com`, a);
    const l2 = await lead(`two-${tag}@gmail.com`, nameOnly);
    const l3 = await lead(`three-${tag}@x.com`, null);
    const lBad = await lead(`bad-${tag}@x.com`, null);

    // Before the employers are resolved, the leads working there wait; the employer-less ones go.
    await resolveLeads(10_000);
    expect((await leadRow(l1)).identity_resolved_at).toBeNull();
    expect((await leadRow(l3)).human_id).not.toBeNull();

    await resolveEmployers(1000);
    const [ra] = (await db.execute(sql`SELECT company_id::text, company_unresolved_reason FROM organizations WHERE id = ${a}`)) as unknown as Array<{ company_id: string; company_unresolved_reason: string | null }>;
    expect(ra).toEqual({ company_id: companyA, company_unresolved_reason: null });
    const [rn] = (await db.execute(sql`SELECT company_id, company_unresolved_reason FROM organizations WHERE id = ${nameOnly}`)) as unknown as Array<{ company_id: string | null; company_unresolved_reason: string }>;
    expect(rn).toEqual({ company_id: null, company_unresolved_reason: "no_safe_identity" });

    await pushEmployerFacts(1000);
    const pushedFor = writeCompanyFacts.mock.calls.flatMap((c) => (c[0] as Array<{ brandId: string; facts: Record<string, unknown> }>));
    expect(pushedFor.find((w) => w.brandId === companyA)?.facts).toMatchObject({ name: "A", industry: "x" });
    writeCompanyFacts.mockClear();
    await pushEmployerFacts(1000);
    expect(writeCompanyFacts.mock.calls.flatMap((c) => c[0] as Array<{ brandId: string }>).some((w) => w.brandId === companyA)).toBe(false);
    // The row changes: its facts are written again.
    await db.execute(sql`UPDATE organizations SET industry = 'y', updated_at = now() + interval '1 second' WHERE id = ${a}`);
    await pushEmployerFacts(1000);
    expect(writeCompanyFacts.mock.calls.flatMap((c) => c[0] as Array<{ brandId: string }>).some((w) => w.brandId === companyA)).toBe(true);

    const changesBefore = (await db.execute(sql`SELECT count(*)::int AS n FROM lead_read_changes WHERE lead_id = ANY(${sql.param([l1, l2])}::uuid[])`)) as unknown as Array<{ n: number }>;
    await resolveLeads(10_000);
    const r1 = await leadRow(l1);
    expect(r1.human_id).toBe(humanOf.get(`one-${tag}@a.com`));
    expect(r1.company_id).toBe(companyA);
    const r2 = await leadRow(l2);
    expect(r2.human_id).not.toBeNull();
    expect(r2.company_id).toBeNull();
    expect(r2.identity_resolved_at).not.toBeNull();
    const rb = await leadRow(lBad);
    expect(rb.human_id).toBeNull();
    expect(rb.identity_resolved_at).not.toBeNull();
    const changesAfter = (await db.execute(sql`SELECT count(*)::int AS n FROM lead_read_changes WHERE lead_id = ANY(${sql.param([l1, l2])}::uuid[])`)) as unknown as Array<{ n: number }>;
    expect(changesAfter[0].n).toBe(changesBefore[0].n);

    // Idempotent: nothing left for these leads.
    resolveHuman.mockClear();
    await resolveLeads(10_000);
    expect(resolveHuman.mock.calls.some((c) => (c[0] as { emails?: string[] }).emails?.[0]?.includes(tag))).toBe(false);
  });

  it("leaves a lead pending (retried) when human-service is unreachable", async () => {
    const l = await lead(`down-${tag}@x.com`, null);
    resolveHuman.mockRejectedValue(new HumanIdentityError("503", 503));
    const r = await resolveLeads(10_000);
    expect(r.failed).toBeGreaterThan(0);
    expect((await leadRow(l)).identity_resolved_at).toBeNull();
  });
});
