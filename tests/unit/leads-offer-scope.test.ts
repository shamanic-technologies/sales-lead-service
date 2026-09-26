import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// An OFFER is brand-service's proposition level, between the brand and the campaign. A brand
// selling two offers must not show the same people under both — which is what the leads list did
// while it could only narrow to a brand. A lead's offer is the offer named by the campaign it was
// served under: `leads_campaigns.campaign_id` is the frozen attribution, campaign-service records
// each campaign's offer, so an offer scope resolves to campaign ids and rides the campaign-id
// filter that already exists.

let capturedSqlValues: unknown[] = [];
let mockRows: Array<Record<string, unknown>> = [];
let mockSqlChunkIndex = 0;

vi.mock("../../src/db/index.js", () => ({
  sql: (_strings: readonly string[], ...values: unknown[]) => {
    capturedSqlValues.push(...values);
    return {
      then: (resolve: (rows: unknown[]) => void) => {
        const start = mockSqlChunkIndex * 500;
        mockSqlChunkIndex += 1;
        return Promise.resolve(mockRows.slice(start, start + 500)).then(resolve);
      },
      // The slim (`?view=basic`) path streams through a server-side cursor.
      cursor: (size: number) => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < mockRows.length; i += size) yield mockRows.slice(i, i + size);
        },
      }),
    };
  },
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

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
}));

const resolveCampaignFamilyMock = vi.fn();
vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (...args: unknown[]) => resolveCampaignFamilyMock(...args),
}));

const resolveOfferCampaignIdsMock = vi.fn();
class OfferCampaignsUnavailableError extends Error {}
vi.mock("../../src/lib/offer-campaigns-client.js", () => ({
  resolveOfferCampaignIds: (...args: unknown[]) => resolveOfferCampaignIdsMock(...args),
  OfferCampaignsUnavailableError,
}));

vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: () => Promise.resolve({ byAudienceId: {}, byEmail: {} }),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OFFER = "0ffe0000-0000-4000-8000-000000000001";
const OFFER_CAMPAIGN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const OFFER_CAMPAIGN_B = "bbbbbbbb-2222-4222-8222-222222222222";
const SOME_CAMPAIGN = "cccccccc-3333-4333-8333-333333333333";

function rawRow(i: number, campaignId: string) {
  return {
    id: `lc-${i}`,
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
    lead_apollo_person_id: null,
  };
}

/** Brand-mode answer: evidence keyed on the campaign that actually sent the email. */
function brandModeResult(email: string, campaignId: string) {
  return {
    email,
    broadcast: {
      byCampaign: {
        [campaignId]: {
          contacted: true, sent: true, delivered: true, opened: true, clicked: true,
          replied: true, replyClassification: "positive", bounced: false, unsubscribed: false,
          sentCount: 2, lastDeliveredAt: "2026-02-01T00:00:00.000Z",
          firstContactedAt: "2026-01-02T00:00:00.000Z", firstSentAt: "2026-01-02T00:00:00.000Z",
          firstDeliveredAt: "2026-01-02T00:00:00.000Z", firstOpenedAt: "2026-01-03T00:00:00.000Z",
          firstClickedAt: "2026-01-04T00:00:00.000Z", firstRepliedAt: "2026-01-05T00:00:00.000Z",
          firstBouncedAt: null, firstUnsubscribedAt: null,
        },
      },
      campaign: null,
      brand: null,
      global: { email: { bounced: false, unsubscribed: false } },
    },
  };
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

function get(app: express.Express, query: string) {
  return request(app).get(`/orgs/leads?${query}`).set("x-api-key", "test-api-key").set("x-org-id", ORG);
}

describe("GET /orgs/leads offer scope", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    capturedSqlValues = [];
    mockRows = [];
    mockSqlChunkIndex = 0;
    checkDeliveryStatusMock.mockReset();
    checkDeliveryStatusMock.mockResolvedValue({ results: [] });
    resolveCampaignFamilyMock.mockReset();
    resolveOfferCampaignIdsMock.mockReset();
  });

  // AC1 — narrowed to an offer, the list returns that offer's leads.
  it("filters on every campaign that sells the offer", async () => {
    resolveOfferCampaignIdsMock.mockResolvedValue([OFFER_CAMPAIGN_A, OFFER_CAMPAIGN_B]);
    mockRows = [rawRow(1, OFFER_CAMPAIGN_A)];

    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}`);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].campaignId).toBe(OFFER_CAMPAIGN_A);
    // The offer's campaign ids are what the query binds — the frozen `campaign_id` filter, not a
    // second parallel one.
    expect(capturedSqlValues).toContainEqual([OFFER_CAMPAIGN_A, OFFER_CAMPAIGN_B]);
    expect(resolveOfferCampaignIdsMock).toHaveBeenCalledWith(
      OFFER,
      expect.objectContaining({ orgId: ORG, brandId: BRAND }),
    );
  });

  it("works with no brand named — the offer is narrowing enough on its own", async () => {
    resolveOfferCampaignIdsMock.mockResolvedValue([OFFER_CAMPAIGN_A]);
    mockRows = [rawRow(1, OFFER_CAMPAIGN_A)];

    const res = await get(app, `offerId=${OFFER}`);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(capturedSqlValues).toContainEqual([OFFER_CAMPAIGN_A]);
  });

  it("carries the offer's engagement — a lead served under one of its campaigns reads as contacted", async () => {
    resolveOfferCampaignIdsMock.mockResolvedValue([OFFER_CAMPAIGN_A, OFFER_CAMPAIGN_B]);
    mockRows = [rawRow(1, OFFER_CAMPAIGN_A)];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [brandModeResult("lead-1@example.com", OFFER_CAMPAIGN_A)],
    });

    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}`);

    // Several campaigns => brand mode on the wire, read back per-campaign.
    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBeUndefined();
    const lead = res.body.leads[0];
    expect(lead.contacted).toBe(true);
    expect(lead.replied).toBe(true);
    expect(lead.sentCount).toBe(2);
  });

  it("counts NO evidence from a campaign outside the offer — never a brand-wide answer", async () => {
    resolveOfferCampaignIdsMock.mockResolvedValue([OFFER_CAMPAIGN_A, OFFER_CAMPAIGN_B]);
    mockRows = [rawRow(1, OFFER_CAMPAIGN_A)];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [brandModeResult("lead-1@example.com", SOME_CAMPAIGN)],
    });

    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}`);

    const lead = res.body.leads[0];
    expect(lead.contacted).toBe(false);
    expect(lead.sentCount).toBe(0);
  });

  it("composes with the status filter and the slim projection", async () => {
    resolveOfferCampaignIdsMock.mockResolvedValue([OFFER_CAMPAIGN_A]);
    mockRows = [
      {
        ...rawRow(1, OFFER_CAMPAIGN_A),
        created_at_cursor: "2026-01-01 00:00:00.000000+00",
        email_value: "lead-1@example.com",
        email_status: "valid",
      },
    ];

    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}&status=served&view=basic`);

    expect(res.status).toBe(200);
    expect(capturedSqlValues).toContainEqual([OFFER_CAMPAIGN_A]);
    expect(capturedSqlValues).toContainEqual(["served"]);
  });

  // AC2 — absent, the read is exactly what it is today.
  it("is inert when absent: no offer resolution, brand scope unchanged", async () => {
    mockRows = [rawRow(1, SOME_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}`);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(resolveOfferCampaignIdsMock).not.toHaveBeenCalled();
    // No campaign-id array bound, and brand-mode delivery status as before.
    expect(capturedSqlValues).toContainEqual(BRAND);
    expect(checkDeliveryStatusMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("leaves a campaign-scoped read untouched", async () => {
    resolveCampaignFamilyMock.mockResolvedValue([SOME_CAMPAIGN]);
    mockRows = [rawRow(1, SOME_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}&campaignId=${SOME_CAMPAIGN}`);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(resolveOfferCampaignIdsMock).not.toHaveBeenCalled();
    // A single stored campaign still asks email-gateway in campaign mode.
    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBe(SOME_CAMPAIGN);
  });

  // AC3 — a contradictory request is refused.
  it("400s when an offer and a campaign are both named", async () => {
    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}&campaignId=${SOME_CAMPAIGN}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offerId and campaignId/);
    expect(resolveOfferCampaignIdsMock).not.toHaveBeenCalled();
    expect(resolveCampaignFamilyMock).not.toHaveBeenCalled();
  });

  it("returns an empty list — never the brand's leads — for an offer no campaign sells", async () => {
    resolveOfferCampaignIdsMock.mockResolvedValue([]);
    mockRows = [rawRow(1, SOME_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leads: [], nextCursor: null });
  });

  it("502s rather than widening to the brand when the offer cannot be resolved", async () => {
    resolveOfferCampaignIdsMock.mockRejectedValue(
      new OfferCampaignsUnavailableError("campaign-service is unreachable"),
    );
    mockRows = [rawRow(1, SOME_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}&offerId=${OFFER}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/campaign-service/);
    expect(res.body.leads).toBeUndefined();
  });
});
