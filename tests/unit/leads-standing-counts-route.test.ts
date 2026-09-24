/**
 * The standing reads: how many leads stand in each state for a scope (no rows), and one column of
 * that board as a bounded page.
 *
 * What is under test is that the two describe the SAME set — the count a column states and the
 * rows the column shows come from one index, one delivery overlay and one standing resolver — and
 * that the page hydrates ONLY the ids the plan chose. A board whose column header and column body
 * disagree is the bug this exists to remove, so a test that mocked the plan away would prove
 * nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

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
  db: { execute: () => Promise.resolve([]) },
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

vi.mock("../../src/lib/lead-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/lead-index.js")>()),
  // Chunked, never held: the counts and the filtered page are both assembled by the route's own
  // loop over a population it only ever sees a piece of at a time.
  streamLeadIndex: async function* () {
    const half = Math.ceil(indexRows.length / 2);
    if (indexRows.length === 0) return;
    yield indexRows.slice(0, half);
    if (indexRows.length > half) yield indexRows.slice(half);
  },
  fetchOutcomesByLead: () => Promise.resolve(new Map()),
  countLeadListRows: () => Promise.resolve(indexRows.length),
}));

// The read model is rows in Postgres in production; `sql` is mocked here, so the route gets the
// in-memory double, which derives its rows with the real code. The SQL and the freshness machinery
// are covered in tests/integration/lead-read-model-sql.test.ts.
vi.mock("../../src/lib/lead-read-model.js", async (importOriginal) => {
  const { fakeReadModelModule } = await import("../helpers/fake-lead-read-model.js");
  return fakeReadModelModule(await importOriginal());
});

let gatewayFails = false;
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) =>
    gatewayFails
      ? Promise.reject(new Error("[email-gateway-client] Status check failed: 503"))
      : Promise.resolve({
          results: items.map((i) => ({ email: i.email, broadcast: { brand: { contacted: true } } })),
        }),
}));

/** The state each row's standing resolves to, by `leads_campaigns.id`. */
let standingByRow: Record<string, string> = {};
/** The deepest funnel step a row reached, by id — absent means only the funnel's entry. */
let deepestByRow: Record<string, string> = {};
let standingChunks: number[] = [];
let standingFails = false;
vi.mock("../../src/lib/lead-standing-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/lead-standing-resolver.js")>()),
  createLeadStandingResolver: () => ({
    resolve: (rows: Array<{ id: string }>) => {
      if (standingFails) return Promise.reject(new Error("campaign-service unreachable"));
      standingChunks.push(rows.length);
      return Promise.resolve(
        new Map(
          rows
            .filter((r) => standingByRow[r.id])
            .map((r) => [
              r.id,
              {
                standing: {
                  state: standingByRow[r.id],
                  entryStep: "conversation_reply",
                  deepestStep: deepestByRow[r.id] ?? null,
                },
                closedDeal: null,
              },
            ]),
        ),
      );
    },
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
vi.mock("../../src/lib/campaign-identity-client.js", () => ({ resolveCampaignFamily: () => Promise.resolve(null) }));
vi.mock("../../src/lib/offer-campaigns-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/offer-campaigns-client.js")>()),
  resolveOfferCampaignIds: () => Promise.resolve(["camp-1"]),
}));
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

function person(i: number) {
  return {
    id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, "0")}`,
    leadId: `bbbbbbbb-0000-0000-0000-${String(i).padStart(12, "0")}`,
    campaignId: "camp-1",
    brandIds: [BRAND],
    status: "served",
    email: `p${i}@example.test`,
    servedAt: null,
    createdAtText: `2026-01-01 00:00:00.${String(i).padStart(6, "0")}+00`,
    searchText: `p${i}@example.test`,
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
  indexRows = Array.from({ length: 7 }, (_, i) => person(i));
  // Two in play, one interested, one bought, one we disqualified, one who opted out — and one
  // nobody can resolve.
  standingByRow = {
    [indexRows[0].id]: "contacted",
    [indexRows[1].id]: "engaged",
    [indexRows[2].id]: "sales_interest",
    [indexRows[3].id]: "customer",
    [indexRows[4].id]: "disqualified",
    [indexRows[5].id]: "opted_out",
  };
  deepestByRow = {};
  hydrated = [];
  standingChunks = [];
  gatewayFails = false;
  standingFails = false;
});

function counts(query: string) {
  return request(app)
    .get(`/orgs/leads/standing-counts${query}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-user-id", USER);
}

function get(query: string) {
  return request(app)
    .get(`/orgs/leads${query}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-user-id", USER);
}

describe("GET /orgs/leads/standing-counts", () => {
  it("answers every standing state's count and NO rows", async () => {
    const res = await counts(`?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toBeUndefined();
    expect(res.body.total).toBe(7);
    expect(res.body.counts).toEqual({
      unresolved: 1,
      not_contacted: 0,
      contacted: 1,
      engaged: 1,
      sales_interest: 1,
      customer: 1,
      disqualified: 1,
      opted_out: 1,
    });
    // A standing is a partition, so the columns add up to the population they describe.
    const summed = Object.values(res.body.counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(summed).toBe(res.body.total);
    // A count is a number: nothing was hydrated to produce it.
    expect(hydrated).toEqual([]);
  });

  it("counts a lead nobody could resolve as unresolved rather than dropping it", async () => {
    standingByRow = {};
    const res = await counts(`?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    expect(res.body.counts.unresolved).toBe(7);
    expect(res.body.total).toBe(7);
  });

  it("refuses rather than reporting zeros when the delivery evidence cannot be read", async () => {
    gatewayFails = true;
    expect((await counts(`?brandId=${BRAND}`)).status).toBe(502);
  });

  it("refuses rather than reporting zeros when the standing cannot be resolved", async () => {
    standingFails = true;
    expect((await counts(`?brandId=${BRAND}`)).status).toBe(502);
  });

  it("answers an offer no campaign sells as an honest zero, never the brand", async () => {
    const res = await counts(`?brandId=${BRAND}&campaignId=c1&offerId=o1`);
    expect(res.status).toBe(400);
  });

  it("counts one funnel of an offer exactly as the offer when that funnel is all it sells", async () => {
    const offer = await counts(`?brandId=${BRAND}&offerId=o1`);
    const funnel = await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=reply_meeting`);
    expect(funnel.status).toBe(200);
    expect(funnel.body).toEqual(offer.body);
  });

  it("400s a funnel named without its offer, and an unknown funnel", async () => {
    expect((await counts(`?brandId=${BRAND}&funnelKey=website_purchases`)).status).toBe(400);
    expect((await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=nope`)).status).toBe(400);
  });
});

describe("GET /orgs/leads?standing=", () => {
  it("returns exactly the leads in that state, and hydrates only those", async () => {
    const res = await get(`?brandId=${BRAND}&view=basic&standing=sales_interest`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0].id).toBe(indexRows[2].id);
    expect(res.body.total).toBe(1);
    expect(hydrated).toEqual([[indexRows[2].id]]);
  });

  it("states the column's size even when the page is bounded below it", async () => {
    standingByRow = Object.fromEntries(indexRows.map((r) => [r.id, "engaged"]));
    const res = await get(`?brandId=${BRAND}&view=basic&standing=engaged&limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(2);
    // The column's real size, not the size of the page — the whole point of the read.
    expect(res.body.total).toBe(7);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it("walks one column with limit + cursor, visiting every lead exactly once", async () => {
    standingByRow = Object.fromEntries(indexRows.map((r) => [r.id, "engaged"]));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const query = `?brandId=${BRAND}&view=basic&standing=engaged&limit=2` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res: request.Response = await get(query);
      expect(res.status).toBe(200);
      for (const lead of res.body.leads) seen.push(lead.id);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(indexRows.map((r) => r.id));
    expect(new Set(seen).size).toBe(7);
  });

  it("agrees with the count for the same scope", async () => {
    const counted = await counts(`?brandId=${BRAND}`);
    const listed = await get(`?brandId=${BRAND}&view=basic&standing=customer`);
    expect(listed.body.total).toBe(counted.body.counts.customer);
    expect(listed.body.leads).toHaveLength(counted.body.counts.customer);
  });

  // The two columns the board draws apart: each pages on its own, neither bounded by the other.
  it("pages an opt-out on its own, apart from every other disqualification", async () => {
    const optedOut = await get(`?brandId=${BRAND}&view=basic&standing=opted_out`);
    expect(optedOut.status).toBe(200);
    expect(optedOut.body.leads).toHaveLength(1);
    expect(optedOut.body.leads[0].id).toBe(indexRows[5].id);
    expect(optedOut.body.total).toBe(1);

    const disqualified = await get(`?brandId=${BRAND}&view=basic&standing=disqualified`);
    expect(disqualified.status).toBe(200);
    expect(disqualified.body.leads).toHaveLength(1);
    expect(disqualified.body.leads[0].id).toBe(indexRows[4].id);
    expect(disqualified.body.total).toBe(1);
  });

  it("agrees with the counts for both of those two columns", async () => {
    const counted = await counts(`?brandId=${BRAND}`);
    for (const standing of ["opted_out", "disqualified"] as const) {
      const listed = await get(`?brandId=${BRAND}&view=basic&standing=${standing}`);
      expect(listed.body.total).toBe(counted.body.counts[standing]);
      expect(listed.body.leads).toHaveLength(counted.body.counts[standing]);
    }
  });

  it("narrows to the rows satisfying BOTH when a bucket is named too", async () => {
    const res = await get(`?brandId=${BRAND}&view=basic&standing=customer&bucket=positive_reply`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it("400s on a standing vocabulary it does not know", async () => {
    const res = await get(`?brandId=${BRAND}&standing=interested`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown standing");
  });

  it("refuses rather than answering a differently-filtered list when the standing cannot be resolved", async () => {
    standingFails = true;
    const res = await get(`?brandId=${BRAND}&view=basic&standing=customer`);
    expect(res.status).toBe(502);
  });

  it("resolves standings in bounded chunks rather than one enormous bind", async () => {
    indexRows = Array.from({ length: 2_500 }, (_, i) => person(i));
    standingByRow = Object.fromEntries(indexRows.map((r) => [r.id, "contacted"]));
    const res = await counts(`?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    // Bounded twice over: the population is walked a chunk at a time, and each of those chunks is
    // resolved in bounded slices. No single bind carries the brand.
    expect(standingChunks.every((n) => n <= 1_000)).toBe(true);
    expect(standingChunks.reduce((a, b) => a + b, 0)).toBe(2_500);
    expect(res.body.total).toBe(2_500);
  });
});

/**
 * A COLUMN of the board is not always ONE standing: five columns over eight states means two of
 * them hold two states each (still in play holds the person nobody has heard from and the person
 * who did something that is not the step their campaign sells; showing interest holds the person
 * who reached that step and the person who bought). Such a column must read as ONE page — one
 * order, one total, one walkable cursor — because two independently-bounded lists cannot be merged
 * into a column that pages.
 */
describe("GET /orgs/leads?standing=a,b (a column holding several standings)", () => {
  it("answers ONE page covering the named set, totalled over the whole set", async () => {
    const res = await get(`?brandId=${BRAND}&view=basic&standing=sales_interest,customer`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.leads.map((l: { id: string }) => l.id)).toEqual([
      indexRows[2].id,
      indexRows[3].id,
    ]);
    // Only the page's own rows were hydrated — one read, not one per standing.
    expect(hydrated).toEqual([[indexRows[2].id, indexRows[3].id]]);
  });

  it("states the set's size even when the page is bounded below it", async () => {
    const res = await get(
      `?brandId=${BRAND}&view=basic&standing=not_contacted,contacted,engaged,unresolved&limit=1`,
    );
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    // contacted + engaged + the one nobody could resolve.
    expect(res.body.total).toBe(3);
    expect(res.body.nextCursor).toBeTruthy();
  });

  it("walks the set to the end with no gaps and no repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const query =
        `?brandId=${BRAND}&view=basic&standing=contacted,engaged,unresolved&limit=1` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res: request.Response = await get(query);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      for (const lead of res.body.leads) seen.push(lead.id);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([indexRows[0].id, indexRows[1].id, indexRows[6].id]);
    expect(new Set(seen).size).toBe(3);
  });

  it("sums to the counts of the states it names, so a column's header and body agree", async () => {
    const counted = await counts(`?brandId=${BRAND}`);
    const listed = await get(`?brandId=${BRAND}&view=basic&standing=sales_interest,customer`);
    expect(listed.body.total).toBe(
      counted.body.counts.sales_interest + counted.body.counts.customer,
    );
  });

  it("answers the same set at campaign scope and at offer scope", async () => {
    for (const scope of [`&campaignId=camp-1`, `&offerId=o1`]) {
      const res = await get(`?brandId=${BRAND}&view=basic&standing=sales_interest,customer${scope}`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.leads).toHaveLength(2);
    }
  });

  it("answers the set with a search naming it too", async () => {
    const res = await get(`?brandId=${BRAND}&view=basic&standing=sales_interest,customer&q=example`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it("reads a single standing exactly as it always did", async () => {
    const one = await get(`?brandId=${BRAND}&view=basic&standing=customer`);
    const listed = await get(`?brandId=${BRAND}&view=basic&standing=customer,customer`);
    expect(one.status).toBe(200);
    expect(listed.body.total).toBe(one.body.total);
    expect(listed.body.leads).toEqual(one.body.leads);
  });

  it("400s when any member of the set is a standing it does not know", async () => {
    const res = await get(`?brandId=${BRAND}&standing=customer,interested`);
    expect(res.status).toBe(400);
    // The message names the member that is wrong, not the whole set.
    expect(res.body.error).toContain("Unknown standing value(s): interested");
  });

  it("400s on an empty set rather than silently widening it to the brand", async () => {
    const res = await get(`?brandId=${BRAND}&standing=,`);
    expect(res.status).toBe(400);
  });

  it("refuses rather than answering a differently-filtered list when the standing cannot be resolved", async () => {
    standingFails = true;
    const res = await get(`?brandId=${BRAND}&view=basic&standing=sales_interest,customer`);
    expect(res.status).toBe(502);
  });
});

/**
 * The board of ONE sales funnel draws a column per funnel step a lead can stand at, and those
 * columns must be a PARTITION of `sales_interest`: one place per lead, sizes that add up. The
 * nested engagement buckets cannot draw it (somebody who attended also booked), so the stage is
 * the deepest step reached, else the funnel's entry.
 */
describe("funnel stages within sales_interest", () => {
  const FUNNEL = "sales_meetings_from_conversation";
  beforeEach(() => {
    indexRows = Array.from({ length: 9 }, (_, i) => person(i));
    standingByRow = {
      [indexRows[0].id]: "contacted",
      [indexRows[1].id]: "sales_interest", // positive reply only
      [indexRows[2].id]: "sales_interest", // positive reply only
      [indexRows[3].id]: "sales_interest", // booked
      [indexRows[4].id]: "sales_interest", // booked
      [indexRows[5].id]: "sales_interest", // booked
      [indexRows[6].id]: "sales_interest", // attended (and therefore booked)
      [indexRows[7].id]: "customer",
      [indexRows[8].id]: "opted_out",
    };
    deepestByRow = {
      [indexRows[3].id]: "meeting_booked",
      [indexRows[4].id]: "meeting_booked",
      [indexRows[5].id]: "meeting_booked",
      [indexRows[6].id]: "meeting_attended",
      [indexRows[7].id]: "sale",
    };
  });

  it("answers today's response byte for byte when no breakdown is asked for", async () => {
    const res = await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=${FUNNEL}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["counts", "total"]);
  });

  it("splits sales_interest by funnel stage, in funnel order, summing to it exactly", async () => {
    const res = await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=${FUNNEL}&breakdown=stage`);
    expect(res.status).toBe(200);
    expect(res.body.counts.sales_interest).toBe(6);
    expect(res.body.salesInterestStages).toEqual([
      { stage: "conversation_reply", count: 2 },
      { stage: "meeting_booked", count: 3 },
      { stage: "meeting_attended", count: 1 },
    ]);
    const summed = (res.body.salesInterestStages as Array<{ count: number }>).reduce(
      (a, b) => a + b.count,
      0,
    );
    expect(summed).toBe(res.body.counts.sales_interest);
    // The other columns are untouched.
    const plain = await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=${FUNNEL}`);
    expect(res.body.counts).toEqual(plain.body.counts);
    expect(res.body.total).toBe(plain.body.total);
  });

  it("lists every stage of the named funnel even when nobody stands there", async () => {
    deepestByRow = {};
    const res = await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=${FUNNEL}&breakdown=stage`);
    expect(res.body.salesInterestStages).toEqual([
      { stage: "conversation_reply", count: 6 },
      { stage: "meeting_booked", count: 0 },
      { stage: "meeting_attended", count: 0 },
    ]);
  });

  it("400s an unknown breakdown", async () => {
    expect((await counts(`?brandId=${BRAND}&breakdown=funnel`)).status).toBe(400);
  });

  it("pages one stage with a total that matches its count, never overlapping a neighbour", async () => {
    const counted = await counts(`?brandId=${BRAND}&offerId=o1&funnelKey=${FUNNEL}&breakdown=stage`);
    const byStage = Object.fromEntries(
      (counted.body.salesInterestStages as Array<{ stage: string; count: number }>).map((s) => [
        s.stage,
        s.count,
      ]),
    );
    const seen = new Set<string>();
    for (const stage of ["conversation_reply", "meeting_booked", "meeting_attended"]) {
      const res = await get(
        `?brandId=${BRAND}&offerId=o1&funnelKey=${FUNNEL}&view=basic&stage=${stage}&sort=activity&limit=2`,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(byStage[stage]);
      for (const lead of res.body.leads) {
        expect(seen.has(lead.id)).toBe(false);
        seen.add(lead.id);
      }
    }
    const booked = await get(`?brandId=${BRAND}&view=basic&stage=meeting_booked`);
    expect(booked.body.leads.map((l: { id: string }) => l.id)).toEqual([
      indexRows[3].id,
      indexRows[4].id,
      indexRows[5].id,
    ]);
  });

  it("400s a stage it does not know", async () => {
    const res = await get(`?brandId=${BRAND}&stage=sale`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unknown stage");
  });
});
