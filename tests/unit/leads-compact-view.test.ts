import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// `view=compact` is what a consumer computing figures over a brand's WHOLE population reads. These
// tests pin its three promises: every field it carries equals the same field on `view=basic` for
// the same row (so a consumer switching views computes identical figures), it never pays for the
// audience / offer / standing resolution the other views run per chunk, and it is gzipped for a
// caller that accepts it while `view=basic` keeps its exact encoding.

// A count query (no ORDER BY) resolves to an empty result; nothing else reaches the database here
// because the basic walk itself is mocked below.
vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => ({ __sql: true, strings, values }),
}));

const streamBasicLeadChunksMock = vi.fn();
vi.mock("../../src/lib/basic-leads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/basic-leads.js")>()),
  streamBasicLeadChunks: (...args: unknown[]) => streamBasicLeadChunksMock(...args),
}));

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
}));

const resolveAudiencesMock = vi.fn().mockResolvedValue({ byAudienceId: {}, byEmail: {} });
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: (...args: unknown[]) => resolveAudiencesMock(...args),
}));

const standingResolveMock = vi.fn().mockResolvedValue(new Map());
vi.mock("../../src/lib/lead-standing-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/lead-standing-resolver.js")>()),
  createLeadStandingResolver: () => ({ resolve: (...args: unknown[]) => standingResolveMock(...args) }),
}));

const offerResolveMock = vi.fn().mockResolvedValue(new Map());
vi.mock("../../src/lib/offer-card-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/offer-card-client.js")>()),
  createOfferCardResolver: () => ({ resolve: (...args: unknown[]) => offerResolveMock(...args) }),
}));

const crmRepliesMock = vi.fn();
vi.mock("../../src/lib/crm-positive-reply-dates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/crm-positive-reply-dates.js")>()),
  fetchCrmPositiveReplyDates: (...args: unknown[]) => crmRepliesMock(...args),
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "50000000-0000-0000-0000-000000000001";

function scoped(overrides: Record<string, unknown>) {
  return {
    contacted: true, sent: true, delivered: true, opened: false, clicked: false, replied: false,
    replyClassification: null, bounced: false, unsubscribed: false, sentCount: 1,
    lastDeliveredAt: "2026-09-01T00:00:00.000Z", firstContactedAt: "2026-09-01T00:00:00.000Z",
    firstSentAt: "2026-09-01T00:00:00.000Z", firstDeliveredAt: "2026-09-01T00:00:00.000Z",
    firstOpenedAt: null, firstClickedAt: null, firstRepliedAt: null, firstBouncedAt: null,
    firstUnsubscribedAt: null,
    ...overrides,
  };
}

function basicRow(i: number, status: string) {
  return {
    id: `lc-${i}`,
    leadId: `lead-${i}`,
    campaignId: `camp-${i % 2}`,
    orgId: ORG,
    userId: null,
    brandIds: [BRAND],
    status,
    statusReason: null,
    statusDetails: null,
    parentRunId: "run-parent",
    runId: "run-1",
    servedAt: status === "served" ? "2026-09-01T00:00:00.000Z" : null,
    workflowSlug: `wf-${i}`,
    featureSlug: "sales-cold-emails",
    goal: null,
    activeGoalId: null,
    brandProfileId: null,
    audienceId: "aud-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    cursorCreatedAt: `2026-01-01 00:00:00.00000${i}+00`,
    leadApolloPersonId: `ap-${i}`,
    email: { value: `p${i}@x.com`, status: "verified" },
    lead: {
      leadId: `lead-${i}`,
      apolloPersonId: `ap-${i}`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      name: `First${i} Last${i}`,
      headline: "A long headline nobody computing a figure reads",
      linkedinUrl: "https://linkedin.com/in/x",
      photoUrl: `https://img/${i}.png`,
      seniority: "director",
      departments: ["sales"],
      functions: ["sales"],
      currentTitle: "Head of Sales",
      city: "Paris",
      state: null,
      country: "France",
      organization:
        i === 2
          ? null
          : {
              id: `org-${i}`,
              name: `Org ${i}`,
              logoUrl: `https://logo/${i}.png`,
              primaryDomain: `org${i}.com`,
              websiteUrl: `https://org${i}.com`,
              industry: "software",
              industries: ["software"],
              estimatedNumEmployees: 42,
              annualRevenue: "1M",
              foundedYear: 2001,
              shortDescription: "A company",
              city: "Lyon",
              state: null,
              country: "France",
            },
    },
  };
}

const ROWS = [
  basicRow(0, "served"),
  basicRow(1, "served"),
  basicRow(2, "served"),
  basicRow(3, "buffered"),
];

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/leads.js");
  app = express();
  app.use(express.json());
  app.use(route);
}, 30_000);

beforeEach(() => {
  streamBasicLeadChunksMock.mockReset();
  streamBasicLeadChunksMock.mockImplementation(async function* () {
    yield ROWS.map((r) => ({ ...r }));
  });
  checkDeliveryStatusMock.mockReset();
  checkDeliveryStatusMock.mockResolvedValue({
    results: [
      { email: "p0@x.com", broadcast: { brand: scoped({ clicked: true, opened: true }) } },
      {
        email: "p1@x.com",
        broadcast: { brand: scoped({ replied: true, replyClassification: "positive" }) },
      },
      { email: "p2@x.com", broadcast: { brand: scoped({ bounced: true, delivered: false }) } },
    ],
  });
  crmRepliesMock.mockReset();
  crmRepliesMock.mockResolvedValue(new Map([[`${BRAND}:lead-0`, "2026-09-21T13:45:00.000Z"]]));
  resolveAudiencesMock.mockClear();
  standingResolveMock.mockClear();
  offerResolveMock.mockClear();
});

function get(query: string) {
  return request(app)
    .get(`/orgs/leads${query}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG);
}

const COMPACT_KEYS = [
  "id", "leadId", "campaignId", "workflowSlug", "status", "email", "lead",
  "contacted", "sent", "delivered", "opened", "clicked", "bounced", "unsubscribed", "replied",
  "replyClassification", "crmPositiveReplyAt",
].sort();

describe("GET /orgs/leads?view=compact", () => {
  it("carries exactly the compact fields, and nothing a figure never reads", async () => {
    const res = await get(`?brandId=${BRAND}&view=compact&limit=5000`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(4);
    for (const lead of res.body.leads) expect(Object.keys(lead).sort()).toEqual(COMPACT_KEYS);
    expect(Object.keys(res.body.leads[0].lead).sort()).toEqual(
      ["firstName", "lastName", "photoUrl", "currentTitle", "seniority", "organization"].sort(),
    );
    expect(Object.keys(res.body.leads[0].lead.organization).sort()).toEqual(
      ["id", "name", "logoUrl", "primaryDomain", "websiteUrl", "industry", "estimatedNumEmployees", "city", "country"].sort(),
    );
    expect(res.body.leads[2].lead.organization).toBeNull();
    expect(res.body).toHaveProperty("nextCursor");
  });

  it("states every field EXACTLY as view=basic does for the same row", async () => {
    const basic = await get(`?brandId=${BRAND}&view=basic`);
    const compact = await get(`?brandId=${BRAND}&view=compact`);
    expect(basic.status).toBe(200);
    expect(compact.status).toBe(200);
    expect(compact.body.leads).toHaveLength(basic.body.leads.length);

    basic.body.leads.forEach((b: Record<string, any>, i: number) => {
      const c = compact.body.leads[i];
      for (const key of COMPACT_KEYS) {
        if (key === "lead" || key === "crmPositiveReplyAt") continue;
        expect(c[key], `${key} on row ${i}`).toEqual(b[key]);
      }
      for (const key of Object.keys(c.lead)) {
        if (key === "organization") continue;
        expect(c.lead[key], `lead.${key} on row ${i}`).toEqual(b.lead[key]);
      }
      if (b.lead.organization === null) {
        expect(c.lead.organization).toBeNull();
      } else {
        for (const key of Object.keys(c.lead.organization)) {
          expect(c.lead.organization[key], `organization.${key} on row ${i}`).toEqual(b.lead.organization[key]);
        }
      }
    });

    // The delivery overlay really is on the rows, so the equality above is not vacuous.
    expect(compact.body.leads[0].clicked).toBe(true);
    expect(compact.body.leads[1].replyClassification).toBe("positive");
    expect(compact.body.leads[2].bounced).toBe(true);
    // A row that was never served carries no evidence, exactly as on basic.
    expect(compact.body.leads[3].contacted).toBe(false);
  });

  it("carries the positive reply the customer's CRM evidences, per person, dated by the CRM", async () => {
    const res = await get(`?brandId=${BRAND}&view=compact`);
    expect(res.status).toBe(200);
    // lead-0 CLICKED and never replied by email — only its CRM form says it replied positively.
    expect(res.body.leads[0].replyClassification).toBeNull();
    expect(res.body.leads[0].crmPositiveReplyAt).toBe("2026-09-21T13:45:00.000Z");
    // lead-1 replied positively by email and nothing in the CRM: the two stay apart.
    expect(res.body.leads[1].replyClassification).toBe("positive");
    expect(res.body.leads[1].crmPositiveReplyAt).toBeNull();
    expect(crmRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("never resolves an audience, an offer or a standing", async () => {
    const res = await get(`?brandId=${BRAND}&view=compact`);
    expect(res.status).toBe(200);
    expect(checkDeliveryStatusMock).toHaveBeenCalledTimes(1);
    expect(resolveAudiencesMock).not.toHaveBeenCalled();
    expect(offerResolveMock).not.toHaveBeenCalled();
    expect(standingResolveMock).not.toHaveBeenCalled();
  });

  it("is gzip-encoded when the caller accepts it", async () => {
    // superagent decodes the body itself; the header is what proves the wire was compressed.
    const res = await get(`?brandId=${BRAND}&view=compact`).set("accept-encoding", "gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.body.leads).toHaveLength(4);
  });

  it("leaves view=basic's encoding untouched", async () => {
    const res = await get(`?brandId=${BRAND}&view=basic`).set("accept-encoding", "gzip");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("refuses include=campaigns rather than silently dropping it", async () => {
    const res = await get(`?brandId=${BRAND}&view=compact&include=campaigns`);
    expect(res.status).toBe(400);
    expect(streamBasicLeadChunksMock).not.toHaveBeenCalled();
  });
});
