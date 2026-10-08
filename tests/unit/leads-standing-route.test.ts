import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// A lead row carries WHERE THAT PERSON STANDS on the campaign it was served under, decided here.
// The measured case that forced it: a Form Magnet campaign sells `visit -> form -> paid`, 67 people
// clicked through to the customer's site, and the board showed nobody under Sales interest because
// every consumer was deriving interest from a positive REPLY — which that campaign prices nowhere.
// What is asserted here is the ROUTE half: that the answer reaches the wire on both reads, that it
// is resolved once per response however many rows there are, and that an unresolvable signal says
// so instead of defaulting.

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

// Real campaign-leg-client, mocked transport: the leg comes from campaign-service or it is
// not resolved at all — never inferred from the brand, the goal, or a sibling campaign.
vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
  INSTANTLY_SERVICE_URL: "https://instantly.test",
  INSTANTLY_SERVICE_API_KEY: "test-instantly-key",
}));

// Every reply these people sent, each with its own verdict (instantly-service's contract). Answered
// ahead of whatever the test does to the campaign-service transport.
const VERDICTS_URL = "https://instantly.test/orgs/reply-verdicts/query";
let mockReplies: Array<Record<string, unknown>> = [];
let verdictsDown = false;
const verdictRequests: Array<{ emails: string[] }> = [];

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

describe("a lead row carries where that person stands", () => {
  let app: express.Express;

  beforeEach(async () => {
    mockReplies = [];
    verdictsDown = false;
    verdictRequests.length = 0;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (url === VERDICTS_URL) {
        const body = JSON.parse(String(init?.body)) as { emails: string[] };
        verdictRequests.push(body);
        if (verdictsDown) return Promise.resolve({ ok: false, status: 500, text: async () => "down" });
        const asked = new Set(body.emails);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ replies: mockReplies.filter((r) => asked.has(String(r.leadEmail))) }),
        });
      }
      return fetchSpy(url, init);
    });
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

  // THE CASE, on the wire. A consumer reads `sales_interest` without knowing what a click is, what
  // form_magnet is, or which reply kinds anybody classifies.
  it("serves sales_interest for a lead who clicked through on a campaign that sells the visit", async () => {
    mockRows = [rawRow(1)];
    clickedEmails = new Set(["lead-1@example.com"]);

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&campaignId=${FORM_MAGNET}&view=basic`);

    const lead = res.body.leads[0];
    expect(lead.standing.state).toBe("sales_interest");
    expect(lead.standing.reachedEntryStep).toBe(true);
    expect(lead.standing.entryStep).toBe("website_visit");
    expect(lead.standing.legKey).toBe("start_to_website_visit");
    // The raw facts stay exactly where they were: this is additive, and the policy is derived
    // beside them rather than replacing them.
    expect(lead.clicked).toBe(true);
    expect(lead.contacted).toBe(true);
    expect(lead.replyClassification).toBeNull();
  });

  // Owner-decided 2026-09-28: a website visit is interest whatever the campaign's leg.
  it("serves sales_interest for the same click on a campaign whose leg enters at a reply", async () => {
    mockRows = [rawRow(1, REPLY_LED)];
    clickedEmails = new Set(["lead-1@example.com"]);

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&campaignId=${REPLY_LED}&view=basic`);

    const lead = res.body.leads[0];
    expect(lead.standing.state).toBe("sales_interest");
    expect(lead.standing.signal).toBe("measured_visit");
    expect(lead.standing.reachedEntryStep).toBe(false);
    expect(lead.standing.entryStep).toBe("conversation_reply");
    expect(lead.clicked).toBe(true);
  });

  it("serves contacted for a lead who never clicked", async () => {
    mockRows = [rawRow(1)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads[0].standing.state).toBe("contacted");
    expect(res.body.leads[0].standing.reachedEntryStep).toBe(false);
  });

  it("lets a hand-stated outcome outrank the delivery signals", async () => {
    mockRows = [rawRow(1)];
    outcomeRows = [
      {
        brand_id: BRAND,
        matched_lead_id: "lead-1",
        event: "sale",
        source: "manual",
        value_cents: 250000,
        cost_cents: 0,
        note: null,
        stated_by_user_id: "user-1",
        received_at: "2026-02-02T00:00:00.000Z",
      },
    ];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    const standing = res.body.leads[0].standing;
    expect(standing.state).toBe("customer");
    expect(standing.signal).toBe("stated_outcome");
    expect(standing.deepestStep).toBe("sale");
    expect(standing.at).toBe("2026-02-02T00:00:00.000Z");
  });

  it("reads a live 'never' as disqualified", async () => {
    mockRows = [rawRow(1)];
    neverRows = [
      {
        lead_id: "lead-1",
        brand_id: BRAND,
        step: "sale",
        cost_cents: 0,
        note: null,
        stated_by_user_id: "user-1",
        updated_at: "2026-02-02T00:00:00.000Z",
      },
    ];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads[0].standing.state).toBe("disqualified");
    expect(res.body.leads[0].standing.signal).toBe("stated_never");
  });

  // NO SILENT FALLBACK. campaign-service down does not make everybody "contacted".
  it("says unresolved, with the reason, when the campaign's leg cannot be resolved", async () => {
    mockRows = [rawRow(1)];
    clickedEmails = new Set(["lead-1@example.com"]);
    fetchSpy.mockImplementation(async () => {
      throw new Error("campaign-service unreachable");
    });

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    const standing = res.body.leads[0].standing;
    expect(standing.state).toBe("unresolved");
    expect(standing.reason).toBe("campaign_service_unavailable");
    expect(standing.reachedEntryStep).toBeNull();
    // The read itself still answers, and the raw facts are untouched: one derived field failing is
    // not a reason to fail a whole list walk.
    expect(res.body.leads[0].clicked).toBe(true);
  });

  it("says unresolved when the campaign states no leg this service knows", async () => {
    mockRows = [rawRow(1)];
    fetchSpy.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ campaigns: [{ id: FORM_MAGNET, orgId: ORG, legKey: null }] }),
    }));

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads[0].standing.state).toBe("unresolved");
    expect(res.body.leads[0].standing.reason).toBe("leg_unstated");
  });

  it("says unresolved when the read named no scope, so the delivery layer was never asked", async () => {
    mockRows = [rawRow(1)];

    const res = await get(app, `/orgs/leads?view=basic`);

    expect(res.body.leads[0].standing.state).toBe("unresolved");
    expect(res.body.leads[0].standing.reason).toBe("delivery_not_queried");
  });

  it("never judges a lead that was never served", async () => {
    mockRows = [{ ...rawRow(1), status: "buffered" }];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&status=all&view=basic`);

    expect(res.body.leads[0].standing.state).toBe("not_contacted");
    expect(res.body.leads[0].standing.signal).toBe("not_served");
  });

  // A per-row implementation fails this outright, and it is what makes the field affordable on the
  // endpoint the dashboard polls every 30 seconds.
  it("resolves the campaign legs ONCE for the whole response, whatever the row count", async () => {
    mockRows = Array.from({ length: 1200 }, (_, i) => rawRow(i, i % 2 === 0 ? FORM_MAGNET : REPLY_LED));

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.body.leads).toHaveLength(1200);
    expect(fetchSpy.mock.calls.filter(([url]) => url === CAMPAIGNS_URL)).toHaveLength(1);
    expect(res.body.leads[0].standing.legKey).toBe("start_to_website_visit");
    expect(res.body.leads[1].standing.legKey).toBe("start_to_conversation");
  });

  it("emits the same standing on the full projection as on the slim one", async () => {
    mockRows = [rawRow(1)];
    clickedEmails = new Set(["lead-1@example.com"]);

    const slim = (await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`)).body.leads[0];
    mockSqlChunkIndex = 0;
    const full = (await get(app, `/orgs/leads?brandId=${BRAND}`)).body.leads[0];

    expect(full.standing).toEqual(slim.standing);
    expect(full.standing.state).toBe("sales_interest");
  });

  it("emits the same standing on the one-lead detail read", async () => {
    mockRows = [rawRow(1)];
    clickedEmails = new Set(["lead-1@example.com"]);

    const list = (await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`)).body.leads[0];
    mockSqlChunkIndex = 0;
    const detail = (
      await get(app, `/orgs/leads/11111111-1111-4111-8111-111111111111?brandId=${BRAND}`)
    ).body.leadDetail;

    expect(detail.standing).toEqual(list.standing);
  });

  // The reply half of the standing is read off every reply's own verdict (instantly-service), not
  // off the one coarse value per (campaign x lead) that the latest verdict overwrites.
  function verdictReply(email: string, receivedAt: string, kind: string, classification: string, campaignId = REPLY_LED) {
    return {
      replyId: `${email}-${receivedAt}`,
      leadEmail: email,
      instantlyCampaignId: "i-1",
      campaignId,
      brandIds: [BRAND],
      transport: "instantly",
      fromEmail: email,
      subject: null,
      receivedAt,
      verdict: {
        kind,
        classification,
        producerType: "model",
        producer: "m",
        attribution: "exact",
        confidence: null,
        decidedAt: receivedAt,
        automatedAnswer: kind === "lead_out_of_office",
        stopRequested: kind === "lead_opt_out_requested",
        notOurTarget: false,
        handedToPerson: kind === "lead_referral",
      },
      verdictCount: 1,
    };
  }

  it("serves the latest REAL reply on the standing, never the out-of-office before it", async () => {
    mockRows = [rawRow(1, REPLY_LED)];
    mockReplies = [
      verdictReply("lead-1@example.com", "2026-09-24T11:10:37Z", "lead_out_of_office", "neutral"),
      verdictReply("lead-1@example.com", "2026-09-28T04:52:00Z", "lead_referral", "neutral"),
    ];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&campaignId=${REPLY_LED}&view=basic`);

    const standing = res.body.leads[0].standing;
    expect(standing.replies.offer.latest.kind).toBe("lead_referral");
    expect(standing.replies.offer.machineReplies).toBe(1);
    // A referral is a hand-over to a person, never interest.
    expect(standing.state).toBe("engaged");
    expect(verdictRequests[0].emails).toEqual(["lead-1@example.com"]);
  });

  it("opts a person out on every campaign of the brand once they asked to stop in a reply", async () => {
    mockRows = [rawRow(1, FORM_MAGNET)];
    mockReplies = [verdictReply("lead-1@example.com", "2026-09-24T13:38:10Z", "lead_opt_out_requested", "negative", REPLY_LED)];

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&campaignId=${FORM_MAGNET}&view=basic`);

    const standing = res.body.leads[0].standing;
    expect(standing.state).toBe("opted_out");
    expect(standing.signal).toBe("opt_out_reply");
    expect(standing.replies.brand.optedOutAt).toBe("2026-09-24T13:38:10Z");
  });

  // Fail loud: instantly-service unreachable is stated, never read as "they never replied".
  it("says unresolved, reply_verdicts_unreadable, when the replies cannot be read", async () => {
    mockRows = [rawRow(1, REPLY_LED)];
    verdictsDown = true;

    const res = await get(app, `/orgs/leads?brandId=${BRAND}&view=basic`);

    expect(res.status).toBe(200);
    expect(res.body.leads[0].standing.state).toBe("unresolved");
    expect(res.body.leads[0].standing.reason).toBe("reply_verdicts_unreadable");
    expect(res.body.leads[0].contacted).toBe(true);
  });

  it("asks nothing of instantly-service on an unscoped read", async () => {
    mockRows = [rawRow(1, REPLY_LED)];
    const res = await get(app, `/orgs/leads?view=basic`);
    expect(res.status).toBe(200);
    expect(verdictRequests).toHaveLength(0);
    expect(res.body.leads[0].standing.replies).toBeNull();
  });
});
