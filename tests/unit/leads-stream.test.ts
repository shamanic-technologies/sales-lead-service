import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mutable result set the mocked sql query resolves to (snake_case raw rows, the
// shape postgres.js returns; fetchLeadCampaignChunk maps them to camelCase).
let mockRows: Array<Record<string, unknown>> = [];
let mockSqlChunkIndex = 0;

// `sql` is a postgres.js tagged template. Every call returns a thenable; only the
// OUTER executed query is ever awaited (fragments built by leadCampaignBaseRelation
// and the conditional AND/cursor clauses are interpolated, never awaited), so each
// `await fetchLeadCampaignChunk` advances exactly one chunk. Chunk size mirrors the
// LEADS_STREAM_CHUNK_SIZE env the route reads at import.
vi.mock("../../src/db/index.js", () => ({
  sql: () => ({
    then: (resolve: (rows: unknown[]) => void) => {
      const chunk = Math.max(1, Number(process.env.LEADS_STREAM_CHUNK_SIZE) || 500);
      const start = mockSqlChunkIndex * chunk;
      mockSqlChunkIndex += 1;
      return Promise.resolve(mockRows.slice(start, start + chunk)).then(resolve);
    },
  }),
}));

const streamBasicLeadChunksMock = vi.fn();
vi.mock("../../src/lib/basic-leads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/basic-leads.js")>()),
  streamBasicLeadChunks: (...args: unknown[]) => streamBasicLeadChunksMock(...args),
}));

const buildFullLeadsBatchMock = vi.fn();
vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: (ids: string[]) => buildFullLeadsBatchMock(ids),
}));

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
}));

const resolveAudiencesMock = vi.fn();
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiences: (...args: unknown[]) => resolveAudiencesMock(...args),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";

// Default: one FullLead per requested leadId, each carrying a primary email contact.
function fullLeadMapFor(ids: string[]) {
  const m = new Map<string, unknown>();
  for (const id of ids) {
    m.set(id, {
      leadId: id,
      apolloPersonId: `apollo-${id}`,
      firstName: "Jane",
      lastName: "Doe",
      name: "Jane Doe",
      headline: "CEO",
      linkedinUrl: "https://linkedin.com/in/jane",
      photoUrl: "https://example.com/jane.jpg",
      contacts: [{ channel: "email", value: `${id}@example.com`, status: "valid", source: "apollo" }],
      organization: {
        id: `org-${id}`,
        name: "Acme",
        logoUrl: "https://example.com/acme.png",
        primaryDomain: "acme.com",
        websiteUrl: "https://acme.com",
        // Heavy fields that view=basic must drop:
        annualRevenue: "1000000",
        keywords: ["a", "b", "c"],
        seoDescription: "long".repeat(50),
        industries: ["software"],
      },
      // Heavy field that view=basic must drop entirely:
      employmentHistory: [{ organizationId: `org-${id}`, title: "CEO", current: true }],
    });
  }
  return m;
}

function row(i: number, status = "buffered") {
  return {
    id: `lc-${i}`,
    leadId: `lead-${i}`,
    campaignId: `camp-${i}`,
    orgId: ORG,
    userId: null,
    brandIds: [BRAND],
    status,
    statusReason: null,
    statusDetails: null,
    parentRunId: null,
    runId: null,
    servedAt: null,
    workflowSlug: null,
    featureSlug: null,
    goal: null,
    activeGoalId: null,
    brandProfileId: null,
    audienceId: null,
    createdAt: new Date(`2026-01-01T00:00:0${i}.000Z`),
    leadApolloPersonId: `apollo-${i}`,
  };
}

// Snake_case raw row, the postgres.js shape the deduped full-path query returns.
function rawRow(i: number, status = "buffered") {
  return {
    id: `lc-${i}`,
    lead_id: `lead-${i}`,
    campaign_id: `camp-${i}`,
    org_id: ORG,
    user_id: null,
    brand_ids: [BRAND],
    status,
    status_reason: null,
    status_details: null,
    parent_run_id: null,
    run_id: null,
    served_at: null,
    workflow_slug: null,
    feature_slug: null,
    goal: null,
    active_goal_id: null,
    brand_profile_id: null,
    audience_id: null,
    created_at: new Date(`2026-01-01T00:00:0${i}.000Z`),
    lead_apollo_person_id: `apollo-${i}`,
  };
}

function basicRow(i: number, status = "buffered") {
  return {
    ...row(i, status),
    leadApolloPersonId: `apollo-lead-${i}`,
    servedAt: "2026-01-01T00:00:00.000Z",
    lead: {
      leadId: `lead-${i}`,
      apolloPersonId: `apollo-lead-${i}`,
      firstName: "Jane",
      lastName: "Doe",
      name: "Jane Doe",
      headline: "CEO",
      linkedinUrl: "https://linkedin.com/in/jane",
      photoUrl: "https://example.com/jane.jpg",
      organization: {
        id: `org-lead-${i}`,
        name: "Acme",
        logoUrl: "https://example.com/acme.png",
        primaryDomain: "acme.com",
        websiteUrl: "https://acme.com",
      },
    },
    email: { value: `lead-${i}@example.com`, status: "valid" },
  };
}

async function* basicChunks(chunks: Array<ReturnType<typeof basicRow>[]>) {
  for (const chunk of chunks) yield chunk;
}

// Chunk size must be set BEFORE the route module is imported (read at module load).
process.env.LEADS_STREAM_CHUNK_SIZE = "2";

async function buildApp() {
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("GET /orgs/leads chunked streaming", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    mockRows = [];
    mockSqlChunkIndex = 0;
    streamBasicLeadChunksMock.mockReset();
    streamBasicLeadChunksMock.mockImplementation(() => basicChunks([]));
    buildFullLeadsBatchMock.mockReset();
    buildFullLeadsBatchMock.mockImplementation((ids: string[]) => Promise.resolve(fullLeadMapFor(ids)));
    checkDeliveryStatusMock.mockReset();
    checkDeliveryStatusMock.mockResolvedValue({ results: [] });
    resolveAudiencesMock.mockReset();
    resolveAudiencesMock.mockResolvedValue(new Map());
  });

  it("returns { leads: [] } for an empty result set", async () => {
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ leads: [] });
  });

  it("streams N rows spanning multiple chunks as one valid JSON, order preserved", async () => {
    mockRows = [rawRow(1), rawRow(2), rawRow(3), rawRow(4), rawRow(5)];
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    // supertest only parses res.body if the streamed bytes are valid JSON — proves
    // commas/brackets across chunk boundaries are correct.
    expect(Array.isArray(res.body.leads)).toBe(true);
    expect(res.body.leads).toHaveLength(5);
    expect(res.body.leads.map((l: { id: string }) => l.id)).toEqual([
      "lc-1", "lc-2", "lc-3", "lc-4", "lc-5",
    ]);
    expect(res.body.leads[0].email).toBe("lead-1@example.com");
    expect(res.body.leads[0].apolloPersonId).toBe("apollo-1");
    expect(res.body.leads[0].audienceId).toBeNull();
    // audience is present on every lead, null when no active audience resolves.
    expect(res.body.leads[0].audience).toBeNull();
  });

  it("attaches the resolved audience card per lead (full view)", async () => {
    mockRows = [rawRow(1), rawRow(2)];
    resolveAudiencesMock.mockResolvedValue(
      new Map([["lead-1", { id: "aud-1", name: "US SaaS founders", avatarUrl: "https://cdn/x.png" }]]),
    );

    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    // human-service is asked with the scoped brandId + each lead's identity keys.
    expect(resolveAudiencesMock).toHaveBeenCalled();
    expect(resolveAudiencesMock.mock.calls[0][0]).toBe(BRAND);
    expect(res.body.leads[0].audience).toEqual({
      id: "aud-1",
      name: "US SaaS founders",
      avatarUrl: "https://cdn/x.png",
    });
    // lead-2 has no active audience => null (absent from the map).
    expect(res.body.leads[1].audience).toBeNull();
  });

  it("attaches the resolved audience card per lead (view=basic)", async () => {
    streamBasicLeadChunksMock.mockImplementationOnce(() => basicChunks([[basicRow(1)]]));
    resolveAudiencesMock.mockResolvedValue(
      new Map([["lead-1", { id: "aud-9", name: "EU ecommerce", avatarUrl: null }]]),
    );

    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.leads[0].audience).toEqual({ id: "aud-9", name: "EU ecommerce", avatarUrl: null });
  });

  it("fails loud when audience resolution errors (does not blank to null)", async () => {
    mockRows = [rawRow(1)];
    resolveAudiencesMock.mockRejectedValue(new Error("human-service 502"));

    // Resolution runs before the chunk is written; the stream is aborted, so the
    // client sees an error rather than a 200 with a silently-blank audience.
    await expect(
      request(app)
        .get(`/orgs/leads?brandId=${BRAND}`)
        .set("x-api-key", "test-api-key")
        .set("x-org-id", ORG),
    ).rejects.toThrow();
  });

  it("normalizes a postgres string served_at on the full path (no toISOString crash)", async () => {
    // postgres.js can return timestamptz as a raw string; the full path used to call
    // .toISOString() on it and crash mid-stream (TypeError: ...toISOString is not a function).
    mockRows = [{ ...rawRow(1, "served"), served_at: "2026-01-01 00:00:01.5+00" }];
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].servedAt).toBe("2026-01-01T00:00:01.500Z");
  });

  it("hydrates per chunk (ceil(N/chunk) batches, each <= chunk size)", async () => {
    mockRows = [rawRow(1), rawRow(2), rawRow(3), rawRow(4), rawRow(5)];
    await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    // 5 rows / chunk 2 => 3 batches
    expect(buildFullLeadsBatchMock).toHaveBeenCalledTimes(3);
    for (const call of buildFullLeadsBatchMock.mock.calls) {
      expect(call[0].length).toBeLessThanOrEqual(2);
    }
  });

  it("view=basic returns the slim Gold projection without full-lead hydration", async () => {
    streamBasicLeadChunksMock.mockImplementationOnce(() => basicChunks([[basicRow(1)]]));
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(streamBasicLeadChunksMock).toHaveBeenCalledTimes(1);
    expect(streamBasicLeadChunksMock.mock.calls[0]).toEqual([
      {
        orgId: ORG,
        brandId: BRAND,
        campaignId: undefined,
        queryOrgId: undefined,
        userId: undefined,
        workflowSlug: undefined,
      },
      2,
    ]);
    expect(buildFullLeadsBatchMock).not.toHaveBeenCalled();
    expect(res.body.leads[0].servedAt).toBe("2026-01-01T00:00:00.000Z");
    const lead = res.body.leads[0].lead;
    // Kept fields
    expect(lead.firstName).toBe("Jane");
    expect(lead.headline).toBe("CEO");
    expect(lead.organization).toEqual({
      id: "org-lead-1",
      name: "Acme",
      logoUrl: "https://example.com/acme.png",
      primaryDomain: "acme.com",
      websiteUrl: "https://acme.com",
    });
    // Dropped fields
    expect(lead.employmentHistory).toBeUndefined();
    expect(lead.contacts).toBeUndefined();
    expect(lead.organization.annualRevenue).toBeUndefined();
    expect(lead.organization.keywords).toBeUndefined();
    expect(lead.organization.seoDescription).toBeUndefined();
  });

  it("view=basic streams multiple slim chunks as one valid JSON response", async () => {
    streamBasicLeadChunksMock.mockImplementationOnce(() => basicChunks([
      [basicRow(1), basicRow(2)],
      [basicRow(3)],
    ]));
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.leads.map((l: { id: string }) => l.id)).toEqual(["lc-1", "lc-2", "lc-3"]);
    expect(streamBasicLeadChunksMock).toHaveBeenCalledTimes(1);
    expect(buildFullLeadsBatchMock).not.toHaveBeenCalled();
  });

  it("view=basic applies delivery overlay in one batch over served slim rows", async () => {
    streamBasicLeadChunksMock.mockImplementationOnce(() => basicChunks([
      [basicRow(1, "served"), basicRow(2, "served")],
    ]));
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: "lead-1@example.com",
          broadcast: {
            campaign: null,
            brand: {
              contacted: true, sent: true, delivered: true, opened: true,
              firstContactedAt: "2026-01-01T00:00:00.000Z",
              firstSentAt: "2026-01-01T00:01:00.000Z",
              firstDeliveredAt: "2026-01-01T00:02:00.000Z",
              firstOpenedAt: "2026-01-02T00:00:00.000Z",
              firstRepliedAt: null,
              firstBouncedAt: null,
              firstUnsubscribedAt: null,
            },
            global: null,
          },
          transactional: null,
        },
      ],
    });
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(buildFullLeadsBatchMock).not.toHaveBeenCalled();
    expect(checkDeliveryStatusMock).toHaveBeenCalledTimes(1);
    expect(checkDeliveryStatusMock.mock.calls[0][2]).toEqual([
      { email: "lead-1@example.com" },
      { email: "lead-2@example.com" },
    ]);
    expect(res.body.leads[0].delivered).toBe(true);
    expect(res.body.leads[1].delivered).toBe(false);
    // Per-event first-occurrence timestamps mapped through onto the slim row (view=basic).
    expect(res.body.leads[0].firstContactedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(res.body.leads[0].firstSentAt).toBe("2026-01-01T00:01:00.000Z");
    expect(res.body.leads[0].firstDeliveredAt).toBe("2026-01-01T00:02:00.000Z");
    expect(res.body.leads[0].firstOpenedAt).toBe("2026-01-02T00:00:00.000Z");
    // Events that never occurred in scope are null.
    expect(res.body.leads[0].firstRepliedAt).toBeNull();
    expect(res.body.leads[0].firstBouncedAt).toBeNull();
    expect(res.body.leads[0].firstUnsubscribedAt).toBeNull();
    // A row with no status result at all carries all-null timeline fields.
    expect(res.body.leads[1].firstContactedAt).toBeNull();
    expect(res.body.leads[1].firstOpenedAt).toBeNull();
  });

  it("view absent returns the full lead shape (backward-compatible)", async () => {
    mockRows = [rawRow(1)];
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    const lead = res.body.leads[0].lead;
    expect(Array.isArray(lead.employmentHistory)).toBe(true);
    expect(lead.organization.annualRevenue).toBe("1000000");
    expect(lead.organization.keywords).toEqual(["a", "b", "c"]);
  });

  it("applies delivery overlay to served rows within a chunk", async () => {
    mockRows = [rawRow(1, "served")];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: "lead-1@example.com",
          broadcast: {
            campaign: null,
            brand: {
              contacted: true, sent: true, delivered: true, opened: true,
              firstContactedAt: "2026-01-01T00:00:00.000Z",
              firstOpenedAt: "2026-01-02T00:00:00.000Z",
              firstRepliedAt: null,
            },
            global: null,
          },
          transactional: null,
        },
      ],
    });
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.leads[0].delivered).toBe(true);
    expect(res.body.leads[0].sent).toBe(true);
    // Per-event first-occurrence timestamps mapped through onto the full row too.
    expect(res.body.leads[0].firstContactedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(res.body.leads[0].firstOpenedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(res.body.leads[0].firstRepliedAt).toBeNull();
    expect(checkDeliveryStatusMock).toHaveBeenCalledTimes(1);
  });
});
