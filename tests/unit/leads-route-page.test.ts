import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Same bound-honouring `sql` mock as lead-list-walk.test.ts, pointed at the FULL path's query:
// a handler that accepts `limit` and drops it must fail here.
interface SqlNode {
  __sql: true;
  strings: readonly string[];
  values: unknown[];
}

let mockRows: Array<Record<string, unknown>> = [];
let executed: Array<{ limit: number | null; offset: number | null; cursorId: string | null }> = [];

function isNode(v: unknown): v is SqlNode {
  return !!v && typeof v === "object" && (v as SqlNode).__sql === true;
}

function readBounds(node: SqlNode): { limit: number | null; offset: number | null; cursorId: string | null } {
  let limit: number | null = null;
  let offset: number | null = null;
  let cursorId: string | null = null;
  node.strings.forEach((s, i) => {
    if (/LIMIT\s*$/.test(s)) limit = node.values[i] as number;
    if (/OFFSET\s*$/.test(s)) offset = node.values[i] as number;
    if (/lc\.id\)\s*>\s*\(\s*$/.test(s)) cursorId = node.values[i + 1] as string;
  });
  for (const v of node.values) {
    if (!isNode(v)) continue;
    const nested = readBounds(v);
    limit = limit ?? nested.limit;
    offset = offset ?? nested.offset;
    cursorId = cursorId ?? nested.cursorId;
  }
  return { limit, offset, cursorId };
}

// Bind-faithful: postgres.js calls Buffer.byteLength() on every param, which THROWS on a Date
// before the query is ever sent. A mock that ignores params lets a handler that binds a raw Date
// ship green and 500 on the first production request — assert it here instead.
function assertBindable(values: unknown[]): void {
  for (const v of values) {
    if (isNode(v)) { assertBindable(v.values); continue; }
    if (v instanceof Date) {
      throw new TypeError(
        'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date',
      );
    }
  }
}

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const node: SqlNode = { __sql: true, strings, values };
    if (!/ORDER BY lc\.created_at/.test(strings.join(" "))) return node;
    return {
      then: (resolve: (rows: unknown[]) => void) => {
        assertBindable(node.values);
        const { limit, offset, cursorId } = readBounds(node);
        executed.push({ limit, offset, cursorId });
        let rows = cursorId === null ? mockRows : mockRows.filter((r) => (r.id as string) > cursorId);
        if (offset) rows = rows.slice(offset);
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve(rows).then(resolve);
      },
    };
  },
}));

const streamBasicLeadChunksMock = vi.fn();
vi.mock("../../src/lib/basic-leads.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/basic-leads.js")>()),
  streamBasicLeadChunks: (...args: unknown[]) => streamBasicLeadChunksMock(...args),
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: (ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, { leadId: id, contacts: [] }]))),
}));

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: vi.fn().mockResolvedValue({ results: [] }),
}));

const resolveBrandMembershipsByEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: vi.fn().mockResolvedValue({ byAudienceId: {}, byEmail: {} }),
  resolveBrandMembershipsByEmail: (...args: unknown[]) => resolveBrandMembershipsByEmailMock(...args),
}));
vi.mock("../../src/lib/sourcing-origin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sourcing-origin.js")>()),
  loadOriginNamesByList: () => Promise.resolve(new Map()),
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const USER = "40000000-0000-0000-0000-000000000001";

function rawRow(i: number) {
  return {
    id: `lc-${String(i).padStart(4, "0")}`,
    lead_id: `lead-${i}`,
    campaign_id: null,
    org_id: ORG,
    user_id: null,
    brand_ids: [],
    status: "buffered",
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
    // A STRING, not a Date: postgres.js (prepare:false) hands timestamptz back either way, and on
    // this path it is a string in production. Building a cursor from it used to throw
    // `toISOString is not a function` mid-stream, which destroys the socket instead of 500ing.
    created_at: `2026-01-01 00:00:00.00000${i % 10}+00`,
    // The cursor is built from the ::text column so the walk keeps every microsecond.
    created_at_cursor: `2026-01-01 00:00:00.00000${i % 10}+00`,
    lead_apollo_person_id: null,
  };
}

function basicRow(i: number) {
  return {
    ...rawRow(i),
    leadId: `lead-${i}`,
    campaignId: null,
    orgId: ORG,
    userId: null,
    brandIds: [],
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
    createdAt: "2026-01-01 00:00:00+00",
    cursorCreatedAt: "2026-01-01 00:00:00.000001+00",
    leadApolloPersonId: null,
    lead: null,
    email: null,
  };
}

process.env.LEADS_STREAM_CHUNK_SIZE = "10";

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/leads.js");
  app = express();
  app.use(express.json());
  app.use(route);
}, 30_000);

beforeEach(() => {
  mockRows = Array.from({ length: 57 }, (_, i) => rawRow(i));
  executed = [];
  streamBasicLeadChunksMock.mockReset();
});

function get(query: string) {
  return request(app)
    .get(`/orgs/leads${query}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-user-id", USER);
}

describe("GET /orgs/leads — caller-supplied bound", () => {
  it("returns the whole population when the caller names no bound (unchanged for existing callers)", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(57);
    expect(res.body.nextCursor).toBeNull();
  });

  it("returns at most N leads when the caller asks for N", async () => {
    const res = await get("?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(5);
    expect(res.body.nextCursor).toBeTruthy();
    // The bound reached the database — the other 52 rows were never read.
    expect(executed).toEqual([{ limit: 5, offset: null, cursorId: null }]);
  });

  it("walks the rest deterministically, with no gaps and no repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard += 1) {
      const res = await get(`?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.leads.map((l: { id: string }) => l.id));
      cursor = res.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(57);
    expect(new Set(seen).size).toBe(57);
    expect(seen).toEqual(mockRows.map((r) => r.id));
  });

  it("honours offset as the positional form of the same walk", async () => {
    const res = await get("?limit=4&offset=50");
    expect(res.body.leads.map((l: { id: string }) => l.id)).toEqual(
      mockRows.slice(50, 54).map((r) => r.id),
    );
  });

  it("says the walk is over when the last page comes back short", async () => {
    const res = await get("?limit=100");
    expect(res.body.leads).toHaveLength(57);
    expect(res.body.nextCursor).toBeNull();
  });

  it("bounds the slim projection too, by forwarding the page to the basic-view walk", async () => {
    streamBasicLeadChunksMock.mockImplementation(async function* () {
      yield [basicRow(0), basicRow(1)];
    });
    const res = await get("?view=basic&limit=2");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.nextCursor).toBeTruthy();
    expect(streamBasicLeadChunksMock.mock.calls[0][2]).toEqual({ limit: 2, cursor: null, offset: null });
  });

  it("400s on a bound it cannot honour, rather than answering with everything", async () => {
    await expect(get("?limit=0").then((r) => r.status)).resolves.toBe(400);
    await expect(get("?limit=abc").then((r) => r.status)).resolves.toBe(400);
    await expect(get("?offset=-1").then((r) => r.status)).resolves.toBe(400);
    await expect(get("?cursor=garbage").then((r) => r.status)).resolves.toBe(400);
    const both = await get("?cursor=garbage&offset=1");
    expect(both.status).toBe(400);
  });
});
