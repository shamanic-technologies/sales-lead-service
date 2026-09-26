import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// A brand-scoped read answers ONE row per person and stamps the BRAND's delivery roll-up on it.
// A panel that nests a person's campaigns under that row therefore printed byte-identical evidence
// under every card. `?include=campaigns` answers per campaign, out of the breakdown email-gateway
// already returns in brand mode — while the brand-wide fields stay exactly where they were.

let chunkRows: Array<Record<string, unknown>> = [];
let membershipRows: Array<Record<string, unknown>> = [];
let chunkCalls = 0;
let membershipQueries: unknown[][] = [];

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join(" ");
    return {
      __sql: true,
      strings,
      values,
      then: (resolve: (rows: unknown[]) => void) => {
        if (/lc\.lead_id = ANY/.test(text)) {
          membershipQueries.push(values);
          return Promise.resolve(membershipRows).then(resolve);
        }
        if (/created_at::text AS created_at_cursor/.test(text)) {
          const out = chunkCalls === 0 ? chunkRows : [];
          chunkCalls += 1;
          return Promise.resolve(out).then(resolve);
        }
        return Promise.resolve([]).then(resolve);
      },
      // The SLIM path streams its chunks with `.cursor()` rather than awaiting the
      // query, so a mock that only implements `then` makes `?view=basic` throw
      // mid-stream — which surfaces as a bare `Error: aborted` on the assertion rather
      // than as anything about the query. Same shape as every other view=basic test's
      // mock in this suite (leads-offer-on-row, leads-stream).
      cursor: (size: number) => ({
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < chunkRows.length; i += size) yield chunkRows.slice(i, i + size);
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
          { leadId: id, contacts: [{ channel: "email", value: `${id}@example.com`, status: "valid" }] },
        ]),
      ),
    ),
}));

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
}));

const familiesMock = vi.fn();
vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (id: string) => Promise.resolve([id]),
  fetchOrgCampaignFamilies: (...args: unknown[]) => familiesMock(...args),
}));

vi.mock("../../src/lib/offer-campaigns-client.js", () => ({
  resolveOfferCampaignIds: () => Promise.resolve([]),
  OfferCampaignsUnavailableError: class extends Error {},
}));

vi.mock("../../src/lib/offer-card-client.js", () => ({
  createOfferCardResolver: () => ({ resolve: () => Promise.resolve(new Map()) }),
}));

vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: () => Promise.resolve({ byAudienceId: {}, byEmail: {} }),
}));

// The standing is resolved by the same resolver the row-level standing uses; what matters here is
// WHICH resolver each card went to — a card whose delivery the provider cannot speak to must be
// resolved with the delivery layer marked UNASKED, so it never reads as "never contacted".
const standingCalls: Array<{ deliveryQueried: boolean; rows: Array<Record<string, unknown>> }> = [];
vi.mock("../../src/lib/lead-standing-resolver.js", () => ({
  createLeadStandingResolver: (opts: { deliveryQueried: boolean }) => ({
    resolve: (rows: Array<Record<string, unknown>>) => {
      standingCalls.push({ deliveryQueried: opts.deliveryQueried, rows });
      return Promise.resolve(
        new Map(
          rows.map((r) => [
            r.id as string,
            {
              standing: {
                state: opts.deliveryQueried ? "contacted" : "unresolved",
                signal: "none",
                origin: null,
                reason: opts.deliveryQueried ? null : "delivery_not_queried",
                legKey: null,
                entryStep: null,
                entryMeasure: null,
                reachedEntryStep: null,
                deepestStep: null,
                at: null,
              },
              closedDeal: null,
            },
          ]),
        ),
      );
    },
  }),
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const USER = "40000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const LEAD = "20000000-0000-0000-0000-000000000001";
const ROW_A = "11111111-1111-4111-8111-111111111111";
const ROW_B = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CAMPAIGN_B = "bbbbbbbb-2222-4222-8222-222222222222";
const CAMPAIGN_A_STOPPED = "aaaaaaaa-9999-4999-8999-999999999999";

function row(id: string, campaignId: string, createdAt = "2026-01-01 00:00:00+00") {
  return {
    id,
    lead_id: LEAD,
    campaign_id: campaignId,
    org_id: ORG,
    user_id: null,
    brand_ids: [BRAND],
    status: "served",
    status_reason: null,
    status_details: null,
    parent_run_id: null,
    run_id: null,
    served_at: createdAt,
    workflow_slug: null,
    feature_slug: null,
    goal: null,
    active_goal_id: null,
    brand_profile_id: null,
    audience_id: null,
    created_at: createdAt,
    created_at_cursor: createdAt,
    lead_apollo_person_id: null,
    email_value: `${LEAD}@example.com`,
    email_status: "valid",
  };
}

/** Contacted + clicked under campaign A only; the brand roll-up carries both, as it always did. */
function statusWithCampaignAOnly() {
  const scope = (over: Record<string, unknown> = {}) => ({
    contacted: true, sent: true, delivered: true, opened: true, clicked: true,
    replied: false, replyClassification: null, bounced: false, unsubscribed: false,
    sentCount: 1, lastDeliveredAt: null, firstContactedAt: "2026-01-02T00:00:00.000Z",
    firstSentAt: null, firstDeliveredAt: null, firstOpenedAt: null, firstClickedAt: null,
    firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
    ...over,
  });
  return {
    results: [
      {
        email: `${LEAD}@example.com`,
        broadcast: {
          brand: scope(),
          byCampaign: { [CAMPAIGN_A]: scope() },
          global: { email: { bounced: false, unsubscribed: false } },
        },
      },
    ],
  };
}

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/leads.js");
  app = express();
  app.use(express.json());
  app.use(route);
}, 30_000);

beforeEach(() => {
  chunkRows = [row(ROW_A, CAMPAIGN_A)];
  membershipRows = [
    { id: ROW_A, lead_id: LEAD, campaign_id: CAMPAIGN_A, status: "served", served_at: "2026-01-01 00:00:00+00", audience_id: null, created_at: "2026-01-01 00:00:00+00", brand_ids: [BRAND] },
    { id: ROW_B, lead_id: LEAD, campaign_id: CAMPAIGN_B, status: "served", served_at: "2026-02-01 00:00:00+00", audience_id: null, created_at: "2026-02-01 00:00:00+00", brand_ids: [BRAND] },
  ];
  chunkCalls = 0;
  membershipQueries = [];
  standingCalls.length = 0;
  checkDeliveryStatusMock.mockReset().mockResolvedValue(statusWithCampaignAOnly());
  familiesMock.mockReset().mockResolvedValue({
    byCampaignId: new Map([
      [CAMPAIGN_A, { key: "identity-a", campaignIds: [CAMPAIGN_A] }],
      [CAMPAIGN_B, { key: "identity-b", campaignIds: [CAMPAIGN_B] }],
    ]),
    familyOf: (id: string) => [id],
  });
});

function get(path: string) {
  return request(app)
    .get(path)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-user-id", USER);
}

describe("GET /orgs/leads?include=campaigns — per-campaign delivery evidence", () => {
  it("says nothing new when nobody asked: no `campaigns` key, no membership query", async () => {
    const res = await get(`/orgs/leads?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect("campaigns" in res.body.leads[0]).toBe(false);
    expect(membershipQueries).toHaveLength(0);
  });

  it("answers evidence that DIFFERS between two campaigns of one brand", async () => {
    const res = await get(`/orgs/leads?brandId=${BRAND}&include=campaigns`);
    expect(res.status).toBe(200);
    const lead = res.body.leads[0];

    // The brand-wide roll-up several dashboard surfaces read is untouched.
    expect(lead).toMatchObject({ contacted: true, clicked: true });

    const cards = lead.campaigns;
    expect(cards.map((c: { campaignId: string }) => c.campaignId)).toEqual([CAMPAIGN_A, CAMPAIGN_B]);

    const [a, b] = cards;
    expect(a.delivery).toMatchObject({ contacted: true, clicked: true, sentCount: 1 });
    // The provider reports NOTHING for campaign B. "We cannot tell" is not "no": never an
    // all-false status, and never the brand's evidence restamped.
    expect(b.delivery).toBeNull();
  });

  it("resolves a card with no provider evidence as unasked, never as never-contacted", async () => {
    await get(`/orgs/leads?brandId=${BRAND}&include=campaigns`);
    const unmeasured = standingCalls.find((c) => !c.deliveryQueried);
    expect(unmeasured).toBeDefined();
    expect(unmeasured!.rows.map((r) => r.id)).toEqual([ROW_B]);
    const measured = standingCalls.find(
      (c) => c.deliveryQueried && c.rows.length === 1 && c.rows[0].id === ROW_A,
    );
    expect(measured).toBeDefined();
  });

  it("reads a card for the whole campaign IDENTITY, so a stopped ancestor's evidence counts", async () => {
    familiesMock.mockResolvedValue({
      byCampaignId: new Map([
        [CAMPAIGN_A, { key: "identity-a", campaignIds: [CAMPAIGN_A, CAMPAIGN_A_STOPPED] }],
        [CAMPAIGN_A_STOPPED, { key: "identity-a", campaignIds: [CAMPAIGN_A, CAMPAIGN_A_STOPPED] }],
        [CAMPAIGN_B, { key: "identity-b", campaignIds: [CAMPAIGN_B] }],
      ]),
      familyOf: (id: string) =>
        id === CAMPAIGN_B ? [CAMPAIGN_B] : [CAMPAIGN_A, CAMPAIGN_A_STOPPED],
    });
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: `${LEAD}@example.com`,
          broadcast: {
            brand: null,
            byCampaign: {
              [CAMPAIGN_A_STOPPED]: {
                contacted: true, sent: true, delivered: false, opened: false, clicked: false,
                replied: false, replyClassification: null, bounced: false, unsubscribed: false,
                sentCount: 3, lastDeliveredAt: null, firstContactedAt: "2026-01-02T00:00:00.000Z",
                firstSentAt: null, firstDeliveredAt: null, firstOpenedAt: null, firstClickedAt: null,
                firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
              },
            },
            global: { email: { bounced: false, unsubscribed: false } },
          },
        },
      ],
    });

    const res = await get(`/orgs/leads?brandId=${BRAND}&include=campaigns`);
    const cards = res.body.leads[0].campaigns;
    const a = cards.find((c: { campaignId: string }) => c.campaignId === CAMPAIGN_A);
    expect(a.campaignIds).toEqual([CAMPAIGN_A, CAMPAIGN_A_STOPPED]);
    expect(a.delivery).toMatchObject({ contacted: true, sentCount: 3 });
  });

  it("400s an include value it does not serve, rather than dropping it silently", async () => {
    const res = await get(`/orgs/leads?brandId=${BRAND}&include=campaign`);
    expect(res.status).toBe(400);
    expect(membershipQueries).toHaveLength(0);
  });

  it("serves the cards on the slim view too", async () => {
    const res = await get(`/orgs/leads?brandId=${BRAND}&view=basic&include=campaigns`);
    expect(res.status).toBe(200);
    expect(res.body.leads[0].campaigns).toHaveLength(2);
  });
});
