/**
 * GET /orgs/campaigns/:campaignId/sourcing-stats against a REAL database: the brand's lead rows,
 * screenings and must-pass declines are read by raw SQL (Bind, arrays, regex subject split), the
 * siblings (campaign-service, features-service catalogue, human-service) are stubbed.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const orgId = randomUUID();
const brandId = randomUUID();
const offerId = randomUUID();
const tag = randomUUID().slice(0, 8);
const SOURCE = `src-${tag}`;
const OUTREACH = `out-${tag}`;
const SIGNALS_AUD = randomUUID();
const LINKEDIN_AUD = randomUUID();
const email = (n: string) => `${n}-${tag}@example.com`;

vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  fetchOrgCampaignRows: async () => [
    { id: SOURCE, brandId, offerId, legKey: "start_to_lead_found", featureSlug: "sourcing-apollo-buying-signals" },
    { id: OUTREACH, brandId, offerId, legKey: "lead_found_to_conversation", featureSlug: "sales-cold-email-outreach" },
    { id: `ln-${tag}`, brandId, offerId, legKey: "start_to_lead_found", featureSlug: "sourcing-linkedin-engagement-signals" },
  ],
}));
vi.mock("../../src/lib/sourcing-origin.js", () => ({
  loadOriginBySlug: async (slug: string) =>
    slug === "sourcing-apollo-buying-signals"
      ? { slug, name: "Apollo Buying Signals", lists: ["apollo_buying_signal"] }
      : { slug, name: "LinkedIn Engagement Signals", lists: ["linkedin_engagement"] },
}));
vi.mock("../../src/lib/audience-client.js", () => ({
  resolveBrandMembershipsByEmail: async (_brand: string, emails: string[]) =>
    new Map(
      emails.map((e) => [
        e,
        e === email("alice")
          ? [
              { audienceId: SIGNALS_AUD, offerId, list: "apollo_buying_signal", provenance: "served", joinedAt: "2026-10-10T09:00:00.000Z" },
              { audienceId: LINKEDIN_AUD, offerId, list: "linkedin_engagement", provenance: "found_taken", joinedAt: "2026-10-11T08:00:00.000Z" },
            ]
          : [],
      ]),
    ),
  resolveAudiencesForBrand: async (_brand: string, keys: { audienceIds: string[] }) => ({
    byAudienceId: Object.fromEntries(keys.audienceIds.map((id) => [id, { id, name: `Audience ${id.slice(0, 4)}`, avatarUrl: null }])),
    byEmail: {},
  }),
}));

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, organizations, leadsOrganizations, candidateScreenings } = await import("../../src/db/schema.js");
const routes = (await import("../../src/routes/source-people.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("sourcing-stats read against a real database", () => {
  const app = express();
  app.use(routes);

  beforeAll(async () => {
    const [alice] = await db.insert(leads).values({ firstName: "Alice", apolloPersonId: `ap-alice-${tag}` }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: alice.id, channel: "email", value: email("alice"), source: "itest" });
    const [org] = await db.insert(organizations).values({ name: "Alice Co", primaryDomain: `alice-${tag}.com` }).returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId: alice.id, organizationId: org.id, current: true });
    await db.insert(leadsCampaigns).values({
      leadId: alice.id,
      campaignId: OUTREACH,
      orgId,
      brandIds: [brandId],
      status: "served",
      servedAt: new Date("2026-10-10T09:00:00.000Z"),
      audienceId: SIGNALS_AUD,
      buyingSignal: { type: "funding", occurredOn: "2026-10-01", fact: "Raised a Series A.", source: "apollo:funding", sourceUrl: null },
    });
    // A served row with no audience: its source cannot be named (gap).
    const [ghost] = await db.insert(leads).values({ firstName: "Ghost" }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: ghost.id, channel: "email", value: email("ghost"), source: "itest" });
    await db.insert(leadsCampaigns).values({ leadId: ghost.id, campaignId: OUTREACH, orgId, brandIds: [brandId], status: "served", servedAt: new Date("2026-10-09T09:00:00.000Z") });

    await db.insert(candidateScreenings).values([
      { orgId, brandId, audienceId: SIGNALS_AUD, providerPersonId: `ap-alice-${tag}`, candidateId: randomUUID(), targetHash: "h", promptVersion: "lead-v1", verdict: "pass", companyDomain: `alice-${tag}.com`, createdAt: new Date("2026-10-10T08:59:00.000Z") },
      { orgId, brandId, audienceId: SIGNALS_AUD, providerPersonId: `ap-dan-${tag}`, candidateId: randomUUID(), targetHash: "h", promptVersion: "lead-v1", verdict: "reject", companyDomain: `dan-${tag}.com`, companyName: "Dan Co", createdAt: new Date("2026-10-10T08:00:00.000Z") },
      { orgId, brandId, audienceId: SIGNALS_AUD, providerPersonId: `ap-eve-${tag}`, candidateId: randomUUID(), targetHash: "h", promptVersion: "lead-v1", verdict: "pass", createdAt: new Date("2026-10-10T08:30:00.000Z") },
    ]);
    const [obs] = await sql<Array<{ id: string }>>`
      INSERT INTO qualification_observations (probe_key, domain, status) VALUES ('company_data', ${`eve-${tag}.com`}, 'ok') RETURNING id`;
    const [verdict] = await sql<Array<{ id: string }>>`
      INSERT INTO qualification_verdicts (criterion_key, domain, observation_id, verdict) VALUES ('k', ${`eve-${tag}.com`}, ${obs.id}, 'no') RETURNING id`;
    await sql`
      INSERT INTO qualification_checks (criterion_id, org_id, brand_id, offer_id, subject, domain, verdict_id)
      VALUES (${randomUUID()}, ${orgId}, ${brandId}, ${offerId}, ${`candidate:${SIGNALS_AUD}:ap-eve-${tag}`}, ${`eve-${tag}.com`}, ${verdict.id})`;
    await sql`UPDATE qualification_checks SET checked_at = '2026-10-10T08:31:00Z' WHERE subject = ${`candidate:${SIGNALS_AUD}:ap-eve-${tag}`}`;
  });

  it("answers the buying-signals source: found, kept, per day, per audience, per signal, gaps", async () => {
    const res = await request(app).get(`/orgs/campaigns/${SOURCE}/sourcing-stats`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body.origin).toEqual({ slug: "sourcing-apollo-buying-signals", name: "Apollo Buying Signals", lists: ["apollo_buying_signal"] });
    expect(res.body.found).toEqual({ people: 3, companies: 3, peopleWithoutCompany: 0 });
    expect(res.body.kept).toMatchObject({ people: 1, companies: 1, byThisSource: 1, viaAnotherSource: 0 });
    expect(res.body.notKept).toEqual({ screened_out: 1, failed_qualification_check: 1, kept_by_another_offer: 0, not_served: 0 });
    expect(res.body.daily).toEqual([{ day: "2026-10-10", found: 3, kept: 1 }]);
    expect(res.body.byAudience).toEqual([
      { audienceId: SIGNALS_AUD, name: `Audience ${SIGNALS_AUD.slice(0, 4)}`, list: "apollo_buying_signal", found: 3, kept: 1, screenedOut: 1 },
    ]);
    expect(res.body.bySignal).toEqual([{ type: "funding", source: "apollo:funding", competitorPage: null, postUrl: null, people: 1 }]);
    expect(res.body.gaps.find((g: { reason: string }) => g.reason === "no_audience").people).toBe(1);
  });

  it("counts the same person in the LinkedIn source too (multi provenance)", async () => {
    const res = await request(app).get(`/orgs/campaigns/ln-${tag}/sourcing-stats`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(res.status).toBe(200);
    expect(res.body.found.people).toBe(1);
    expect(res.body.kept).toMatchObject({ people: 1, byThisSource: 0, viaAnotherSource: 1 });
    expect(res.body.daily).toEqual([{ day: "2026-10-11", found: 1, kept: 1 }]);
  });

  it("refuses a campaign that is not a lead source (409) and one the org does not hold (404)", async () => {
    const notSource = await request(app).get(`/orgs/campaigns/${OUTREACH}/sourcing-stats`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(notSource.status).toBe(409);
    const missing = await request(app).get(`/orgs/campaigns/nope-${tag}/sourcing-stats`).set("x-api-key", "test-api-key").set("x-org-id", orgId);
    expect(missing.status).toBe(404);
  });
});
