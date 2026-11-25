/**
 * BRAND-PROOF-LOGOS-1121 against a REAL database: who a brand's paying clients are (ledger + CRM payments that stand),
 * the roles held on every lead of each client's human, and the read's empty answers.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

// The fill's treg calls are answered by the test (no key-service, runs-service or billing): `tregAnswer` decides.
const treg = vi.hoisted(() => ({
  calls: [] as Array<{ endpointId: string; params: Record<string, unknown>; routeExclude?: readonly string[] }>,
  answer: (_req: { endpointId: string; params: Record<string, unknown> }) => ({ status: 500, body: { detail: "boom" } as unknown, chargedMicro: 0 }),
}));
vi.mock("../../src/lib/treg-client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/treg-client.js")>();
  class TregMeter {
    constructor(_identity: unknown) {}
    async call(req: { endpointId: string; params: Record<string, unknown>; routeExclude?: readonly string[] }) {
      treg.calls.push(req);
      return { ...treg.answer(req), contentType: "application/json" };
    }
  }
  return { ...real, TregMeter };
});

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, conversionEvents, crmFacts, leadsCampaigns, organizations, leadsOrganizations } = await import(
  "../../src/db/schema.js"
);
const { PEOPLE_FACTS_FEED } = await import("../../src/lib/crm-fact-feed.js");
const { loadPayingClients, LOOKUP_VERSION } = await import("../../src/lib/client-past-employers-read.js");
const { setTestOrgMembers } = await import("../helpers/org-members.js");
const routes = (await import("../../src/routes/client-past-employers.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("client past employers against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const emptyBrandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(routes);
  const addr = (name: string) => `${name}-${tag}@example.com`;
  const ids: Record<string, string> = {};

  async function lead(name: string, emails: string[], humanId: string | null = null, ofBrand = true): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: name, humanId }).returning({ id: leads.id });
    for (const value of emails) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value, source: "itest" });
    if (ofBrand) await db.insert(leadsCampaigns).values({ leadId: row.id, campaignId: randomUUID(), orgId, brandIds: [brandId], status: "served" });
    ids[name] = row.id;
    return row.id;
  }

  async function role(leadId: string, orgName: string, current: boolean, startDate: string | null): Promise<void> {
    const [o] = await db.insert(organizations).values({ name: `${orgName}-${tag}` }).returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId, organizationId: o.id, title: "Head", current, startDate });
  }

  async function payment(email: string, payload: Record<string, unknown>, type = "payment"): Promise<string> {
    const factId = randomUUID();
    await db.insert(crmFacts).values({
      factId, seq: BigInt(Math.floor(Math.random() * 1e15)), orgId, brandId, personKey: `email:${email}`, fullName: null,
      emails: [email], phones: [], type, occurredAt: new Date("2026-10-14T10:00:00.000Z"), dateBasis: "created_at",
      source: "stripe", sourceRef: `ref-${randomUUID()}`, payload, raw: { itest: true },
    });
    return factId;
  }

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, '0', now())
      ON CONFLICT (feed) DO UPDATE SET caught_up_at = COALESCE(crm_feed_cursors.caught_up_at, now())`);
  });

  beforeAll(async () => {
    const human = randomUUID();
    // Ledger payer, whose PAST role sits on another lead of the same human (a job change).
    await lead("ledger", [addr("ledger")], human);
    await lead("ledger-old-job", [addr("ledger-old")], human, false);
    await role(ids["ledger-old-job"], "Acme", false, "2019-01-01");
    await role(ids.ledger, "Globex", true, "2022-03-01");
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", matchedLeadId: ids.ledger, matchConfidence: "deterministic", attributionStatus: "attributed",
      source: "manual", receivedAt: new Date("2026-05-12T16:03:36.845Z"),
    });
    // CRM payer (case differs), also worked at Acme.
    await lead("crm", [addr("crm")]);
    await role(ids.crm, "Acme", false, "2018-01-01");
    // Acme for both: the same organization row (name key).
    await db.execute(sql`UPDATE leads_organizations SET organization_id = (
      SELECT organization_id FROM leads_organizations WHERE lead_id = ${ids["ledger-old-job"]}::uuid LIMIT 1)
      WHERE lead_id = ${ids.crm}::uuid`);
    await payment(addr("crm").toUpperCase(), { status: "succeeded", amountMinor: 9900, amountRefunded: 0, currency: "usd" });
    // Payer with no history yet.
    await lead("nohistory", [addr("nohistory")]);
    await payment(addr("nohistory"), { status: "succeeded", amountMinor: 100 });
    // Not payers: refunded, failed, withdrawn sale, a staff address, not of the brand.
    await lead("refunded", [addr("refunded")]);
    await payment(addr("refunded"), { status: "succeeded", amountMinor: 100, amountRefunded: 100 });
    await lead("failed", [addr("failed")]);
    await payment(addr("failed"), { status: "failed", amountMinor: 100 });
    await lead("withdrawn", [addr("withdrawn")]);
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", matchedLeadId: ids.withdrawn, matchConfidence: "deterministic", attributionStatus: "attributed",
      source: "manual", receivedAt: new Date(), withdrawnAt: new Date(),
    });
    await lead("staff", [`kevin+${tag}@distribute.you`]);
    await payment(`kevin+${tag}@distribute.you`, { status: "succeeded", amountMinor: 100 });
    await lead("stranger", [addr("stranger")], null, false);
    await payment(addr("stranger"), { status: "succeeded", amountMinor: 100 });
    // One PERSON paying through two leads = one client, held by the lead that paid first.
    const twice = randomUUID();
    await lead("twice-late", [addr("twice-late")], twice);
    await payment(addr("twice-late"), { status: "succeeded", amountMinor: 100 });
    await lead("twice-early", [addr("twice-early")], twice);
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", matchedLeadId: ids["twice-early"], matchConfidence: "deterministic", attributionStatus: "attributed",
      source: "manual", receivedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    // A payer whose OTHER lead holds a staff address is us (staff tests never count).
    const staffHuman = randomUUID();
    await lead("staff-human", [addr("staff-human")], staffHuman);
    await payment(addr("staff-human"), { status: "succeeded", amountMinor: 100 });
    await lead("staff-human-other", [`kevin.lourd+${tag}@gmail.com`], staffHuman, false);
  });

  it("names exactly the paying clients", async () => {
    const clients = await loadPayingClients(orgId, brandId);
    expect(clients.map((c) => c.leadId).sort()).toEqual([ids.ledger, ids.crm, ids.nohistory, ids["twice-early"]].sort());
  });

  it("answers the companies with their trace, every lead of the human counted", async () => {
    const res = await request(app).get(`/internal/brands/${brandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body.payingClients).toBe(4);
    expect(res.body.clientsWithHistory).toBe(2);
    expect(res.body.reason).toBeNull();
    const acme = res.body.companies.find((c: { name: string }) => c.name === `Acme-${tag}`);
    expect(acme.clientCount).toBe(2);
    expect(acme.clients.map((c: { leadId: string }) => c.leadId).sort()).toEqual([ids.ledger, ids.crm].sort());
    expect(res.body.companies[0].name).toBe(`Acme-${tag}`);
    const globex = res.body.companies.find((c: { name: string }) => c.name === `Globex-${tag}`);
    expect(globex.currentForSome).toBe(true);
    const nohistory = res.body.clients.find((c: { leadId: string }) => c.leadId === ids.nohistory);
    expect(nohistory.history).toBe("not_looked_up");
  });

  it("a brand with no paying client answers empty with a reason", async () => {
    const res = await request(app).get(`/internal/brands/${emptyBrandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payingClients: 0, companies: [], reason: "no_paying_clients" });
  });

  it("the fill door refuses without the caller's run", async () => {
    const res = await request(app).post(`/internal/brands/${brandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(400);
  });

  it("a treg call that failed records nothing (asked again next call); a real miss records no_linkedin", async () => {
    const lookupOf = async (leadId: string) =>
      (await db.execute(sql`SELECT status FROM client_history_lookups WHERE lead_id = ${leadId}::uuid`)) as unknown as Array<{ status: string }>;
    const post = () =>
      request(app).post(`/internal/brands/${brandId}/client-past-employers`)
        .set("x-api-key", "test-api-key").set("x-org-id", orgId).set("x-run-id", randomUUID()).set("x-user-id", randomUUID());

    for (const failure of [500, 402, 400, 401, 202]) {
      treg.calls.length = 0;
      treg.answer = () => ({ status: failure, body: { detail: "refused" }, chargedMicro: 0 });
      const res = await post();
      expect(res.status).toBe(200);
      expect(res.body.lookups).toMatchObject({ attempted: 2, failed: 2, remaining: 2, noLinkedin: 0 });
      expect(await lookupOf(ids.nohistory)).toEqual([]);
      expect(treg.calls.every((c) => c.routeExclude?.includes("apollo"))).toBe(true);
    }

    treg.calls.length = 0;
    treg.answer = () => ({ status: 200, body: { output: { linkedin_url: null }, _treg: { served_by: null, outcome: "miss", tried: [] } }, chargedMicro: 0 });
    const res = await post();
    expect(res.body.lookups).toMatchObject({ attempted: 2, failed: 0, noLinkedin: 2, remaining: 0 });
    expect(await lookupOf(ids.nohistory)).toEqual([{ status: "no_linkedin" }]);
    const nohistory = res.body.clients.find((c: { leadId: string }) => c.leadId === ids.nohistory);
    expect(nohistory.history).toBe("looked_up_none");
  });

  it("each employer of a career carries the LinkedIn company page its entry names; same name, other page = its own row", async () => {
    const lead = await (async () => {
      const [row] = await db.insert(leads).values({ firstName: "career", linkedinUrl: `https://www.linkedin.com/in/career-${tag}` }).returning({ id: leads.id });
      await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value: addr("career"), source: "itest" });
      await db.insert(leadsCampaigns).values({ leadId: row.id, campaignId: randomUUID(), orgId, brandIds: [brandId], status: "served" });
      return row.id;
    })();
    await payment(addr("career"), { status: "succeeded", amountMinor: 100 });
    // Another company of the same NAME already holds its own page: a name never identifies it.
    await db.insert(organizations).values({ name: `Arketi-${tag}`, linkedinUrl: `https://www.linkedin.com/company/other-arketi-${tag}/` });
    treg.answer = (req) =>
      req.endpointId === "treg.linkedin.user.profile"
        ? {
            status: 200,
            chargedMicro: 1_500,
            body: {
              raw: { experiences: [
                { company: { name: `Google-${tag}`, url: `https://www.linkedin.com/company/google-${tag}/` }, jobTitle: "PM", timePeriod: { startDate: { year: 2012, month: 1 }, endDate: { year: 2016, month: 5 } } },
                { company: { name: `Arketi-${tag}`, url: `https://www.linkedin.com/company/arketi-${tag}` }, jobTitle: "VP", current: true, timePeriod: { startDate: { year: 2020, month: 3 } } },
                { company: { name: `NameOnly-${tag}` }, jobTitle: "Intern", timePeriod: { startDate: { year: 2010, month: 6 } } },
              ] },
              _treg: { served_by: "fetchinio.linkedin.user.profile", tried: [{ endpoint_id: "fetchinio.linkedin.user.profile", provider: "fetchinio", outcome: "hit" }] },
            },
          }
        : { status: 200, chargedMicro: 0, body: { output: {}, _treg: { served_by: null, tried: [] } } };
    const res = await request(app).post(`/internal/brands/${brandId}/client-past-employers`)
      .set("x-api-key", "test-api-key").set("x-org-id", orgId).set("x-run-id", randomUUID()).set("x-user-id", randomUUID());
    expect(res.status).toBe(200);
    const mine = res.body.companies.filter((c: { clients: Array<{ leadId: string }> }) => c.clients.some((x) => x.leadId === lead));
    const byName = Object.fromEntries(mine.map((c: { name: string; linkedinUrl: string | null; companyKey: string }) => [c.name, c]));
    expect(byName[`Google-${tag}`].linkedinUrl).toBe(`https://www.linkedin.com/company/google-${tag}/`);
    expect(byName[`Google-${tag}`].companyKey).toBe(`linkedin:https://www.linkedin.com/company/google-${tag}/`);
    expect(byName[`Arketi-${tag}`].linkedinUrl).toBe(`https://www.linkedin.com/company/arketi-${tag}/`);
    expect(byName[`NameOnly-${tag}`].linkedinUrl).toBeNull();
    const other = (await db.execute(sql`SELECT linkedin_url FROM organizations WHERE name = ${`Arketi-${tag}`} ORDER BY linkedin_url`)) as unknown as Array<{ linkedin_url: string }>;
    expect(other.map((o) => o.linkedin_url)).toEqual([`https://www.linkedin.com/company/arketi-${tag}/`, `https://www.linkedin.com/company/other-arketi-${tag}/`]);
    const stored = (await db.execute(sql`SELECT status, version FROM client_history_lookups WHERE lead_id = ${lead}::uuid`)) as unknown as Array<{ status: string; version: number }>;
    expect(stored).toEqual([{ status: "history_found", version: LOOKUP_VERSION }]);
  });

  it("one payer under two addresses (one paid fact naming both) is ONE client; a payer known by phone alone is looked up by phone; one with nothing is attempted and recorded", async () => {
    const brand2 = randomUUID();
    const mk = async (name: string, emails: string[], phone: string | null): Promise<string> => {
      const [row] = await db.insert(leads).values({ firstName: name, humanId: randomUUID() }).returning({ id: leads.id });
      for (const value of emails) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value, source: "itest" });
      if (phone) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "phone", value: phone, source: "itest" });
      await db.insert(leadsCampaigns).values({ leadId: row.id, campaignId: randomUUID(), orgId, brandIds: [brand2], status: "served" });
      return row.id;
    };
    const a = await mk("two-a", [addr("two-a")], null);
    const b = await mk("two-b", [addr("two-b")], null);
    await db.insert(crmFacts).values({
      factId: randomUUID(), seq: BigInt(Math.floor(Math.random() * 1e15)), orgId, brandId: brand2, personKey: `email:${addr("two-a")}`, fullName: null,
      emails: [addr("two-a"), addr("two-b")], phones: [], type: "payment", occurredAt: new Date("2026-06-13T23:01:17.000Z"), dateBasis: "created_at",
      source: "stripe", sourceRef: `ref-${randomUUID()}`, payload: { status: "succeeded", amountMinor: 100 }, raw: { itest: true },
    });
    const phoneOnly = await mk("phone-only", [], `+1647555${tag.replace(/\D/g, "0").slice(0, 4).padEnd(4, "0")}`);
    const nothing = await mk("nothing", [], null);
    for (const leadId of [phoneOnly, nothing]) {
      await db.insert(conversionEvents).values({
        orgId, brandId: brand2, event: "sale", matchedLeadId: leadId, matchConfidence: "deterministic", attributionStatus: "attributed",
        source: "manual", receivedAt: new Date("2026-09-28T12:00:00.000Z"),
      });
    }

    const clients = await loadPayingClients(orgId, brand2);
    expect(clients).toHaveLength(3);
    const two = clients.find((c) => c.memberLeadIds.length === 2);
    expect(two?.memberLeadIds).toEqual([a, b].sort());

    treg.calls.length = 0;
    treg.answer = () => ({ status: 200, body: { found: false, person: null, output: { linkedin_url: null }, _treg: { served_by: null, outcome: "miss", tried: [] } }, chargedMicro: 0 });
    const res = await request(app).post(`/internal/brands/${brand2}/client-past-employers`)
      .set("x-api-key", "test-api-key").set("x-org-id", orgId).set("x-run-id", randomUUID()).set("x-user-id", randomUUID());
    expect(res.status).toBe(200);
    expect(res.body.payingClients).toBe(3);
    expect(res.body.lookups).toMatchObject({ attempted: 3, failed: 0, noLinkedin: 2, noIdentifier: 1, remaining: 0 });
    expect(treg.calls.filter((c) => c.endpointId === "blitzapi.people.phone.reverse")).toHaveLength(1);
    const byLead = new Map(res.body.clients.map((c: { leadId: string; lookup: { status: string } | null; history: string }) => [c.leadId, c]));
    expect((byLead.get(nothing) as { lookup: { status: string } }).lookup.status).toBe("no_identifier");
    expect((byLead.get(phoneOnly) as { lookup: { status: string } }).lookup.status).toBe("no_linkedin");
    expect(res.body.clients.every((c: { history: string }) => c.history !== "not_looked_up")).toBe(true);
  });
});

describe.skipIf(!hasRealDatabase)("the brand's own TEAM is a source of past employers (TEAM-PAST-EMPLOYERS-1125)", () => {
  const tag = randomUUID().slice(0, 8);
  const app = express();
  app.use(routes);
  const get = (orgId: string, brandId: string) =>
    request(app).get(`/internal/brands/${brandId}/client-past-employers`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
  const post = (orgId: string, brandId: string) =>
    request(app).post(`/internal/brands/${brandId}/client-past-employers`)
      .set("x-api-key", "test-api-key").set("x-org-id", orgId).set("x-run-id", randomUUID()).set("x-user-id", randomUUID());

  async function person(emails: string[], employers: string[], served?: { orgId: string; brandId: string }): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: "p" }).returning({ id: leads.id });
    for (const value of emails) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value, source: "itest" });
    if (served) await db.insert(leadsCampaigns).values({ leadId: row.id, campaignId: randomUUID(), orgId: served.orgId, brandIds: [served.brandId], status: "served" });
    for (const name of employers) {
      const [o] = await db.insert(organizations).values({ name: `${name}-${tag}`, primaryDomain: `${name.toLowerCase()}-${tag}.com` }).returning({ id: organizations.id });
      await db.insert(leadsOrganizations).values({ leadId: row.id, organizationId: o.id, title: "Consultant", current: false, startDate: "2015-01-01" });
    }
    return row.id;
  }
  async function sale(orgId: string, brandId: string, leadId: string): Promise<void> {
    await db.insert(conversionEvents).values({
      orgId, brandId, event: "sale", matchedLeadId: leadId, matchConfidence: "deterministic", attributionStatus: "attributed",
      source: "manual", receivedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  }

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, '0', now())
      ON CONFLICT (feed) DO UPDATE SET caught_up_at = COALESCE(crm_feed_cursors.caught_up_at, now())`);
  });

  it("our own org (staff only): the founder is team, never a payer, and their past employers come back with role team", async () => {
    const orgId = randomUUID();
    const brandId = randomUUID();
    const founder = `kevin.lourd+founder${tag}@gmail.com`;
    setTestOrgMembers(orgId, [{ email: founder, firstName: "Kevin", lastName: "Lourd" }, { email: `kevin.lourd+audit${tag}@gmail.com` }, { email: null }]);
    const lead = await person([founder], ["Bain", "EY"], { orgId, brandId });
    await sale(orgId, brandId, lead); // a staff test purchase never makes the founder a paying client
    const res = await get(orgId, brandId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payingClients: 0, clientsWithHistory: 0, teamMembers: 1, teamWithHistory: 1, reason: null });
    const bain = res.body.companies.find((c: { name: string }) => c.name === `Bain-${tag}`);
    expect(bain).toMatchObject({ clientCount: 1, payingClientCount: 0, teamCount: 1, domain: `bain-${tag}.com` });
    expect(bain.clients).toEqual([expect.objectContaining({ leadId: lead, role: "team", title: "Consultant" })]);
    expect(res.body.clients).toEqual([expect.objectContaining({ leadId: lead, role: "team", paidAt: null, history: "has_history" })]);
  });

  it("a client's org: staff invited there are not its team; its own member is; its payers keep their answer", async () => {
    const orgId = randomUUID();
    const brandId = randomUUID();
    setTestOrgMembers(orgId, [{ email: `kevin.lourd+client${tag}@gmail.com` }, { email: `founder-${tag}@client.example` }]);
    await person([`kevin.lourd+client${tag}@gmail.com`], ["StaffCo"]);
    const member = await person([`founder-${tag}@client.example`], ["Globex"]); // no lead of the brand: team all the same
    const payer = await person([`payer-${tag}@example.com`], ["Initech"], { orgId, brandId });
    await sale(orgId, brandId, payer);
    const res = await get(orgId, brandId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payingClients: 1, clientsWithHistory: 1, teamMembers: 1, teamWithHistory: 1 });
    const names = res.body.companies.map((c: { name: string }) => c.name);
    expect(names).toContain(`Globex-${tag}`);
    expect(names).toContain(`Initech-${tag}`);
    expect(names).not.toContain(`StaffCo-${tag}`);
    expect(res.body.companies.find((c: { name: string }) => c.name === `Initech-${tag}`).clients).toEqual([
      expect.objectContaining({ leadId: payer, role: "paying_client" }),
    ]);
    expect(res.body.companies.find((c: { name: string }) => c.name === `Globex-${tag}`).clients).toEqual([
      expect.objectContaining({ leadId: member, role: "team" }),
    ]);
  });

  it("a member who also paid is team only (team wins)", async () => {
    const orgId = randomUUID();
    const brandId = randomUUID();
    setTestOrgMembers(orgId, [{ email: `cofounder-${tag}@co.example` }]);
    const lead = await person([`cofounder-${tag}@co.example`], ["Hooli"], { orgId, brandId });
    await sale(orgId, brandId, lead);
    const res = await get(orgId, brandId);
    expect(res.body).toMatchObject({ payingClients: 0, teamMembers: 1 });
    expect(res.body.companies[0].clients).toEqual([expect.objectContaining({ leadId: lead, role: "team" })]);
  });

  it("a member no lead holds: the read lists them without a lead, the fill gives them one (never a lead of any brand) and looks them up", async () => {
    const orgId = randomUUID();
    const brandId = randomUUID();
    const email = `newmember-${tag}@team.example`;
    setTestOrgMembers(orgId, [{ email, firstName: "New", lastName: "Member" }]);
    const read = await get(orgId, brandId);
    expect(read.body).toMatchObject({ payingClients: 0, teamMembers: 1, reason: "no_employment_history", companies: [] });
    expect(read.body.clients).toEqual([expect.objectContaining({ leadId: null, role: "team", history: "not_looked_up" })]);

    treg.calls.length = 0;
    treg.answer = () => ({ status: 200, body: { output: { linkedin_url: null }, _treg: { served_by: null, outcome: "miss", tried: [] } }, chargedMicro: 0 });
    const res = await post(orgId, brandId);
    expect(res.status).toBe(200);
    expect(res.body.lookups).toMatchObject({ attempted: 1, noLinkedin: 1, failed: 0 });
    const held = (await db.execute(sql`
      SELECT cm.lead_id::text AS lead_id, l.first_name, l.last_name,
        (SELECT count(*)::int FROM leads_campaigns lc WHERE lc.lead_id = cm.lead_id) AS rows
      FROM lead_contact_methods cm JOIN leads l ON l.id = cm.lead_id WHERE cm.channel = 'email' AND cm.value = ${email}
    `)) as unknown as Array<{ lead_id: string; first_name: string | null; last_name: string | null; rows: number }>;
    expect(held).toEqual([{ lead_id: expect.any(String), first_name: "New", last_name: "Member", rows: 0 }]);
    expect(res.body.clients).toEqual([expect.objectContaining({ leadId: held[0].lead_id, role: "team", history: "looked_up_none" })]);
    expect(treg.calls.every((c) => c.routeExclude?.includes("apollo"))).toBe(true);
  });

  it("a paying-client brand with no team keeps its answer", async () => {
    const orgId = randomUUID();
    const brandId = randomUUID();
    const payer = await person([`solo-${tag}@example.com`], ["Umbrella"], { orgId, brandId });
    await sale(orgId, brandId, payer);
    const res = await get(orgId, brandId);
    expect(res.body).toMatchObject({ payingClients: 1, clientsWithHistory: 1, teamMembers: 0, teamWithHistory: 0, reason: null, companyCount: 1 });
  });
});
