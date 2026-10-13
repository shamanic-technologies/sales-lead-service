/**
 * Every tag at its level, against a REAL database (human-service / brand-service mocked at the client):
 *   - LEAD: Disqualified "left the role" on the lead at company A does not show on the same human's
 *     lead at company B;
 *   - COMPANY: Disqualified "not our target" on A covers another lead of A (name-only company keyed on
 *     the local row too), and a sale by one lead makes the company a client;
 *   - HUMAN: an opt-out fact on the human reads on both leads; an opt-out observed on the timeline is
 *     stated on the human once, and withdrawn when the timeline takes it back;
 *   - a lead without employer is at the company its work address names (free mail = none).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";

const stateHumanFact = vi.fn();
const withdrawHumanFact = vi.fn();
const resolveCompanies = vi.fn();
vi.mock("../../src/lib/human-identity-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/human-identity-client.js")>()),
  stateHumanFact: (...a: unknown[]) => stateHumanFact(...a),
  withdrawHumanFact: (...a: unknown[]) => withdrawHumanFact(...a),
}));
vi.mock("../../src/lib/company-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/company-client.js")>()),
  resolveCompanies: (...a: unknown[]) => resolveCompanies(...a),
}));

import { db } from "../../src/db/index.js";
import { leads, leadContactMethods, organizations } from "../../src/db/schema.js";
import {
  listBrandCompanyDisqualifications,
  effectiveLeadOrCompanyMark,
  loadLeadAndCompanyMarks,
  setCompanyDisqualification,
  setDisqualification,
} from "../../src/lib/lead-disqualification.js";
import { companyBlockFor, loadCompanyStatus } from "../../src/lib/company-status.js";
import { loadHumanOptOuts } from "../../src/lib/human-opt-out-read.js";
import { stateObservedOptOuts } from "../../src/lib/human-opt-outs.js";
import { resolveEmailCompanies } from "../../src/lib/lead-identity-sweep.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("tag levels: human / lead / company", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const human = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const made: string[] = [];
  const orgs: string[] = [];

  beforeEach(() => {
    stateHumanFact.mockReset();
    withdrawHumanFact.mockReset();
    resolveCompanies.mockReset();
  });
  afterAll(async () => {
    if (made.length) await db.delete(leads).where(inArray(leads.id, made));
    if (orgs.length) await db.delete(organizations).where(inArray(organizations.id, orgs));
  });

  async function lead(over: Partial<typeof leads.$inferInsert>): Promise<string> {
    const [l] = await db.insert(leads).values({ firstName: "x", ...over }).returning({ id: leads.id });
    made.push(l.id);
    return l.id;
  }

  it("keeps a lead mark on its lead, spreads a company mark to every lead of the company", async () => {
    const atA = await lead({ humanId: human, companyId: companyA, identityResolvedAt: new Date() });
    const atB = await lead({ humanId: human, companyId: companyB, identityResolvedAt: new Date() });
    const colleagueAtA = await lead({ humanId: randomUUID(), companyId: companyA, identityResolvedAt: new Date() });

    await setDisqualification({ orgId, brandId, leadId: atA, offerId: null, note: "left the role", statedByUserId: "u", leadCampaignId: null });
    let m = await loadLeadAndCompanyMarks({ orgId, brandIds: [brandId], leadIds: [atA, atB, colleagueAtA] });
    expect(effectiveLeadOrCompanyMark(m, atA, brandId, null)?.level).toBe("lead");
    expect(effectiveLeadOrCompanyMark(m, atB, brandId, null)).toBeNull();
    expect(effectiveLeadOrCompanyMark(m, colleagueAtA, brandId, null)).toBeNull();

    await setCompanyDisqualification({
      orgId, brandId, companyKey: companyA, offerId: null, note: "not our target", statedByUserId: "u", statedFromLeadId: atA, leadCampaignId: null,
    });
    m = await loadLeadAndCompanyMarks({ orgId, brandIds: [brandId], leadIds: [atA, atB, colleagueAtA] });
    expect(effectiveLeadOrCompanyMark(m, atA, brandId, null)?.level).toBe("lead"); // its own mark answers first
    expect(effectiveLeadOrCompanyMark(m, colleagueAtA, brandId, null)).toMatchObject({ level: "company", note: "not our target" });
    expect(effectiveLeadOrCompanyMark(m, atB, brandId, null)).toBeNull();

    // A sale by the colleague makes company A a client; B is not.
    await db.execute(sql`
      INSERT INTO conversion_events (brand_id, org_id, event, matched_lead_id, match_confidence, attribution_status, source, value_cents)
      VALUES (${brandId}, ${orgId}, 'sale', ${colleagueAtA}::uuid, 'high', 'attributed', 'manual', 1000)`);
    const status = await loadCompanyStatus({ orgId, brandIds: [brandId], companyKeys: [...m.companyKeyOf.values()] });
    expect(companyBlockFor(atA, [brandId], null, m, status)).toMatchObject({ id: companyA, isClient: true, signedUp: false });
    expect(companyBlockFor(atB, [brandId], null, m, status)).toMatchObject({ id: companyB, isClient: false, disqualification: null });
    await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}`);
  });

  it("keys a name-only company on the local row", async () => {
    const [o] = await db.insert(organizations).values({ name: "Constructora BeFco S.A." }).returning({ id: organizations.id });
    orgs.push(o.id);
    const a = await lead({ humanId: randomUUID(), organizationId: o.id });
    const b = await lead({ humanId: randomUUID(), organizationId: o.id });
    await setCompanyDisqualification({
      orgId, brandId, companyKey: `org:${o.id}`, offerId: null, note: null, statedByUserId: "u", statedFromLeadId: a, leadCampaignId: null,
    });
    const m = await loadLeadAndCompanyMarks({ orgId, brandIds: [brandId], leadIds: [b] });
    expect(effectiveLeadOrCompanyMark(m, b, brandId, null)?.level).toBe("company");
    for (const id of [a, b]) {
      await db.execute(sql`INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status)
        VALUES (${id}::uuid, ${`c-${randomUUID()}`}, ${orgId}, ${sql.param([brandId])}::text[], 'served')`);
    }
    const listed = (await listBrandCompanyDisqualifications({ orgId, brandId, offerId: null })).find((c) => c.companyKey === `org:${o.id}`);
    expect(listed).toMatchObject({ companyId: null, leadCount: 2, leadIds: [a, b].sort() });
    await db.execute(sql`DELETE FROM leads_campaigns WHERE lead_id = ANY(${sql.param([a, b])}::uuid[])`);
  });

  it("reads a human opt-out on every lead of the human, through a merge alias", async () => {
    const merged = randomUUID();
    const atA = await lead({ humanId: human, companyId: companyA });
    const atB = await lead({ humanId: human, companyId: companyB });
    const other = await lead({ humanId: randomUUID() });
    await db.execute(sql`INSERT INTO human_aliases (atomic_human_id, human_id, event_id) VALUES (${merged}::uuid, ${human}::uuid, 1)`);
    await db.execute(sql`
      INSERT INTO human_fact_copies (fact_id, human_id, kind, event_id) VALUES (${randomUUID()}::uuid, ${merged}::uuid, 'opt_out', 1)`);
    const out = await loadHumanOptOuts([atA, atB, other]);
    expect(out.has(atA) && out.has(atB)).toBe(true);
    expect(out.has(other)).toBe(false);
  });

  it("states an observed opt-out on the human once, and withdraws it when the timeline takes it back", async () => {
    const h = randomUUID();
    const l = await lead({ humanId: h });
    const factRef = `instantly:${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, occurred_at, label, source, source_ref)
      VALUES (${factRef}, ${orgId}, ${brandId}, ${l}::uuid, now() - interval '1 day', 'unsubscribed', 'outreach', ${factRef})`);
    const factId = randomUUID();
    stateHumanFact.mockResolvedValue({ changed: true, fact: { factId } });
    await stateObservedOptOuts();
    expect(stateHumanFact.mock.calls.filter((c) => c[0] === h)).toHaveLength(1);
    expect(stateHumanFact.mock.calls.find((c) => c[0] === h)![1]).toMatchObject({ kind: "opt_out", statedByOrgId: orgId });
    await stateObservedOptOuts();
    expect(stateHumanFact.mock.calls.filter((c) => c[0] === h)).toHaveLength(1);

    await db.execute(sql`UPDATE lead_timeline_facts SET withdrawn_at = now() WHERE id = ${factRef}`);
    await stateObservedOptOuts();
    expect(withdrawHumanFact).toHaveBeenCalledWith(factId, expect.any(String));
  });

  it("puts a lead without employer at the company its work address names, never a free-mail one", async () => {
    const work = await lead({ humanId: randomUUID(), identityResolvedAt: new Date() });
    const free = await lead({ humanId: randomUUID(), identityResolvedAt: new Date() });
    const tag = randomUUID().slice(0, 8);
    await db.insert(leadContactMethods).values([
      { leadId: work, channel: "email", value: `hello-${tag}@obra.example`, source: "t" },
      { leadId: free, channel: "email", value: `lucas-${tag}@gmail.com`, source: "t" },
    ]);
    const obra = randomUUID();
    resolveCompanies.mockImplementation(async (inputs: Array<{ domain: string }>) =>
      inputs.map((c, index) => ({ index, ref: null, brandId: c.domain === "obra.example" ? obra : randomUUID(), domain: c.domain, matchedBy: "domain", created: false, unresolvedReason: null })),
    );
    await resolveEmailCompanies(100_000);
    const rows = (await db.execute(sql`SELECT id::text, company_id::text, email_company_checked_at FROM leads WHERE id = ANY(${sql.param([work, free])}::uuid[])`)) as unknown as Array<{
      id: string;
      company_id: string | null;
      email_company_checked_at: unknown;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(work)!.company_id).toBe(obra);
    expect(byId.get(free)!.company_id).toBeNull();
    expect(byId.get(free)!.email_company_checked_at).not.toBeNull();
    expect(resolveCompanies.mock.calls.flatMap((c) => c[0] as Array<{ domain: string }>).some((c) => c.domain === "gmail.com")).toBe(false);
  });
});
