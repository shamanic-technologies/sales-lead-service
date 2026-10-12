import { describe, it, expect, vi, afterEach } from "vitest";

// LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): which mode a buffer/next is (src/lib/source-mode.ts), the audiences a
// source unit's own run walks (src/lib/source-audiences.ts), and the fleet leads-found read (src/lib/source-leads-found.ts).

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
  BILLING_SERVICE_URL: "http://billing",
  BILLING_SERVICE_API_KEY: "billing-key",
  HUMAN_SERVICE_URL: "http://human",
  HUMAN_SERVICE_API_KEY: "human-key",
  FEATURES_SERVICE_URL: "http://features",
}));

const ownRunRows: Array<Record<string, unknown>> = [];
vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn(async () => ownRunRows) } }));

const ORG = "org-1";
const OUTREACH = "outreach-1";
const UNIT = "unit-1";
const COLD = "sourcing-apollo-cold-filters";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sourcesRead(entries: Array<Record<string, unknown>>) {
  return { campaignId: OUTREACH, orgId: ORG, offerId: "offer-1", featureSlug: "sales-cold-email-outreach", sourced: true, sourceCampaigns: entries };
}

function stubFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const hit = routes[url];
      if (!hit) throw new Error(`unexpected ${url}`);
      return hit();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ownRunRows.length = 0;
});

describe("decideSourceMode", () => {
  it("runsOnItsOwn ABSENT on every source: today's serve, the read handed on (byte-identical)", async () => {
    const read = sourcesRead([{ featureSlug: COLD, campaignId: UNIT, running: true, status: "ongoing", campaignKey: "k" }]);
    const calls = stubFetch({ [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () => json(read) });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    const mode = await decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: "sales-cold-email-outreach" });
    expect(mode.kind).toBe("today");
    expect(mode.kind === "today" && mode.read?.sourceCampaigns).toEqual([{ featureSlug: COLD, campaignId: UNIT, running: true, runsOnItsOwn: false }]);
    // An outreach slug is never asked whether it is a source unit.
    expect(calls).toEqual([`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]);
  });

  it("runsOnItsOwn false: today's serve", async () => {
    stubFetch({ [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () => json(sourcesRead([{ featureSlug: COLD, campaignId: UNIT, running: true, runsOnItsOwn: false }])) });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    expect((await decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: "sales-cold-email-outreach" })).kind).toBe("today");
  });

  it("a RUNNING source that runs on its own: stock mode over the running own-run sources only", async () => {
    stubFetch({
      [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () =>
        json(
          sourcesRead([
            { featureSlug: COLD, campaignId: UNIT, running: true, runsOnItsOwn: true },
            { featureSlug: "sourcing-apollo-buying-signals", campaignId: "unit-off", running: false, runsOnItsOwn: true },
            { featureSlug: "sourcing-linkedin-engagement-signals", campaignId: "unit-od", running: true, runsOnItsOwn: false },
          ]),
        ),
    });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    const mode = await decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: "sales-cold-email-outreach" });
    expect(mode.kind).toBe("stock");
    expect(mode.kind === "stock" && mode.sourceCampaignIds).toEqual([UNIT]);
  });

  it("an own-run source that is stopped does not switch the outreach campaign to stock", async () => {
    stubFetch({ [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () => json(sourcesRead([{ featureSlug: COLD, campaignId: UNIT, running: false, runsOnItsOwn: true }])) });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    expect((await decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: "sales-cold-email-outreach" })).kind).toBe("today");
  });

  it("x-campaign-id IS a source unit (leg start_to_lead_found): own run, whatever origin (homogeneous)", async () => {
    for (const slug of [COLD, "sourcing-crm-contacts", "lead-sourcing"]) {
      stubFetch({
        [`http://campaign/campaigns/${UNIT}`]: () =>
          json({ campaign: { id: UNIT, featureSlug: slug, legKey: "start_to_lead_found", offerId: "offer-1", brandIds: ["brand-1"], status: "ongoing" } }),
      });
      const { decideSourceMode } = await import("../../src/lib/source-mode.js");
      const mode = await decideSourceMode({ orgId: ORG, campaignId: UNIT, featureSlug: slug });
      expect(mode).toEqual({ kind: "own_run", unit: { id: UNIT, featureSlug: slug, offerId: "offer-1", brandId: "brand-1", status: "ongoing", audienceIds: null } });
    }
  });

  it("a source unit carries its campaign's targeted audienceIds; empty = none stated; unreadable throws", async () => {
    const unitRow = (audienceIds: unknown) => () =>
      json({ campaign: { id: UNIT, featureSlug: COLD, legKey: "start_to_lead_found", offerId: "offer-1", brandIds: ["brand-1"], status: "ongoing", audienceIds } });
    const { fetchSourceUnit } = await import("../../src/lib/source-mode.js");
    stubFetch({ [`http://campaign/campaigns/${UNIT}`]: unitRow(["a-1", "a-1", "a-2"]) });
    expect((await fetchSourceUnit(UNIT, ORG))?.audienceIds).toEqual(["a-1", "a-2"]);
    stubFetch({ [`http://campaign/campaigns/${UNIT}`]: unitRow([]) });
    expect((await fetchSourceUnit(UNIT, ORG))?.audienceIds).toBeNull();
    stubFetch({ [`http://campaign/campaigns/${UNIT}`]: unitRow(null) });
    expect((await fetchSourceUnit(UNIT, ORG))?.audienceIds).toBeNull();
    stubFetch({ [`http://campaign/campaigns/${UNIT}`]: unitRow("a-1") });
    await expect(fetchSourceUnit(UNIT, ORG)).rejects.toThrow(/unreadable audienceIds/);
  });

  it("a sourcing-shaped slug on a campaign that is NOT a source falls back to the outreach read", async () => {
    stubFetch({
      [`http://campaign/campaigns/${OUTREACH}`]: () => json({ campaign: { id: OUTREACH, featureSlug: COLD, legKey: "lead_found_to_conversation", offerId: "offer-1", status: "ongoing" } }),
      [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () => json(sourcesRead([])),
    });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    expect((await decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: COLD })).kind).toBe("today");
  });

  it("an unreadable campaign-service answer throws (the serve fails before anything is bought)", async () => {
    stubFetch({ [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () => json({ error: "x" }, 503) });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    await expect(decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: "sales-cold-email-outreach" })).rejects.toThrow(/source-campaigns read failed/);
  });

  it("a non-boolean runsOnItsOwn is unreadable, never read as true or false", async () => {
    stubFetch({ [`http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`]: () => json(sourcesRead([{ featureSlug: COLD, campaignId: UNIT, running: true, runsOnItsOwn: "yes" }])) });
    const { decideSourceMode } = await import("../../src/lib/source-mode.js");
    await expect(decideSourceMode({ orgId: ORG, campaignId: OUTREACH, featureSlug: "sales-cold-email-outreach" })).rejects.toThrow(/runsOnItsOwn unreadable/);
  });
});

describe("resolveSourceAudiences", () => {
  const list = `http://human/orgs/audiences?brandId=brand-1&offerId=offer-1&status=active&limit=200&offset=0`;
  const origin = (id: string) => `http://human/orgs/audiences/${id}/sourcing-origin`;

  it("keeps the brand's active audiences of the offer human-service serves from THIS origin, most people left first", async () => {
    stubFetch({
      [list]: () =>
        json({
          audiences: [
            { id: "a-small", availableToContactCount: 10 },
            { id: "a-signal", availableToContactCount: 900 },
            { id: "a-big", availableToContactCount: 500 },
            { id: "a-unknown" },
          ],
          total: 4,
        }),
      [origin("a-small")]: () => json({ audienceId: "a-small", list: "apollo_search", sourcingFeatureSlug: COLD }),
      [origin("a-signal")]: () => json({ audienceId: "a-signal", list: "apollo_buying_signal", sourcingFeatureSlug: "sourcing-apollo-buying-signals" }),
      [origin("a-big")]: () => json({ audienceId: "a-big", list: "apollo_search", sourcingFeatureSlug: COLD }),
      [origin("a-unknown")]: () => json({ audienceId: "a-unknown", list: "apollo_search", sourcingFeatureSlug: COLD }),
    });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    const got = await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: null, targetAudienceIds: null });
    expect(got).toEqual({ kind: "walk", audienceIds: ["a-big", "a-small", "a-unknown"] });
  });

  it("the audience the caller named goes first when it is one of them", async () => {
    stubFetch({
      [list]: () => json({ audiences: [{ id: "a-1", availableToContactCount: 900 }, { id: "a-2", availableToContactCount: 1 }], total: 2 }),
      [origin("a-1")]: () => json({ sourcingFeatureSlug: COLD }),
      [origin("a-2")]: () => json({ sourcingFeatureSlug: COLD }),
    });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    expect(await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: "a-2", targetAudienceIds: null })).toEqual({ kind: "walk", audienceIds: ["a-2", "a-1"] });
  });

  it("Lead Sourcing walks the audiences of the origins human-service CHOSE for the brand", async () => {
    stubFetch({
      [list]: () => json({ audiences: [{ id: "a-cold", availableToContactCount: 5 }, { id: "a-sig", availableToContactCount: 9 }], total: 2 }),
      [`http://human/orgs/lead-sourcing/sources?brandId=brand-1&offerId=offer-1`]: () => json({ chosenOriginSlugs: ["sourcing-apollo-buying-signals"] }),
      [origin("a-cold")]: () => json({ sourcingFeatureSlug: COLD }),
      [origin("a-sig")]: () => json({ sourcingFeatureSlug: "sourcing-apollo-buying-signals" }),
    });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    expect(await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: "lead-sourcing", preferredAudienceId: null, targetAudienceIds: null })).toEqual({ kind: "walk", audienceIds: ["a-sig"] });
  });

  it("an audience serving from no list (422) is left out", async () => {
    stubFetch({
      [list]: () => json({ audiences: [{ id: "a-1", availableToContactCount: 5 }], total: 1 }),
      [origin("a-1")]: () => json({ error: "no committed provider" }, 422),
    });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    expect(await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: null, targetAudienceIds: null })).toEqual({ kind: "walk", audienceIds: [] });
  });

  it("a unit whose campaign targets [A] on an offer holding active A and B walks only A; without targets it walks A and B", async () => {
    const routes = {
      [list]: () => json({ audiences: [{ id: "a-A", availableToContactCount: 5 }, { id: "a-B", availableToContactCount: 900 }], total: 2 }),
      [origin("a-A")]: () => json({ sourcingFeatureSlug: "sourcing-crm-contacts" }),
      [origin("a-B")]: () => json({ sourcingFeatureSlug: "sourcing-crm-contacts" }),
    };
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    const base = { orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: "sourcing-crm-contacts", preferredAudienceId: null };
    const calls = stubFetch(routes);
    expect(await resolveSourceAudiences({ ...base, targetAudienceIds: ["a-A"] })).toEqual({ kind: "walk", audienceIds: ["a-A"] });
    // B is never even asked about: the targeting is a hard subset.
    expect(calls).not.toContain(origin("a-B"));
    stubFetch(routes);
    expect(await resolveSourceAudiences({ ...base, targetAudienceIds: null })).toEqual({ kind: "walk", audienceIds: ["a-B", "a-A"] });
  });

  it("a named audience outside the targets is not walked", async () => {
    stubFetch({
      [list]: () => json({ audiences: [{ id: "a-A", availableToContactCount: 5 }, { id: "a-B", availableToContactCount: 900 }], total: 2 }),
      [origin("a-A")]: () => json({ sourcingFeatureSlug: COLD }),
    });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    expect(await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: "a-B", targetAudienceIds: ["a-A"] })).toEqual({
      kind: "walk",
      audienceIds: ["a-A"],
    });
  });

  it("targeted audiences none of which is served under the unit's channel: targets_unavailable, never a fallback to the others", async () => {
    stubFetch({
      [list]: () => json({ audiences: [{ id: "a-A", availableToContactCount: 5 }, { id: "a-B", availableToContactCount: 900 }], total: 2 }),
      [origin("a-A")]: () => json({ sourcingFeatureSlug: "sourcing-apollo-buying-signals" }),
    });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    const got = await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: null, targetAudienceIds: ["a-A"] });
    expect(got.kind).toBe("targets_unavailable");
  });

  it("targeted audiences that are not active audiences of the offer: targets_unavailable", async () => {
    stubFetch({ [list]: () => json({ audiences: [{ id: "a-B", availableToContactCount: 900 }], total: 1 }) });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    const got = await resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: null, targetAudienceIds: ["a-gone"] });
    expect(got).toEqual({ kind: "targets_unavailable", detail: expect.stringMatching(/not active audiences/) });
  });

  it("an unreadable audience list throws", async () => {
    stubFetch({ [list]: () => json({ error: "down" }, 500) });
    const { resolveSourceAudiences } = await import("../../src/lib/source-audiences.js");
    await expect(resolveSourceAudiences({ orgId: ORG, brandId: "brand-1", offerId: "offer-1", unitSlug: COLD, preferredAudienceId: null, targetAudienceIds: null })).rejects.toThrow(/audience list failed/);
  });
});

describe("readSourceLeadsFound", () => {
  const ranCounts = (t: string) => `http://campaign/internal/trigger-events/ran-counts?triggerId=${t}`;

  it("per source campaign: on-demand finds (both trigger names) + own-run finds, never twice, first/last over both", async () => {
    stubFetch({
      [ranCounts("on_demand")]: () =>
        json({ triggerId: "on_demand", recordedSince: "2026-10-11T19:57:29.301Z", counts: [{ campaignId: UNIT, ran: 4, firstAt: "2026-10-11T20:00:00.000Z", lastAt: "2026-10-12T09:00:00.000Z" }] }),
      [ranCounts("lead_requested")]: () =>
        json({
          triggerId: "lead_requested",
          recordedSince: "2026-10-09T15:49:36.675Z",
          counts: [
            { campaignId: UNIT, ran: 2, firstAt: "2026-10-09T18:00:00.000Z", lastAt: "2026-10-10T18:00:00.000Z" },
            { campaignId: "unit-2", ran: 1, firstAt: "2026-10-10T01:00:00.000Z", lastAt: "2026-10-10T01:00:00.000Z" },
          ],
        }),
    });
    ownRunRows.push({ campaign_id: UNIT, found: "3", first_at: "2026-10-12 10:00:00+00", last_at: "2026-10-12 12:00:00+00" });
    ownRunRows.push({ campaign_id: "unit-3", found: 1, first_at: "2026-10-12 11:00:00+00", last_at: "2026-10-12 11:00:00+00" });
    const { readSourceLeadsFound } = await import("../../src/lib/source-leads-found.js");
    const got = await readSourceLeadsFound();
    expect(got.recordedSince).toBe("2026-10-09T15:49:36.675Z");
    expect(got.modes).toEqual({
      onDemand: { triggerIds: ["on_demand", "lead_requested"], recordedSince: "2026-10-09T15:49:36.675Z" },
      ownRuns: { recordedSince: "2026-10-12T00:00:00.000Z" },
    });
    expect(got.counts).toEqual([
      { campaignId: UNIT, found: 9, onDemand: 6, ownRuns: 3, firstAt: "2026-10-09T18:00:00.000Z", lastAt: "2026-10-12T12:00:00.000Z" },
      { campaignId: "unit-2", found: 1, onDemand: 1, ownRuns: 0, firstAt: "2026-10-10T01:00:00.000Z", lastAt: "2026-10-10T01:00:00.000Z" },
      { campaignId: "unit-3", found: 1, onDemand: 0, ownRuns: 1, firstAt: "2026-10-12T11:00:00.000Z", lastAt: "2026-10-12T11:00:00.000Z" },
    ]);
  });

  it("campaign-service unreadable = LeadsFoundUnavailableError, never a partial count", async () => {
    stubFetch({ [ranCounts("on_demand")]: () => json({ error: "x" }, 500), [ranCounts("lead_requested")]: () => json({ counts: [] }) });
    const { readSourceLeadsFound, LeadsFoundUnavailableError } = await import("../../src/lib/source-leads-found.js");
    await expect(readSourceLeadsFound()).rejects.toBeInstanceOf(LeadsFoundUnavailableError);
  });
});
