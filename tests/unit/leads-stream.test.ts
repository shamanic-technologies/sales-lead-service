import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mutable result set the mocked db query resolves to.
let mockRows: Array<Record<string, unknown>> = [];
let mockDbCallIndex = 0;

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => {
                const start = mockDbCallIndex * n;
                mockDbCallIndex += 1;
                return Promise.resolve(mockRows.slice(start, start + n));
              },
            }),
          }),
        }),
      }),
    }),
  },
}));

const fetchBasicLeadRowsMock = vi.fn();
vi.mock("../../src/lib/basic-leads.js", () => ({
  fetchBasicLeadRows: (...args: unknown[]) => fetchBasicLeadRowsMock(...args),
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
    createdAt: new Date(`2026-01-01T00:00:0${i}.000Z`),
    leadApolloPersonId: `apollo-${i}`,
  };
}

function basicRow(i: number, status = "buffered") {
  return {
    ...row(i, status),
    leadApolloPersonId: `apollo-lead-${i}`,
    servedAt: null,
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
  beforeEach(() => {
    mockRows = [];
    mockDbCallIndex = 0;
    fetchBasicLeadRowsMock.mockReset();
    fetchBasicLeadRowsMock.mockResolvedValue([]);
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

  it("view=basic returns the slim Gold projection without full-lead hydration", async () => {
    fetchBasicLeadRowsMock.mockResolvedValue([basicRow(1)]);
    const app = await buildApp();
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(fetchBasicLeadRowsMock).toHaveBeenCalledTimes(1);
    expect(fetchBasicLeadRowsMock).toHaveBeenCalledWith({
      orgId: ORG,
      brandId: BRAND,
      campaignId: undefined,
      queryOrgId: undefined,
      userId: undefined,
      workflowSlug: undefined,
    });
    expect(buildFullLeadsBatchMock).not.toHaveBeenCalled();
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

  it("view=basic applies delivery overlay in one batch over served slim rows", async () => {
    fetchBasicLeadRowsMock.mockResolvedValue([basicRow(1, "served"), basicRow(2, "served")]);
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
  });

  it("view absent returns the full lead shape (backward-compatible)", async () => {
    mockRows = [row(1)];
    const app = await buildApp();
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
