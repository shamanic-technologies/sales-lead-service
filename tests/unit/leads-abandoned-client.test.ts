import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * A caller that opens a whole-population lead read and then disappears must not be able to hold a
 * database connection for as long as it likes.
 *
 * On 2026-09-07 it could: ten such reads took every connection of a pool whose ceiling was a
 * library default of ten, Postgres held ten backends at `state=active, wait_event_type=Client` for
 * 11h30m, and the service answered 503 until a human restarted the container. The walk is what
 * holds the connection, so the observable property is that the WALK STOPS and its generator is
 * cleaned up — not merely that the response is short.
 */

vi.mock("../../src/db/index.js", () => ({
  db: { execute: () => Promise.resolve([]) },
  sql: () => ({ then: (resolve: (rows: unknown[]) => void) => Promise.resolve([]).then(resolve) }),
}));

const streamBasicLeadChunksMock = vi.fn();
vi.mock("../../src/lib/basic-leads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/basic-leads.js")>()),
  streamBasicLeadChunks: (...args: unknown[]) => streamBasicLeadChunksMock(...args),
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: () => Promise.resolve(new Map()),
}));

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
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

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";

function basicRow(i: number) {
  return {
    id: `lc-${i}`,
    leadId: `lead-${i}`,
    campaignId: `camp-${i}`,
    orgId: ORG,
    userId: null,
    brandIds: [BRAND],
    status: "served",
    statusReason: null,
    statusDetails: null,
    parentRunId: null,
    runId: null,
    servedAt: "2026-01-01T00:00:00.000Z",
    workflowSlug: null,
    featureSlug: null,
    goal: null,
    activeGoalId: null,
    brandProfileId: null,
    audienceId: null,
    createdAt: "2026-01-01 00:00:00+00",
    cursorCreatedAt: "2026-01-01 00:00:00+00",
    leadApolloPersonId: `apollo-lead-${i}`,
    lead: { leadId: `lead-${i}`, apolloPersonId: `apollo-lead-${i}`, name: "Jane Doe" },
    email: { value: `lead-${i}@example.com`, status: "valid" },
  };
}

process.env.LEADS_STREAM_CHUNK_SIZE = "2";

/** The request of the read under test, so a case can make its caller disappear mid-walk. */
let captured: express.Request | null = null;

async function buildApp() {
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use((req, _res, next) => {
    captured = req;
    next();
  });
  app.use(route);
  return app;
}

describe("GET /orgs/leads when the caller goes away", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    captured = null;
    streamBasicLeadChunksMock.mockReset();
    checkDeliveryStatusMock.mockReset();
    checkDeliveryStatusMock.mockResolvedValue({ results: [] });
  });

  it("stops the walk and releases the chunk generator when the caller's socket closes", async () => {
    const chunksYielded: number[] = [];
    let cleanedUp = false;

    streamBasicLeadChunksMock.mockImplementation(async function* () {
      try {
        for (let chunk = 0; chunk < 100; chunk += 1) {
          chunksYielded.push(chunk);
          yield [basicRow(chunk * 2), basicRow(chunk * 2 + 1)];
          // The caller gives up right after the first chunk — the shape of an upstream HTTP
          // timeout abandoning the socket while the server is still streaming.
          if (chunk === 0) captured?.emit("close");
        }
      } finally {
        // postgres.js closes the cursor and hands the connection back when the walk is left; this
        // flag is that release, which is the property the incident was missing.
        cleanedUp = true;
      }
    });

    await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .catch(() => undefined);

    expect(cleanedUp).toBe(true);
    // Two chunks at most: the one already in flight when the socket closed, never the other 98.
    expect(chunksYielded.length).toBeLessThanOrEqual(2);
  });

  it("does no per-chunk gateway work after the caller is gone", async () => {
    streamBasicLeadChunksMock.mockImplementation(async function* () {
      yield [basicRow(1), basicRow(2)];
      captured?.emit("close");
      yield [basicRow(3), basicRow(4)];
      yield [basicRow(5), basicRow(6)];
    });

    await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .catch(() => undefined);

    // The first chunk's overlay was fetched; nothing was fetched for the chunks after the caller
    // stopped listening.
    expect(checkDeliveryStatusMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("still walks a whole large population to the end while the caller is listening", async () => {
    // 66,000 rows is the largest brand in production; 33,000 chunks of two prove the guard bounds
    // an ABANDONED read and not a legitimately large one.
    const total = 66_000;
    let yielded = 0;
    streamBasicLeadChunksMock.mockImplementation(async function* () {
      for (let i = 0; i < total; i += 2) {
        yielded += 2;
        yield [basicRow(i), basicRow(i + 1)];
      }
    });

    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&view=basic`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(yielded).toBe(total);
    expect(res.body.leads).toHaveLength(total);
  }, 120_000);
});
