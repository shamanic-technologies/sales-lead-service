/**
 * The population-level reads: bucket counts with no rows, a bucket filter, a search, and an order
 * that follows what happened to each person rather than when we first saw them.
 *
 * What is under test is the WIRING — that the route reads the scope's model, chooses the page from
 * it, and then hydrates ONLY those ids, in that order. The evidence itself is mocked
 * (email-gateway, the outcome ledger); what must not be mocked away is that the ids the plan chose
 * are the ids the hydration query is given, because a read that quietly hydrates something else is
 * a page that disagrees with its own count.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { fakeModelSearches } from "../helpers/fake-lead-read-model.js";

interface SqlNode { __sql: true; strings: readonly string[]; values: unknown[] }
function isNode(v: unknown): v is SqlNode {
  return !!v && typeof v === "object" && (v as SqlNode).__sql === true;
}

let hydrated: string[][] = [];

/** The `rowIds` an index-driven read hydrates by, read straight off the compiled query. */
function readRowIds(node: SqlNode): string[] | null {
  let ids: string[] | null = null;
  node.strings.forEach((s, i) => {
    if (/lc\.id = ANY\(\s*$/.test(s)) ids = node.values[i] as string[];
  });
  for (const v of node.values) {
    if (!isNode(v)) continue;
    ids = ids ?? readRowIds(v);
  }
  return ids;
}

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const node: SqlNode = { __sql: true, strings, values };
    const text = strings.join(" ");
    if (!/ORDER BY lc\.created_at/.test(text)) return node;
    return {
      then: (resolve: (rows: unknown[]) => void) => {
        const ids = readRowIds(node);
        hydrated.push(ids ?? []);
        const rows = (ids ?? indexRows.map((r) => r.id)).map((id) => rawRow(id));
        return Promise.resolve(rows).then(resolve);
      },
    };
  },
}));

let indexRows: Array<{
  id: string;
  leadId: string;
  campaignId: string;
  brandIds: string[];
  status: string;
  email: string | null;
  servedAt: string | null;
  createdAtText: string;
  searchText: string;
}> = [];
let outcomes = new Map<string, { steps: Set<string>; latestAt: string | null }>();

vi.mock("../../src/lib/lead-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/lead-index.js")>()),
  // The population is walked in CHUNKS and never held; two here, so the route's own loop is what
  // assembles the read rather than one convenient array.
  streamLeadIndex: async function* () {
    const half = Math.ceil(indexRows.length / 2);
    if (indexRows.length === 0) return;
    yield indexRows.slice(0, half);
    if (indexRows.length > half) yield indexRows.slice(half);
  },
  fetchOutcomesByLead: () => Promise.resolve(outcomes),
  countLeadListRows: () => Promise.resolve(indexRows.length),
}));

// The read model is rows in Postgres in production; `sql` is mocked here, so the route gets the
// in-memory double, which derives its rows with the real code. The SQL and the freshness machinery
// are covered in tests/integration/lead-read-model-sql.test.ts.
vi.mock("../../src/lib/lead-read-model.js", async (importOriginal) => {
  const { fakeReadModelModule } = await import("../helpers/fake-lead-read-model.js");
  return fakeReadModelModule(await importOriginal());
});

let statusByEmail: Record<string, Record<string, unknown>> = {};
let gatewayFails = false;
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) =>
    gatewayFails
      ? Promise.reject(new Error("[email-gateway-client] Status check failed: 503"))
      : Promise.resolve({
          results: items
            .filter((i) => statusByEmail[i.email])
          .map((i) => ({ email: i.email, broadcast: { brand: statusByEmail[i.email] } })),
        }),
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: (ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, { leadId: id, contacts: [] }]))),
}));
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: vi.fn().mockResolvedValue({ byAudienceId: {}, byEmail: {} }),
}));
vi.mock("../../src/lib/offer-card-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/offer-card-client.js")>()),
  createOfferCardResolver: () => ({ resolve: () => Promise.resolve(new Map()) }),
}));
vi.mock("../../src/lib/lead-standing-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/lead-standing-resolver.js")>()),
  createLeadStandingResolver: () => ({ resolve: () => Promise.resolve(new Map()) }),
}));
vi.mock("../../src/lib/campaign-identity-client.js", () => ({ resolveCampaignFamily: () => Promise.resolve(null) }));
vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const USER = "40000000-0000-0000-0000-000000000001";
const BRAND = "50000000-0000-0000-0000-000000000001";

function rawRow(id: string) {
  const index = indexRows.find((r) => r.id === id)!;
  return {
    id,
    lead_id: index.leadId,
    campaign_id: index.campaignId,
    org_id: ORG,
    user_id: null,
    brand_ids: [BRAND],
    status: index.status,
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
    created_at: index.createdAtText,
    created_at_cursor: index.createdAtText,
    lead_apollo_person_id: null,
  };
}

function person(i: number, email: string | null = `p${i}@example.test`) {
  return {
    id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
    leadId: `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, "0")}`,
    campaignId: "camp-1",
    brandIds: [BRAND],
    status: "served",
    email,
    servedAt: null,
    createdAtText: `2026-01-01 00:00:00.${String(i).padStart(6, "0")}+00`,
    searchText: `Person\n${i}\nTitle\nCompany${i}\n${email ?? ""}`,
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
  indexRows = Array.from({ length: 6 }, (_, i) => person(i));
  statusByEmail = {
    "p0@example.test": { contacted: true, sent: true, firstSentAt: "2026-02-01T00:00:00.000Z" },
    "p1@example.test": { contacted: true, clicked: true, firstClickedAt: "2026-02-02T00:00:00.000Z" },
    "p2@example.test": {
      contacted: true,
      replied: true,
      replyClassification: "positive",
      firstRepliedAt: "2026-02-03T00:00:00.000Z",
    },
  };
  outcomes = new Map([[indexRows[3].leadId, { steps: new Set(["sale"]), latestAt: "2026-03-01T00:00:00.000Z" }]]);
  hydrated = [];
  fakeModelSearches.length = 0;
  gatewayFails = false;
});

function get(query: string) {
  return request(app)
    .get(`/orgs/leads${query}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-user-id", USER);
}

function counts(query: string) {
  return request(app)
    .get(`/orgs/leads/bucket-counts${query}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-user-id", USER);
}

describe("GET /orgs/leads/bucket-counts", () => {
  it("answers every bucket's count and NO rows", async () => {
    const res = await counts(`?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toBeUndefined();
    expect(res.body.total).toBe(6);
    expect(res.body.counts).toMatchObject({
      contacted: 3,
      website_visit: 1,
      positive_reply: 1,
      sale: 1,
      signup: 0,
      meeting_booked: 0,
      meeting_attended: 0,
      form_submission: 0,
    });
    // A count is a number: nothing was hydrated to produce it.
    expect(hydrated).toEqual([]);
  });

  it("refuses rather than reporting zero when the evidence cannot be read", async () => {
    gatewayFails = true;
    try {
      const res = await counts(`?brandId=${BRAND}`);
      expect(res.status).toBe(502);
    } finally {
      gatewayFails = false;
    }
  });

  it("400s on a bucket vocabulary it does not know", async () => {
    expect((await get(`?brandId=${BRAND}&bucket=everyone`)).status).toBe(400);
    expect((await get(`?brandId=${BRAND}&sort=relevance`)).status).toBe(400);
    expect((await get(`?brandId=${BRAND}&q=`)).status).toBe(400);
    expect((await get(`?brandId=${BRAND}&format=xlsx`)).status).toBe(400);
  });
});

describe("GET /orgs/leads — one bucket at a time", () => {
  it("returns only that bucket's people, and says how many there are", async () => {
    const res = await get(`?brandId=${BRAND}&bucket=contacted&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.leads).toHaveLength(2);
    expect(res.body.nextCursor).toBeTruthy();
    // ONLY the page's ids were hydrated — not the bucket, and not the brand.
    expect(hydrated).toEqual([[indexRows[0].id, indexRows[1].id]]);
  });

  it("pages a bucket without repeating or skipping anybody", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await get(
        `?brandId=${BRAND}&bucket=contacted&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...res.body.leads.map((l: { id: string }) => l.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("orders newest-first on what happened to each person when asked to", async () => {
    const res = await get(`?brandId=${BRAND}&sort=activity&limit=4`);
    expect(res.body.leads.map((l: { id: string }) => l.id)).toEqual([
      indexRows[3].id, // a sale, in March
      indexRows[2].id, // a reply
      indexRows[1].id, // a click
      indexRows[0].id, // a send
    ]);
  });

  it("searches the whole scope's model rather than filtering a page", async () => {
    const res = await get(`?brandId=${BRAND}&q=person%20company4&limit=2`);
    expect(res.status).toBe(200);
    expect(fakeModelSearches).toEqual([["person", "company4"]]);
    expect(res.body.total).toBe(1);
    expect(hydrated).toEqual([[indexRows[4].id]]);
  });
});

describe("GET /orgs/leads — unchanged when nothing new is named", () => {
  it("never indexes, never counts, and answers exactly what it always did", async () => {
    const res = await get(`?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(6);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.total).toBeUndefined();
    expect(fakeModelSearches).toEqual([]);
  });
});

describe("GET /orgs/leads?format=csv", () => {
  it("exports the whole matching set as a file, header first", async () => {
    const res = await get(`?brandId=${BRAND}&bucket=contacted&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="leads-/);
    const lines = res.text.trim().split("\n");
    // Headed in the words the page uses, never in the field names the JSON carries.
    expect(lines[0]).toContain('"Email"');
    expect(lines[0]).toContain('"Website visit"');
    expect(lines[0]).toContain('"Reply sentiment"');
    expect(lines[0]).not.toContain('"clicked"');
    // A yes/no fact reads as a word, not as a raw boolean token.
    expect(lines[1]).toMatch(/"(Yes|No)"/);
    expect(lines[1]).not.toContain('"true"');
    expect(lines[1]).not.toContain('"false"');
    // Three contacted people, one line each — no paging involved.
    expect(lines).toHaveLength(4);
  });
});
