import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// A lead row carries THE DEAL — that it closed, what it was worth, what closing it cost the
// customer, and WHOSE win it was. A table renders a column per lead at four grains over pages of
// rows, so learning one fact per row must not cost one request per row: it rides on the list read
// the table already makes, off the SAME statements the standing is resolved from, in the same pass.
//
// What is asserted here is the ROUTE half: the answer reaches the wire on BOTH reads (slim and
// full), a deal the customer says we did not cause is on the row exactly like one we did, nobody
// having been asked stays its own third state, and no extra query is run to learn any of it.

let mockRows: Array<Record<string, unknown>> = [];
let mockSqlChunkIndex = 0;
let outcomeRows: Array<Record<string, unknown>> = [];
let neverRows: Array<Record<string, unknown>> = [];
const executed: string[] = [];

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
  db: {
    // The two statement reads, told apart by the table they name — the same pair the one-lead
    // panel runs, batched over a chunk.
    execute: (query: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(query?.queryChunks ?? query);
      executed.push(text);
      return Promise.resolve(text.includes("conversion_events") ? outcomeRows : neverRows);
    },
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

let clickedEmails = new Set<string>();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) =>
    Promise.resolve({
      results: items.map((item) => {
        const scope = {
          contacted: true,
          sent: true,
          delivered: true,
          opened: false,
          clicked: clickedEmails.has(item.email),
          replied: false,
          replyClassification: null,
          bounced: false,
          unsubscribed: false,
          sentCount: 1,
          lastDeliveredAt: null,
          firstContactedAt: null,
          firstSentAt: null,
          firstDeliveredAt: null,
          firstOpenedAt: null,
          firstClickedAt: null,
          firstRepliedAt: null,
          firstBouncedAt: null,
          firstUnsubscribedAt: null,
        };
        return {
          email: item.email,
          // Both scopes, so a campaign-scoped read and a brand-scoped one see the same evidence.
          broadcast: {
            campaign: scope,
            brand: scope,
            global: { email: { bounced: false, unsubscribed: false } },
          },
        };
      }),
    }),
}));

vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (id: string) => Promise.resolve([id]),
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

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

// Real campaign-leg-client, mocked transport: the leg comes from campaign-service or it is
// not resolved at all — never inferred from the brand, the goal, or a sibling campaign.
vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "6e21bb6c-67bc-45f3-8a6d-52230338d7e4";
const FORM_MAGNET = "9e28ba26-1cd3-4b52-9d00-b73e900522ae";
const REPLY_LED = "cccccccc-3333-4333-8333-333333333333";
const CAMPAIGNS_URL = "https://campaign.test/campaigns";

const fetchSpy = vi.fn();

function rawRow(i: number, campaignId = FORM_MAGNET) {
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
    created_at_cursor: "2026-01-01 00:00:00.000000+00",
    lead_apollo_person_id: null,
    email_value: `lead-${i}@example.com`,
    email_status: "valid",
  };
}

function healthyCampaigns() {
  fetchSpy.mockImplementation(async (url: string) => {
    if (url === CAMPAIGNS_URL) {
      return {
        ok: true,
        json: async () => ({
          campaigns: [
            { id: FORM_MAGNET, orgId: ORG, legKey: "start_to_website_visit" },
            { id: REPLY_LED, orgId: ORG, legKey: "start_to_conversation" },
          ],
        }),
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


describe("a lead row carries the deal, and whose win it was", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockReset();
    healthyCampaigns();
    mockRows = [];
    mockSqlChunkIndex = 0;
    outcomeRows = [];
    neverRows = [];
    executed.length = 0;
    clickedEmails = new Set();
    app = await buildApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function saleRow(i: number, causedByOutreach: boolean | null) {
    return {
      lead_campaign_id: `lc-${i}`,
      matched_lead_id: `lead-${i}`,
      event: "sale",
      source: "manual",
      value_cents: 490000,
      cost_cents: 12000,
      caused_by_outreach: causedByOutreach,
      note: null,
      stated_by_user_id: "user-1",
      received_at: "2026-02-02T00:00:00.000Z",
    };
  }

  it("carries a deal OUR outreach caused, on the slim row", async () => {
    mockRows = [rawRow(1)];
    outcomeRows = [saleRow(1, true)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    const lead = res.body.leads[0];
    expect(lead.closedDeal).toEqual({
      occurredAt: "2026-02-02T00:00:00.000Z",
      valueCents: 490000,
      costCents: 12000,
      causedByOutreach: true,
      source: "manual",
    });
    // Additive beside the standing, which is unchanged: a person who bought is still a customer.
    expect(lead.standing.state).toBe("customer");
  });

  it("carries a deal the customer says we did NOT cause, exactly like one we did", async () => {
    mockRows = [rawRow(1)];
    outcomeRows = [saleRow(1, false)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    const lead = res.body.leads[0];
    // The deal is REAL and the row says so — the brand still sees its own close, with its value.
    expect(lead.closedDeal.causedByOutreach).toBe(false);
    expect(lead.closedDeal.valueCents).toBe(490000);
    expect(lead.standing.state).toBe("customer");
  });

  it("keeps NOBODY WAS ASKED apart from both answers", async () => {
    mockRows = [rawRow(1)];
    outcomeRows = [saleRow(1, null)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads[0].closedDeal.causedByOutreach).toBeNull();
  });

  it("says null when nobody has stated a deal at all", async () => {
    mockRows = [rawRow(1)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads[0].closedDeal).toBeNull();
  });

  it("emits the same answer on the FULL row as on the slim one", async () => {
    mockRows = [rawRow(1)];
    outcomeRows = [saleRow(1, true)];

    const slim = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);
    const full = await get(app, `/orgs/leads?brandId=${BRAND}`);

    expect(full.body.leads[0].closedDeal).toEqual(slim.body.leads[0].closedDeal);
  });

  it("costs no request per lead: one statement read per chunk, whatever the page holds", async () => {
    mockRows = Array.from({ length: 40 }, (_, i) => rawRow(i + 1));
    outcomeRows = Array.from({ length: 40 }, (_, i) => saleRow(i + 1, i % 2 === 0));

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads).toHaveLength(40);
    expect(res.body.leads.every((l: { closedDeal: unknown }) => l.closedDeal !== null)).toBe(true);
    expect(res.body.leads[0].closedDeal.causedByOutreach).toBe(true);
    expect(res.body.leads[1].closedDeal.causedByOutreach).toBe(false);
    // The SAME two statement reads the standing already runs — the deal is read off them, never
    // out of a second query and never one per row.
    expect(executed.filter((t) => t.includes("conversion_events"))).toHaveLength(1);
  });

  it("is answered at campaign scope too, exactly as the standing is", async () => {
    mockRows = [rawRow(1, REPLY_LED)];
    outcomeRows = [saleRow(1, false)];

    const res = await get(
      app,
      `/orgs/leads?brandId=${BRAND}&campaignId=${REPLY_LED}&view=basic`,
    );

    expect(res.body.leads[0].closedDeal.causedByOutreach).toBe(false);
  });
});
