import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// A campaign-scoped read must answer for the campaign IDENTITY — every stored campaign row the
// customer reads as ONE campaign — with the engagement of the widened set intact. A lead served
// under a stopped ancestor holds its delivery evidence under THAT campaign id, so asking
// email-gateway in campaign mode for the live id alone would report it as never contacted.

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

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const LIVE_CAMPAIGN = "9bc27ed7-2fd5-4fb4-b523-026eb919e8ae";
const ANCESTOR_CAMPAIGN = "11111111-2222-3333-4444-555555555555";

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
function brandModeResult(email: string, campaignId: string, over: Record<string, unknown> = {}) {
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
          ...over,
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

describe("GET /orgs/leads campaign identity scope", () => {
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
  });

  it("filters on every member of the identity, not the single stored row", async () => {
    resolveCampaignFamilyMock.mockResolvedValue([ANCESTOR_CAMPAIGN, LIVE_CAMPAIGN]);
    mockRows = [rawRow(1, ANCESTOR_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}&campaignId=${LIVE_CAMPAIGN}`);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(capturedSqlValues).toContainEqual([ANCESTOR_CAMPAIGN, LIVE_CAMPAIGN]);
    expect(resolveCampaignFamilyMock).toHaveBeenCalledWith(
      LIVE_CAMPAIGN,
      expect.objectContaining({ orgId: ORG, brandId: BRAND }),
    );
  });

  it("keeps the widened set's engagement — a lead served under a stopped ancestor still reads as contacted", async () => {
    resolveCampaignFamilyMock.mockResolvedValue([ANCESTOR_CAMPAIGN, LIVE_CAMPAIGN]);
    mockRows = [rawRow(1, ANCESTOR_CAMPAIGN)];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [brandModeResult("lead-1@example.com", ANCESTOR_CAMPAIGN)],
    });

    const res = await get(app, `brandId=${BRAND}&campaignId=${LIVE_CAMPAIGN}`);

    // Brand mode is what returns the per-campaign breakdown the identity is read out of, so no
    // campaign id goes on the wire for a multi-member identity.
    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBeUndefined();
    const lead = res.body.leads[0];
    expect(lead.contacted).toBe(true);
    expect(lead.sent).toBe(true);
    expect(lead.delivered).toBe(true);
    expect(lead.clicked).toBe(true);
    expect(lead.replied).toBe(true);
    expect(lead.replyClassification).toBe("positive");
    expect(lead.sentCount).toBe(2);
    expect(lead.firstContactedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("counts NO evidence from a campaign outside the identity — never a brand-wide answer", async () => {
    resolveCampaignFamilyMock.mockResolvedValue([ANCESTOR_CAMPAIGN, LIVE_CAMPAIGN]);
    mockRows = [rawRow(1, ANCESTOR_CAMPAIGN)];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [brandModeResult("lead-1@example.com", "a-different-identitys-campaign")],
    });

    const res = await get(app, `brandId=${BRAND}&campaignId=${LIVE_CAMPAIGN}`);

    const lead = res.body.leads[0];
    expect(lead.contacted).toBe(false);
    expect(lead.sent).toBe(false);
    expect(lead.replied).toBe(false);
    expect(lead.sentCount).toBe(0);
  });

  it("a single-member identity keeps today's campaign-mode call, byte for byte", async () => {
    resolveCampaignFamilyMock.mockResolvedValue([LIVE_CAMPAIGN]);
    mockRows = [rawRow(1, LIVE_CAMPAIGN)];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: "lead-1@example.com",
          broadcast: {
            byCampaign: null,
            campaign: {
              contacted: true, sent: true, delivered: true, opened: false, clicked: false,
              replied: false, replyClassification: null, bounced: false, unsubscribed: false,
              sentCount: 1, lastDeliveredAt: null, firstContactedAt: null, firstSentAt: null,
              firstDeliveredAt: null, firstOpenedAt: null, firstClickedAt: null,
              firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
            },
            brand: null,
            global: { email: { bounced: false, unsubscribed: false } },
          },
        },
      ],
    });

    const res = await get(app, `brandId=${BRAND}&campaignId=${LIVE_CAMPAIGN}`);

    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBe(LIVE_CAMPAIGN);
    expect(capturedSqlValues).toContainEqual([LIVE_CAMPAIGN]);
    expect(res.body.leads[0].contacted).toBe(true);
    expect(res.body.leads[0].sentCount).toBe(1);
  });

  it("resolution failing falls back to the requested campaign alone", async () => {
    // The client already swallows the outage and answers [campaignId]; the route must then behave
    // exactly as it does today — single-row filter, campaign-mode delivery lookup.
    resolveCampaignFamilyMock.mockResolvedValue([LIVE_CAMPAIGN]);
    mockRows = [rawRow(1, LIVE_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}&campaignId=${LIVE_CAMPAIGN}`);

    expect(res.status).toBe(200);
    expect(capturedSqlValues).toContainEqual([LIVE_CAMPAIGN]);
    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBe(LIVE_CAMPAIGN);
  });

  it("a brand-scoped read never asks campaign-service for an identity", async () => {
    mockRows = [rawRow(1, LIVE_CAMPAIGN)];

    const res = await get(app, `brandId=${BRAND}`);

    expect(res.status).toBe(200);
    expect(resolveCampaignFamilyMock).not.toHaveBeenCalled();
    expect(checkDeliveryStatusMock.mock.calls[0]?.[1]).toBeUndefined();
  });
});
