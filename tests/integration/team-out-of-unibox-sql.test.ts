/**
 * TEAM-OUT-OF-UNIBOX-1017 against a REAL database: a member of the org owning the brand (and a +tag variant of a
 * member's address) is its TEAM: never a Unibox row of its brands (a row built before is removed on the next refresh)
 * and never filed as a lead by the brand's own intakes; a person with a similar address is someone else and stays.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const catalogue = {
  object: "step",
  lifecycleLadder: [{ key: "lead_found", rank: 1, label: "Lead found" }],
  rows: [{ key: "lead_found", lifecycleRank: 1 }],
};
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    if (String(url).endsWith("/public/catalogue/steps")) {
      return new Response(JSON.stringify(catalogue), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  },
}));

const { db } = await import("../../src/db/index.js");
const { clearRegistry, connectionTag } = await import("../helpers/crm-registry.js");
const { setTestOrgMembers, clearTestOrgMembers } = await import("../helpers/org-members.js");
const { refreshSubjects } = await import("../../src/lib/relationship-subjects.js");
const { refreshUniboxRows, readUniboxPage, readUniboxLead, resetLifecycleCatalogueCache } = await import("../../src/lib/unibox-model.js");
const { fileBrandIntakePerson } = await import("../../src/lib/brand-signups.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("the org's team is out of its Unibox and never a lead", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const t = randomUUID().slice(0, 8);
  const memberAddress = `kevin.lourd.${t}@example.com`;
  const people = {
    member: { human: randomUUID(), email: memberAddress },
    plusTag: { human: randomUUID(), email: `kevin.lourd.${t}+dougs@example.com` },
    similar: { human: randomUUID(), email: `kevin.lourdes.${t}@example.com` },
    prospect: { human: randomUUID(), email: `ana.${t}@acme.io` },
  };
  const createdLeads: string[] = [];

  afterAll(async () => {
    clearTestOrgMembers();
    await clearRegistry(orgId);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    for (const tb of ["crm_facts", "relationship_subjects", "unibox_rows"]) await db.execute(sql`DELETE FROM ${sql.raw(tb)} WHERE org_id = ${orgId}`);
  });

  it("a member and a +tag variant leave the Unibox (rows built before included); a similar address and a prospect stay", async () => {
    resetLifecycleCatalogueCache();
    for (const [k, p] of Object.entries(people)) {
      await connectionTag({ orgId, brandId, human: p.human, personKey: `email:${p.email}`, name: k, emails: [p.email] });
    }
    await refreshSubjects(scope);

    // Before the org states its team: everyone is a row.
    clearTestOrgMembers();
    await refreshUniboxRows(scope);
    const before = await readUniboxPage(scope, {}, { limit: 50, cursor: null });
    expect(before.total).toBe(4);

    setTestOrgMembers(orgId, [memberAddress.toUpperCase()]);
    const built = await refreshUniboxRows(scope);
    expect(built.teamMembers).toBe(2);
    const after = await readUniboxPage(scope, {}, { limit: 50, cursor: null });
    expect(after.total).toBe(2);
    expect(after.rows.map((r) => r.humanId).sort()).toEqual([people.similar.human, people.prospect.human].sort());
    expect(await readUniboxLead(scope, people.member.human)).toBeNull();
    expect(await readUniboxLead(scope, people.plusTag.human)).toBeNull();
    expect(await readUniboxLead(scope, people.prospect.human)).not.toBeNull();

    // Another brand of the same org: its team too.
    const otherBrand = { orgId, brandId: randomUUID() };
    await connectionTag({ orgId, brandId: otherBrand.brandId, human: people.member.human, personKey: `email:${memberAddress}`, emails: [memberAddress] });
    await refreshSubjects(otherBrand);
    await refreshUniboxRows(otherBrand);
    expect((await readUniboxPage(otherBrand, {}, { limit: 50, cursor: null })).total).toBe(0);
  });

  it("the brand's intake never files a member (nor a +tag variant); a similar address is filed", async () => {
    setTestOrgMembers(orgId, [memberAddress]);
    const intake = { orgId, brandId, fullName: null, at: null, campaignId: `signups:${brandId}`, source: "crm_signup" };
    expect(await fileBrandIntakePerson({ ...intake, email: memberAddress })).toEqual({ status: "team_member" });
    expect(await fileBrandIntakePerson({ ...intake, email: people.plusTag.email })).toEqual({ status: "team_member" });
    const rows = (await db.execute(sql`
      SELECT 1 FROM lead_contact_methods m JOIN leads_campaigns lc ON lc.lead_id = m.lead_id
      WHERE lc.org_id = ${orgId} AND lower(m.value) = ANY(${sql.param([memberAddress, people.plusTag.email])}::text[])
    `)) as unknown as unknown[];
    expect(rows).toHaveLength(0);

    const filed = await fileBrandIntakePerson({ ...intake, email: people.similar.email });
    expect(filed.status).toBe("filed");
    if (filed.status === "filed") createdLeads.push(filed.leadId);
  });
});
