import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";

// A lead ROW carries the offer it belongs to, with its name — the customer dashboard's detail panel
// names it above the audience, and joining it in the browser (fetch the org's campaigns, map
// campaign to offer, match on the lead's campaign) is the client-side join the audience column was
// already fixed away from. The resolution is the one the offer FILTER established: a lead's offer is
// the offer named by the campaign it was served under, i.e. the frozen `campaign_id` on its row.

let mockRows: Array<Record<string, unknown>> = [];
let mockSqlChunkIndex = 0;

vi.mock("../../src/db/index.js", () => ({
  sql: (_strings: readonly string[], ..._values: unknown[]) => ({
    then: (resolve: (rows: unknown[]) => void) => {
      const start = mockSqlChunkIndex * 500;
      mockSqlChunkIndex += 1;
      return Promise.resolve(mockRows.slice(start, start + 500)).then(resolve);
    },
    cursor: (size: number) => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < mockRows.length; i += size) yield mockRows.slice(i, i + size);
      },
    }),
  }),
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: (ids: string[]) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [
          id,
          {
            leadId: id,
            contacts: [{ channel: "email", value: `${id}@example.com`, status: "valid", source: "apollo" }],
          },
        ]),
      ),
    ),
}));

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: () => Promise.resolve({ results: [] }),
}));

vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (id: string) => Promise.resolve([id]),
}));

vi.mock("../../src/lib/offer-campaigns-client.js", () => ({
  resolveOfferCampaignIds: () => Promise.resolve([]),
  OfferCampaignsUnavailableError: class extends Error {},
}));

const resolveBrandMembershipsByEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: () => Promise.resolve({ byAudienceId: {}, byEmail: {} }),
  resolveBrandMembershipsByEmail: (...args: unknown[]) => resolveBrandMembershipsByEmailMock(...args),
}));
vi.mock("../../src/lib/sourcing-origin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sourcing-origin.js")>()),
  loadOriginNamesByList: () => Promise.resolve(new Map()),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

// Real offer-card-client, mocked transport: what is under test is the cost the ROUTE puts on it.
vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
  BRAND_SERVICE_URL: "https://brand.test",
  BRAND_SERVICE_API_KEY: "test-brand-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OFFER = "0ffe0000-0000-4000-8000-000000000001";
const SELLING_CAMPAIGN = "aaaaaaaa-1111-4111-8111-111111111111";
const OFFERLESS_CAMPAIGN = "bbbbbbbb-2222-4222-8222-222222222222";
const ROW_ID = "11111111-1111-4111-8111-111111111111";

const CAMPAIGNS_URL = "https://campaign.test/campaigns";
const OFFERS_URL = `https://brand.test/internal/brands/${BRAND}/offers`;

const fetchSpy = vi.fn();

function rawRow(i: number, campaignId: string, id = `lc-${i}`) {
  return {
    id,
    lead_id: `lead-${i}`,
    campaign_id: campaignId,
    org_id: ORG,
    user_id: null,
    brand_ids: [BRAND],
    status: "served",
    status_reason: null,
    status_details: null,
    parent_run_id: null,
    run_id: null,
    served_at: "2026-01-01T00:00:00.000Z",
    workflow_slug: null,
    feature_slug: null,
    goal: null,
    active_goal_id: null,
    brand_profile_id: null,
    audience_id: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    created_at_cursor: "2026-01-01 00:00:00.000000+00",
    lead_apollo_person_id: null,
    email_value: `lead-${i}@example.com`,
    email_status: "valid",
  };
}

/** campaign-service knows both campaigns; only one names an offer. brand-service names it. */
function healthyTransport() {
  fetchSpy.mockImplementation(async (url: string) => {
    if (url === CAMPAIGNS_URL) {
      return {
        ok: true,
        json: async () => ({
          campaigns: [
            { id: SELLING_CAMPAIGN, orgId: ORG, brandIds: [BRAND], offerId: OFFER },
            { id: OFFERLESS_CAMPAIGN, orgId: ORG, brandIds: [BRAND], offerId: null },
          ],
        }),
      };
    }
    if (url === OFFERS_URL) {
      return {
        ok: true,
        json: async () => ({ offers: [{ offerId: OFFER, brandId: BRAND, name: "Fractional CFO retainer" }] }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

function get(app: express.Express, path: string) {
  return request(app).get(path).set("x-api-key", "test-api-key").set("x-org-id", ORG);
}

describe("a lead row carries its offer", () => {
  let app: express.Express;

  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    app = await buildApp();
  }, 30_000);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockRows = [];
    mockSqlChunkIndex = 0;
    fetchSpy.mockReset();
    healthyTransport();
  });

  // AC1 — the offer, with its NAME. An id alone leaves the panel with nothing to render.
  it("names the offer its campaign sells, in the full view", async () => {
    mockRows = [rawRow(1, SELLING_CAMPAIGN)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}`);

    expect(res.status).toBe(200);
    expect(res.body.leads[0].offer).toEqual({ id: OFFER, name: "Fractional CFO retainer" });
  });

  it("names it identically in the slim projection", async () => {
    mockRows = [rawRow(1, SELLING_CAMPAIGN)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    // The slim row is what the dashboard's table reads; a panel rendered from it must not be
    // missing the offer the full row names.
    expect(res.body.leads[0].offer).toEqual({ id: OFFER, name: "Fractional CFO retainer" });
  });

  it("names it identically on the one-lead read", async () => {
    mockRows = [rawRow(1, SELLING_CAMPAIGN, ROW_ID)];

    const res = await get(app, `/orgs/leads/${ROW_ID}?brandId=${BRAND}`);

    expect(res.status).toBe(200);
    expect(res.body.leadDetail.offer).toEqual({ id: OFFER, name: "Fractional CFO retainer" });
  });

  // AC2 — a campaign that names no offer gives its leads none, and changes nothing else.
  it("carries no offer for a campaign that sells none, and leaves the row otherwise unchanged", async () => {
    mockRows = [rawRow(1, OFFERLESS_CAMPAIGN)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}`);

    const lead = res.body.leads[0];
    expect(lead.offer).toBeNull();
    // Never the brand's, never a sibling campaign's — the offer OFFER is right there in the org.
    expect(JSON.stringify(lead)).not.toContain(OFFER);
    expect(lead.campaignId).toBe(OFFERLESS_CAMPAIGN);
    expect(lead.brandIds).toEqual([BRAND]);
  });

  // AC5 — the resolution is per REQUEST. A per-row implementation fails this outright.
  it("resolves the whole response with a constant number of calls, whatever the row count", async () => {
    // 1,200 rows over three chunks, both campaigns represented.
    mockRows = Array.from({ length: 1200 }, (_, i) =>
      rawRow(i, i % 2 === 0 ? SELLING_CAMPAIGN : OFFERLESS_CAMPAIGN),
    );

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads).toHaveLength(1200);
    expect(res.body.leads[0].offer).toEqual({ id: OFFER, name: "Fractional CFO retainer" });
    expect(res.body.leads[1].offer).toBeNull();

    // Two campaign-service reads (one for the offer each campaign sells, one for the sales funnel
    // it sells through — the standing needs the funnel) and one brand-service read, for 1,200 rows
    // across several chunks. Constant in the row count, which is what this asserts.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls.filter(([url]) => url === CAMPAIGNS_URL)).toHaveLength(2);
    expect(fetchSpy.mock.calls.filter(([url]) => url === OFFERS_URL)).toHaveLength(1);
  });

  it("holds the same constant call count on the full view's chunked walk", async () => {
    mockRows = Array.from({ length: 1200 }, (_, i) => rawRow(i, SELLING_CAMPAIGN));

    const res = await get(app, `/orgs/leads?brandId=${BRAND}`);

    expect(res.body.leads).toHaveLength(1200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  // Unresolvable is ABSENT, and the list a consumer reads today still answers.
  it("still returns the list, with no offer, when the offer cannot be resolved", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    mockRows = [rawRow(1, SELLING_CAMPAIGN)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}`);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].offer).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("offer unresolved"));
    consoleError.mockRestore();
  });
});
