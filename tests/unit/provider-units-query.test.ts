/**
 * Provider reads of our Units (ENGINE-GET-ASK-1123): the query a Script sends, the cursor, the vocabulary, and the
 * route's refusals (the SQL is covered against real Postgres in tests/integration/provider-units-sql.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const fetched: Array<{ fn: string; filters: Record<string, unknown> }> = [];
let failWith: Error | null = null;
vi.mock("../../src/lib/provider-units.js", () => {
  const stub = (fn: string) => async (...args: unknown[]) => {
    if (failWith) throw failWith;
    fetched.push({ fn, filters: args[args.length - 1] as Record<string, unknown> });
    return { units: [], nextCursor: null };
  };
  return { fetchLeadFoundUnits: stub("lead_found"), fetchCompanyResearchedUnits: stub("company_researched"), fetchFactUnits: stub("fact") };
});

const {
  FACT_UNIT_OUTCOMES,
  PROVIDER_UNIT_READS,
  UNIT_QUERY_PARAMS,
  UnitsQueryError,
  decodeUnitCursor,
  encodeUnitCursor,
  parseUnitsQuery,
  splitList,
} = await import("../../src/lib/provider-units-query.js");
const { FACT_OUTCOME_KEYS } = await import("../../src/lib/run-outcomes.js");
const { READ_QUERY_PARAMS } = await import("../../src/lib/read-query-vocabulary.js");
const router = (await import("../../src/routes/provider-units.js")).default;

const ORG = "org-1";
const LEAD = "3946e857-0000-4000-8000-000000000000";
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof UnitsQueryError) return e.code;
    throw e;
  }
  return "no error";
};

describe("the vocabulary: one read per outcome this service declares", () => {
  it("the fact outcomes are exactly the ones declared on the ledger (run-outcomes.ts)", () => {
    expect([...FACT_UNIT_OUTCOMES]).toEqual([...FACT_OUTCOME_KEYS]);
  });

  it("paths, operationIds and tags are the shipped ones (NEVER rename)", () => {
    expect(PROVIDER_UNIT_READS.map((r) => [r.path, r.operationId, r.tag])).toEqual([
      ["/orgs/units/lead-found", "listLeadFoundUnits", "provider:lead_found"],
      ["/orgs/units/company-researched", "listCompanyResearchedUnits", "provider:company_researched"],
      ["/orgs/units/website-visit", "listWebsiteVisitUnits", "provider:website_visit"],
      ["/orgs/units/signup", "listSignupUnits", "provider:signup"],
      ["/orgs/units/form-submitted", "listFormSubmittedUnits", "provider:form_submitted"],
      ["/orgs/units/purchase", "listPurchaseUnits", "provider:purchase"],
      ["/orgs/units/meeting-booked", "listMeetingBookedUnits", "provider:meeting_booked"],
      ["/orgs/units/meeting-attended", "listMeetingAttendedUnits", "provider:meeting_attended"],
      ["/orgs/units/paid-client", "listPaidClientUnits", "provider:paid_client"],
    ]);
  });

  it("crm-service's lead_identified is not ours to serve", () => {
    expect(PROVIDER_UNIT_READS.map((r) => r.outcome)).not.toContain("lead_identified");
  });

  it("every read is in the query vocabulary with its kind's parameters", () => {
    const vocabulary = READ_QUERY_PARAMS as Record<string, readonly string[]>;
    for (const read of PROVIDER_UNIT_READS) expect(vocabulary[read.vocabularyKey]).toEqual(UNIT_QUERY_PARAMS[read.kind]);
  });
});

describe("parseUnitsQuery", () => {
  it("normalises lists: comma or repeated, trimmed, lowercased, de-duplicated", () => {
    const f = parseUnitsQuery("lead_found", ORG, {
      emails: ["Jane@Acme.com, bob@acme.com", "jane@acme.com"],
      leadIds: LEAD.toUpperCase(),
      domains: "@Acme.com,beta.io",
    });
    expect(f.emails).toEqual(["jane@acme.com", "bob@acme.com"]);
    expect(f.leadIds).toEqual([LEAD]);
    expect(f.domains).toEqual(["acme.com", "beta.io"]);
    expect(f.limit).toBe(100);
    expect(f.orgId).toBe(ORG);
    expect(splitList(undefined)).toEqual([]);
  });

  it("requires a person filter or a brand: nobody lists a whole org by accident", () => {
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, {}))).toBe("person_or_brand_filter_required");
    expect(codeOf(() => parseUnitsQuery("fact", ORG, { since: "2026-01-01" }))).toBe("person_or_brand_filter_required");
    expect(codeOf(() => parseUnitsQuery("company_researched", ORG, { limit: "5" }))).toBe("person_or_brand_filter_required");
    // An `orgId` on the query (a staff key's target) is not a filter.
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { orgId: "other" }))).toBe("person_or_brand_filter_required");
  });

  it("a brand alone is allowed, and so is each person filter alone", () => {
    expect(parseUnitsQuery("lead_found", ORG, { brandId: "b1" }).brandId).toBe("b1");
    expect(parseUnitsQuery("fact", ORG, { emails: "a@b.co" }).emails).toEqual(["a@b.co"]);
    expect(parseUnitsQuery("fact", ORG, { leadIds: LEAD }).leadIds).toEqual([LEAD]);
    expect(parseUnitsQuery("company_researched", ORG, { domains: "acme.com" }).domains).toEqual(["acme.com"]);
  });

  it("refuses malformed values by name", () => {
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { emails: "not-an-address" }))).toBe("invalid_emails");
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { leadIds: "42" }))).toBe("invalid_leadIds");
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { domains: "https://acme.com" }))).toBe("invalid_domains");
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { brandId: "b", since: "yesterday" }))).toBe("invalid_since");
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { brandId: "b", until: "2026-13-45" }))).toBe("invalid_until");
    for (const limit of ["0", "1001", "abc", "1.5"]) expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { brandId: "b", limit }))).toBe("invalid_limit");
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { brandId: "b", cursor: "garbage" }))).toBe("invalid_cursor");
    const many = Array.from({ length: 101 }, (_, i) => `p${i}@acme.com`).join(",");
    expect(codeOf(() => parseUnitsQuery("lead_found", ORG, { emails: many }))).toBe("too_many_values");
  });

  it("reads since / until as UTC instants (a date, a zoned or a zone-less datetime)", () => {
    const f = parseUnitsQuery("fact", ORG, { brandId: "b", since: "2026-08-23", until: "2026-09-01T10:00:00+02:00" });
    expect(f.since).toBe("2026-08-23T00:00:00.000Z");
    expect(f.until).toBe("2026-09-01T08:00:00.000Z");
    expect(parseUnitsQuery("fact", ORG, { brandId: "b", since: "2026-08-23 10:00" }).since).toBe("2026-08-23T10:00:00.000Z");
  });

  it("notServedTo and campaignId belong to lead_found only", () => {
    const found = parseUnitsQuery("lead_found", ORG, { brandId: "b", notServedTo: "any_campaign", campaignId: "c1" });
    expect(found.notServedTo).toBe("any_campaign");
    expect(found.campaignId).toBe("c1");
    const fact = parseUnitsQuery("fact", ORG, { brandId: "b", notServedTo: "any_campaign", campaignId: "c1" });
    expect(fact.notServedTo).toBeUndefined();
    expect(fact.campaignId).toBeUndefined();
    expect(UNIT_QUERY_PARAMS.fact).not.toContain("notServedTo");
    expect(UNIT_QUERY_PARAMS.company_researched).not.toContain("emails");
  });

  it("a cursor round-trips, and only one this read minted decodes", () => {
    const cursor = { at: "2026-10-02T09:14:07.512345", unitId: "u-1" };
    const encoded = encodeUnitCursor(cursor);
    expect(decodeUnitCursor(encoded)).toEqual(cursor);
    expect(parseUnitsQuery("fact", ORG, { brandId: "b", cursor: encoded }).cursor).toEqual(cursor);
    const bad = Buffer.from(JSON.stringify(["2026-10-02", "u"]), "utf8").toString("base64url");
    expect(codeOf(() => decodeUnitCursor(bad))).toBe("invalid_cursor");
  });
});

describe("the routes", () => {
  const app = express();
  app.use(router);
  const get = (url: string) => request(app).get(url).set("x-api-key", "test-api-key").set("x-org-id", ORG);

  beforeEach(() => {
    fetched.length = 0;
    failWith = null;
  });

  it("every read answers 200 with the page shape and its own outcome", async () => {
    for (const read of PROVIDER_UNIT_READS) {
      const res = await get(`${read.path}?brandId=b1`);
      expect(res.status, read.path).toBe(200);
      expect(res.body).toEqual({ outcome: read.outcome, count: 0, units: [], nextCursor: null });
    }
    expect(fetched.map((f) => f.fn)).toEqual(["lead_found", "company_researched", ...FACT_UNIT_OUTCOMES.map(() => "fact")]);
    expect(fetched.every((f) => f.filters.orgId === ORG)).toBe(true);
  });

  it("no person and no brand = 400 person_or_brand_filter_required, nothing read", async () => {
    const res = await get("/orgs/units/lead-found?since=2026-01-01");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("person_or_brand_filter_required");
    expect(fetched).toEqual([]);
  });

  it("a query parameter the read does not know = 400 naming the accepted ones (never dropped)", async () => {
    const res = await get("/orgs/units/meeting-booked?brandId=b1&notServedTo=any_campaign");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("unknown_query_parameter");
    expect(res.body.unknown).toEqual(["notServedTo"]);
    expect(res.body.accepted).toContain("emails");
    const research = await get("/orgs/units/company-researched?emails=a@b.co");
    expect(research.status).toBe(400);
    expect(research.body.unknown).toEqual(["emails"]);
    expect(fetched).toEqual([]);
  });

  it("a staff key's target org on the query is accepted and never widens the scope", async () => {
    const res = await get("/orgs/units/signup?brandId=b1&orgId=someone-else");
    expect(res.status).toBe(200);
    expect(fetched[0].filters.orgId).toBe(ORG);
  });

  it("needs the api key and the org", async () => {
    expect((await request(app).get("/orgs/units/lead-found?brandId=b")).status).toBe(401);
    expect((await request(app).get("/orgs/units/lead-found?brandId=b").set("x-api-key", "test-api-key")).status).toBe(400);
  });

  it("a read failure is a 500, never an empty page", async () => {
    failWith = new Error("connection lost");
    const res = await get("/orgs/units/lead-found?brandId=b1");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("units_unreadable");
    expect(res.body.units).toBeUndefined();
  });
});
