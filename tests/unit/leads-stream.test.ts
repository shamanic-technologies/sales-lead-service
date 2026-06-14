import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mutable result set the mocked db query resolves to.
let mockRows: Array<Record<string, unknown>> = [];

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => Promise.resolve(mockRows),
        }),
      }),
    }),
  },
}));

const buildFullLeadsBatchMock = vi.fn();
vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: (ids: string[]) => buildFullLeadsBatchMock(ids),
}));

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
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
      contacts: [{ channel: "email", value: `${id}@example.com`, status: "valid", source: "apollo" }],
      organization: null,
      employmentHistory: [],
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
    leadApolloPersonId: `apollo-${i}`,
  };
}

// Chunk size must be set BEFORE the route module is imported (read at module load).
process.env.LEADS_STREAM_CHUNK_SIZE = "2";

async function buildApp() {
  vi.resetModules();
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("GET /orgs/leads chunked streaming", () => {
  beforeEach(() => {
    mockRows = [];
    buildFullLeadsBatchMock.mockReset();
    buildFullLeadsBatchMock.mockImplementation((ids: string[]) => Promise.resolve(fullLeadMapFor(ids)));
    checkDeliveryStatusMock.mockReset();
    checkDeliveryStatusMock.mockResolvedValue({ results: [] });
  });

  it("returns { leads: [] } for an empty result set", async () => {
    const app = await buildApp();
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ leads: [] });
  });

  it("streams N rows spanning multiple chunks as one valid JSON, order preserved", async () => {
    mockRows = [row(1), row(2), row(3), row(4), row(5)];
    const app = await buildApp();
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
  });

  it("hydrates per chunk (ceil(N/chunk) batches, each <= chunk size)", async () => {
    mockRows = [row(1), row(2), row(3), row(4), row(5)];
    const app = await buildApp();
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

  it("applies delivery overlay to served rows within a chunk", async () => {
    mockRows = [row(1, "served")];
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: "lead-1@example.com",
          broadcast: { campaign: null, brand: { contacted: true, sent: true, delivered: true }, global: null },
          transactional: null,
        },
      ],
    });
    const app = await buildApp();
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.leads[0].delivered).toBe(true);
    expect(res.body.leads[0].sent).toBe(true);
    expect(checkDeliveryStatusMock).toHaveBeenCalledTimes(1);
  });
});
