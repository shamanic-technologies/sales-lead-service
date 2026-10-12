/**
 * Social engagers as leads, against a REAL database (src/lib/social-engagements.ts, social-identity.ts):
 * the facts become people + timeline rows at the brand, a second pass writes nothing, the brand-wide
 * journey read serves them at their step, and a person found LATER by email is the same lead with the
 * engagement still on their timeline (adopted, or folded into the email owner).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const offers = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-leg-client.js", () => ({
  fetchOrgCampaignOffers: vi.fn(async () => offers),
}));
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: vi.fn(async (id: string) =>
    offers.has(id) ? { id, offerId: offers.get(id), featureSlug: "social-post", workflowSlug: "social-post-scheat" } : null,
  ),
}));

const { db, sql } = await import("../../src/db/index.js");
const { leads } = await import("../../src/db/schema.js");
const { ingestSocialEngagements, syncSocialEngagements } = await import("../../src/lib/social-engagements.js");
const { streamBrandJourneys } = await import("../../src/lib/brand-journeys.js");
const { upsertLeadFromPerson, registerServedEmail } = await import("../../src/lib/leads-registry.js");
const { claimStockedLead } = await import("../../src/lib/source-stock.js");
const { loadRetryCandidates } = await import("../../src/lib/retry-pool.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("social engagers as leads against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const offerId = randomUUID();
  const campaignId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  offers.set(campaignId, offerId);

  const memberA = `ACoAAA${tag}A`;
  const memberB = `ACoAAC${tag}B`;
  const vanityA = `george-${tag}`;
  function fact(sourceRef: string, kind: string, person: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return {
      id: randomUUID(), sourceRef, label: "industry_update_video", stepKey: "industry_update_video",
      campaignId, orgId, brandId, socialPostId: null, platform: "linkedin", postId: `urn:li:activity:${tag}`, postUrl: null,
      kind, reactionType: kind === "reaction" ? "LIKE" : null,
      person: { name: null, handle: null, profileUrl: null, urn: null, headline: null, ...person },
      text: null, url: null, occurredAt: kind === "comment" ? "2026-10-12T11:50:32.510Z" : null,
      firstSeenAt: "2026-10-12T16:16:50.958Z", lastSeenAt: "2026-10-12T16:16:50.958Z", ...over,
    };
  }
  // The three facts social-service stored for Kevin's 10:14 LinkedIn post: one person commented and
  // liked (same member key), another liked.
  const george = { key: `linkedin:${memberA}`, name: "Cristian-George Farauanu", headline: "Business Development" };
  const feed = [
    fact(`linkedin:${tag}:comment:c1`, "comment", { ...george, handle: vanityA, profileUrl: `https://www.linkedin.com/in/${vanityA}` }),
    fact(`linkedin:${tag}:reaction:${memberA}`, "reaction", { ...george, handle: memberA, profileUrl: `https://www.linkedin.com/in/${memberA}` }),
    fact(`linkedin:${tag}:reaction:${memberB}`, "reaction", { key: `linkedin:${memberB}`, name: "Alex Jeandel", handle: memberB, profileUrl: `https://www.linkedin.com/in/${memberB}` }),
  ];

  async function leadOf(key: string): Promise<string | null> {
    const rows = (await sql`SELECT lead_id::text AS id FROM lead_contact_methods WHERE channel = 'social' AND value = ${key}`) as unknown as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  }
  async function factsOf(leadId: string): Promise<string[]> {
    const rows = (await sql`SELECT id FROM lead_timeline_facts WHERE lead_id = ${leadId}::uuid AND brand_id = ${brandId} ORDER BY id`) as unknown as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  afterAll(async () => {
    await sql`DELETE FROM lead_timeline_facts WHERE org_id = ${orgId}`;
    await sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`;
  });

  it("files every fact on ONE lead per person; a second pass writes nothing", async () => {
    const first = await ingestSocialEngagements(feed);
    expect(first).toEqual({ received: 3, filed: 3, written: 3, peopleCreated: 2, unscoped: 0, unplaced: 0, foundNow: 2, campaignUnknown: 0 });

    const georgeLead = await leadOf(george.key);
    const alexLead = await leadOf(`linkedin:${memberB}`);
    expect(georgeLead).not.toBeNull();
    expect(alexLead).not.toBe(georgeLead);
    expect(await factsOf(georgeLead!)).toHaveLength(2);
    expect(await factsOf(alexLead!)).toHaveLength(1);
    const [row] = (await sql`
      SELECT label, source, campaign_id, offer_id, attributable, attribution_basis FROM lead_timeline_facts
      WHERE id = ${`social:linkedin:${tag}:comment:c1`}
    `) as unknown as Array<Record<string, unknown>>;
    expect(row).toEqual({ label: "industry_update_video", source: "social", campaign_id: campaignId, offer_id: offerId, attributable: true, attribution_basis: "reaction_to_our_post" });
    const [person] = (await sql`SELECT name, linkedin_url FROM leads WHERE id = ${georgeLead}::uuid`) as unknown as Array<Record<string, unknown>>;
    expect(person).toEqual({ name: "Cristian-George Farauanu", linkedin_url: `https://www.linkedin.com/in/${vanityA}` });

    const second = await ingestSocialEngagements(feed);
    expect(second).toMatchObject({ received: 3, filed: 3, written: 0, peopleCreated: 0, foundNow: 0 });
    expect(await leadOf(george.key)).toBe(georgeLead);
  });

  it("each engager is ONE person the post's campaign found (Leads list), and no email pipe can hand them out", async () => {
    const georgeLead = await leadOf(george.key);
    const rows = (await sql`
      SELECT lead_id::text AS lead_id, status, status_reason, feature_slug, served_at, brand_ids FROM leads_campaigns
      WHERE campaign_id = ${campaignId} ORDER BY served_at
    `) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "served" && r.status_reason === "social_engagement" && r.feature_slug === "social-post")).toBe(true);
    expect(rows.map((r) => r.brand_ids)).toEqual([[brandId], [brandId]]);
    // Dated when the person engaged (the comment), never when we filed it.
    expect(new Date(rows.find((r) => r.lead_id === georgeLead)!.served_at as string).toISOString()).toBe("2026-10-12T11:50:32.510Z");

    // The source stock hands only `source_found` rows, and only to people with an email.
    expect(await claimStockedLead({
      orgId, sourceCampaignIds: [campaignId], outreachCampaignId: randomUUID(), brandIds: [brandId], featureSlug: "sales-cold-email-outreach",
      runId: null, parentRunId: null, userId: null, workflowSlug: null, goal: null, activeGoalId: null, brandProfileId: null,
      askFit: async () => { throw new Error("no engager row may reach the fit check"); },
    } as never)).toEqual({ lead: null, setAside: [] });
    // A campaign asking its own retry pool for these rows gets nobody: every pool demands an email.
    expect(await loadRetryCandidates({ orgId, campaignId, nowMs: Date.now() } as never)).toEqual([]);
  });

  it("a fact with no org or brand yet, or a label the vocabulary lacks, is counted, never written", async () => {
    const r = await ingestSocialEngagements([
      fact(`linkedin:${tag}:reaction:nobrand`, "reaction", { key: `linkedin:nobrand-${tag}` }, { orgId: null, brandId: null }),
      fact(`linkedin:${tag}:reaction:nolabel`, "reaction", { key: `linkedin:nolabel-${tag}` }, { label: "future_step", stepKey: "future_step" }),
    ]);
    expect(r).toMatchObject({ received: 2, filed: 0, written: 0, peopleCreated: 0, unscoped: 1, unplaced: 1, foundNow: 0 });
    expect(await leadOf(`linkedin:nobrand-${tag}`)).toBeNull();
  });

  it("the brand-wide journey read serves them at the step industry_update_video", async () => {
    const journeys = [];
    for await (const chunk of streamBrandJourneys(orgId, brandId, offers, 50)) journeys.push(...chunk);
    expect(journeys).toHaveLength(2);
    for (const j of journeys) {
      expect(j.offerId).toBe(offerId);
      expect(j.facts.every((f) => f.label === "industry_update_video" && f.campaignId === campaignId && f.attributable === true)).toBe(true);
    }
    expect(journeys.map((j) => j.facts.length).sort()).toEqual([1, 2]);
  });

  it("a person served LATER with an email and that LinkedIn profile is the same lead, engagement kept", async () => {
    const georgeLead = await leadOf(george.key);
    const email = `george-${tag}@example.test`;
    const leadId = await upsertLeadFromPerson(
      { provider: "apollo", providerPersonId: `ap-george-${tag}`, email, firstName: "George", lastName: "Farauanu", linkedinUrl: `http://www.linkedin.com/in/${vanityA.toUpperCase()}` } as never,
      { enriched: true },
    );
    expect(leadId).toBe(georgeLead);
    expect(await registerServedEmail({ leadId, email, status: "verified", source: "apollo" })).toBe(georgeLead);
    expect(await factsOf(leadId)).toHaveLength(2);
    const [row] = (await sql`SELECT apollo_person_id FROM leads WHERE id = ${leadId}::uuid`) as unknown as Array<{ apollo_person_id: string }>;
    expect(row.apollo_person_id).toBe(`ap-george-${tag}`);
  });

  it("an engager matching a lead we already hold IS that lead; a later serve folds a stray engager lead into the email owner", async () => {
    // A provider lead we served before, holding an email and a LinkedIn URL.
    const known = `known-${tag}`;
    const [served] = await db.insert(leads).values({ name: "Known Person", linkedinUrl: `http://www.linkedin.com/in/${known}`, apolloPersonId: `ap-known-${tag}` }).returning({ id: leads.id });
    await registerServedEmail({ leadId: served.id, email: `known-${tag}@example.test`, status: null, source: "apollo" });
    await ingestSocialEngagements([fact(`linkedin:${tag}:comment:known`, "comment", { key: `linkedin:known-member-${tag}`, handle: known })]);
    expect(await leadOf(`linkedin:known-member-${tag}`)).toBe(served.id);

    // An email lead with no LinkedIn yet, and an engager lead for the same person.
    const stray = `stray-${tag}`;
    const strayEmail = `stray-${tag}@example.test`;
    const [emailLead] = await db.insert(leads).values({ name: "Stray Person", apolloPersonId: `ap-stray-${tag}` }).returning({ id: leads.id });
    await registerServedEmail({ leadId: emailLead.id, email: strayEmail, status: null, source: "apollo" });
    await ingestSocialEngagements([fact(`linkedin:${tag}:comment:stray`, "comment", { key: `linkedin:stray-member-${tag}`, handle: stray })]);
    const engagerLead = await leadOf(`linkedin:stray-member-${tag}`);
    expect(engagerLead).not.toBe(emailLead.id);

    const leadId = await upsertLeadFromPerson(
      { provider: "apollo", providerPersonId: `ap-stray-${tag}`, email: strayEmail, linkedinUrl: `https://www.linkedin.com/in/${stray}/` } as never,
      { enriched: true },
    );
    expect(leadId).toBe(emailLead.id);
    expect(await leadOf(`linkedin:stray-member-${tag}`)).toBe(emailLead.id);
    expect(await factsOf(emailLead.id)).toEqual([`social:linkedin:${tag}:comment:stray`]);
    const moved = (await sql`SELECT lead_id::text AS id FROM leads_campaigns WHERE campaign_id = ${campaignId} AND lead_id IN (${emailLead.id}::uuid, ${engagerLead}::uuid)`) as unknown as Array<{ id: string }>;
    expect(moved.map((m) => m.id)).toEqual([emailLead.id]);
    const gone = (await sql`SELECT 1 FROM leads WHERE id = ${engagerLead}::uuid`) as unknown as unknown[];
    expect(gone).toHaveLength(0);
  });

  it("the pull reads social-service's feed and files it; an unreadable feed throws", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/internal/social-engagements?since=");
      return new Response(JSON.stringify({ engagements: feed }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await syncSocialEngagements()).toMatchObject({ received: 3, filed: 3, written: 0, peopleCreated: 0 });
      fetchMock.mockImplementationOnce(async () => new Response("down", { status: 503 }));
      await expect(syncSocialEngagements()).rejects.toThrow(/social-service answered 503/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
