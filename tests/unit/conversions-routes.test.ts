import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.fn();
const matchConversion = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CONVERSION_INGEST_URL: "https://api.distribute.you/public/conversions",
}));

// Keep the pure helpers real; only stub the DB-backed waterfall.
vi.mock("../../src/lib/conversions.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, matchConversion: (...a: unknown[]) => matchConversion(...a) };
});

const dialect = new PgDialect();
function compile(call: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(call as SQL);
}
function lastSql(): string {
  const call = execute.mock.calls[execute.mock.calls.length - 1][0];
  return compile(call).sql.toLowerCase();
}
function sqlAt(i: number): string {
  return compile(execute.mock.calls[i][0]).sql.toLowerCase();
}

// Faithfully reproduce postgres.js `Bind`: a raw `sql` template hands params straight to
// the driver, which cannot serialize a JS `Date` (it does `Buffer.byteLength(value)` and
// throws `ERR_INVALID_ARG_TYPE ... Received an instance of Date`). The plain vi.fn() mock
// never serializes params, which is exactly why the 100%-broken handler shipped green
// (#357). Assert-on-bind here so a raw-Date param 500s in tests just like it did in prod.
function assertBindable(call: unknown): void {
  for (const p of compile(call).params) {
    if (p instanceof Date) {
      throw new TypeError(
        'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date',
      );
    }
  }
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/conversions.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  // Mirror index.ts 500 handler so wrapped async rejections surface as 500.
  app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("POST /public/conversions", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    matchConversion.mockReset();
  });

  it("401 on missing token", async () => {
    const res = await request(app).post("/public/conversions").send({ event: "signup" });
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("401 on unknown token (token lookup empty)", async () => {
    execute.mockResolvedValueOnce([]); // token lookup → no row
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_nope")
      .send({ event: "signup", email: "x@y.com" });
    expect(res.status).toBe(401);
  });

  it("400 on missing/invalid event", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token ok
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ email: "x@y.com" });
    expect(res.status).toBe(400);
    expect(matchConversion).not.toHaveBeenCalled();
  });

  it("valid email match → 200 {received:true}, stores attributed/deterministic", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token
    execute.mockResolvedValueOnce([]); // dedupe check → no dup
    execute.mockResolvedValueOnce([]); // insert
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: "lead-1",
      matchMethod: "email",
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      candidateCount: 1,
    });

    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "signup", email: "Jane@Acme.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // last execute = insert into conversion_events with the attribution
    expect(lastSql()).toContain("insert into conversion_events");
    const insertParams = compile(execute.mock.calls[2][0]).params;
    expect(insertParams).toContain("attributed");
    expect(insertParams).toContain("deterministic");
    expect(insertParams).toContain("lead-1");
  });

  it("accepts a 'sale' event with revenue → stores canonical 'sale' + value_cents", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token
    execute.mockResolvedValueOnce([]); // dedupe check → no dup
    execute.mockResolvedValueOnce([]); // insert
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: "lead-1",
      matchMethod: "email",
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      candidateCount: 1,
    });
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "sale", email: "Jane@Acme.com", valueCents: 4900 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const insertParams = compile(execute.mock.calls[2][0]).params;
    expect(insertParams).toContain("sale");
    expect(insertParams).toContain(4900);
  });

  it("accepts the legacy 'purchase' spelling → normalizes to canonical 'sale' before store + dedupe", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token
    execute.mockResolvedValueOnce([]); // dedupe check → no dup
    execute.mockResolvedValueOnce([]); // insert
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: "lead-1",
      matchMethod: "email",
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      candidateCount: 1,
    });
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "purchase", email: "Jane@Acme.com", valueCents: 4900 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // Stored event is canonical "sale", NEVER the legacy "purchase" spelling …
    const insertParams = compile(execute.mock.calls[2][0]).params;
    expect(insertParams).toContain("sale");
    expect(insertParams).not.toContain("purchase");
    // … and the dedupe signature is keyed on the canonical event too.
    expect(
      insertParams.some(
        (p) => typeof p === "string" && p.startsWith("a:sale:jane@acme.com:"),
      ),
    ).toBe(true);
  });

  // Regression for #357: the INSERT bound `received_at` as a raw `Date`, which threw at
  // postgres.js Bind time (a client-side throw invisible to raw-SQL/EXECUTE tests), so
  // EVERY real conversion 500'd in prod while ping (SQL `now()`, no Date param) worked.
  // These tests drive the real handler through a Bind-faithful mock: they FAIL (500) on
  // the old `${now}` code and PASS on the `${now.toISOString()}` fix.
  it("real signup conversion → 200 + persists conversion_events with a serializable received_at (AC1)", async () => {
    const rowsByCall: unknown[][] = [
      [{ brand_id: "brand-1", org_id: "org-1" }], // token lookup
      [], // dedupe check → no dup
      [], // insert
    ];
    let i = 0;
    execute.mockImplementation((call: unknown) => {
      assertBindable(call); // throws on a raw Date param, exactly like postgres.js in prod
      return Promise.resolve(rowsByCall[i++] ?? []);
    });
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: "lead-1",
      matchMethod: "email",
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      candidateCount: 1,
    });

    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "signup", email: "Jane@Acme.com", firstName: "Jane", lastName: "Doe" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // the insert actually ran (3rd execute call) …
    const insert = compile(execute.mock.calls[2][0]);
    expect(insert.sql.toLowerCase()).toContain("insert into conversion_events");
    expect(insert.params).toContain("attributed");
    expect(insert.params).toContain("lead-1");
    // … with every bound param serializable — received_at is an ISO string, never a Date.
    expect(insert.params.some((p) => p instanceof Date)).toBe(false);
    expect(insert.params).toContainEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/));
  });

  it("bare signup (no identity) → 200 + persists unmatched row, null dedupe_signature, no Date param (AC2)", async () => {
    const rowsByCall: unknown[][] = [
      [{ brand_id: "brand-1", org_id: "org-1" }], // token lookup
      [], // insert (no dedupe SELECT: no dedupeKey/email/phone → signature null)
    ];
    let i = 0;
    execute.mockImplementation((call: unknown) => {
      assertBindable(call);
      return Promise.resolve(rowsByCall[i++] ?? []);
    });
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: null,
      matchMethod: null,
      matchConfidence: "unmatched",
      attributionStatus: "unmatched",
      candidateCount: 0,
    });

    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "signup" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(execute).toHaveBeenCalledTimes(2); // token lookup + insert only (no dedupe SELECT)
    const insert = compile(execute.mock.calls[1][0]);
    expect(insert.sql.toLowerCase()).toContain("insert into conversion_events");
    expect(insert.params).toContain("unmatched");
    expect(insert.params.some((p) => p instanceof Date)).toBe(false);
  });

  it("accepts Authorization: Bearer token", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]);
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: null,
      matchMethod: "last_name",
      matchConfidence: "probabilistic",
      attributionStatus: "needs_review",
      candidateCount: 1,
    });
    const res = await request(app)
      .post("/public/conversions")
      .set("Authorization", "Bearer pk_conv_ok")
      .send({ event: "signup", lastName: "Doe" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("lastName-only match stores attributed (name is enough), NOT needs_review", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token
    execute.mockResolvedValueOnce([]); // dedupe (signature null → actually skipped; see below)
    matchConversion.mockResolvedValueOnce({
      matchedLeadId: "lead-7",
      matchMethod: "last_name",
      matchConfidence: "probabilistic",
      attributionStatus: "attributed",
      candidateCount: 2,
    });
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "signup", lastName: "Doe" });
    expect(res.status).toBe(200);
    // no email/phone/dedupeKey → dedupe signature is null → no dedupe SELECT, straight to insert.
    expect(lastSql()).toContain("insert into conversion_events");
    const insertParams = compile(execute.mock.calls[execute.mock.calls.length - 1][0]).params;
    expect(insertParams).toContain("attributed");
    expect(insertParams).toContain("lead-7");
    expect(insertParams).not.toContain("needs_review");
  });

  it("duplicate dedupeKey → 200, no second attribution insert", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token
    execute.mockResolvedValueOnce([{ "1": 1 }]); // dedupe check → existing row found
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "signup", email: "x@y.com", dedupeKey: "dup-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(matchConversion).not.toHaveBeenCalled();
    // only token lookup + dedupe check ran; NO insert.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sqlAt(1)).toContain("from conversion_events");
    expect(sqlAt(1)).not.toContain("insert");
  });

  it("500 when the DB errors (fail loud, not a hung socket)", async () => {
    execute.mockRejectedValueOnce(new Error("db down")); // token lookup throws
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "signup", email: "x@y.com" });
    expect(res.status).toBe(500);
  });

  it("ping heartbeat → 200 {received:true}, stamps last_ping_at, NO attribution/insert", async () => {
    execute.mockResolvedValueOnce([{ brand_id: "brand-1", org_id: "org-1" }]); // token
    execute.mockResolvedValueOnce([]); // update last_ping_at
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_ok")
      .send({ event: "ping" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // ping never runs the match waterfall and never touches conversion_events.
    expect(matchConversion).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2); // token lookup + last_ping_at update only
    const updateSql = lastSql();
    expect(updateSql).toContain("update brand_conversion_tokens");
    expect(updateSql).toContain("last_ping_at");
    expect(updateSql).not.toContain("conversion_events");
  });

  it("ping still requires a valid token (401, no update)", async () => {
    execute.mockResolvedValueOnce([]); // token lookup → no row
    const res = await request(app)
      .post("/public/conversions")
      .set("x-conversion-token", "pk_conv_nope")
      .send({ event: "ping" });
    expect(res.status).toBe(401);
    expect(execute).toHaveBeenCalledTimes(1); // only the token lookup
  });
});

describe("GET /orgs/brands/:brandId/conversion-token", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => execute.mockReset().mockResolvedValue([]));

  it("401 without x-api-key", async () => {
    const res = await request(app).get("/orgs/brands/brand-1/conversion-token");
    expect(res.status).toBe(401);
  });

  it("400 without x-org-id", async () => {
    const res = await request(app)
      .get("/orgs/brands/brand-1/conversion-token")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(400);
  });

  it("nothing received → not_set_up, both timestamps null, eventTypesSeen []", async () => {
    execute.mockResolvedValueOnce([{ token: "pk_conv_existing", last_ping_at: null }]); // upsert
    execute.mockResolvedValueOnce([{ last_event_at: null, event_types: null }]); // agg
    const res = await request(app)
      .get("/orgs/brands/brand-1/conversion-token")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: "pk_conv_existing",
      ingestUrl: "https://api.distribute.you/public/conversions",
      status: "not_set_up",
      lastEventAt: null,
      lastPingAt: null,
      eventTypesSeen: [],
    });
    expect(sqlAt(0)).toContain("insert into brand_conversion_tokens");
    expect(sqlAt(0)).toContain("on conflict");
    expect(sqlAt(0)).not.toContain("excluded.token"); // GET must NOT replace the token
    expect(sqlAt(0)).toContain("last_ping_at"); // RETURNING now carries the ping time
    expect(sqlAt(1)).toContain("from conversion_events"); // liveness overlay aggregate
  });

  it("ping received, no real conversion → live_waiting, lastPingAt set, eventTypesSeen still []", async () => {
    execute.mockResolvedValueOnce([
      { token: "pk_conv_existing", last_ping_at: new Date("2026-07-06T11:59:00.000Z") },
    ]);
    execute.mockResolvedValueOnce([{ last_event_at: null, event_types: null }]);
    const res = await request(app)
      .get("/orgs/brands/brand-1/conversion-token")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("live_waiting");
    expect(res.body.lastPingAt).toBe("2026-07-06T11:59:00.000Z");
    expect(res.body.lastEventAt).toBeNull();
    expect(res.body.eventTypesSeen).toEqual([]);
  });

  it("real conversion received → live, lastEventAt set, eventTypesSeen has signup (never ping)", async () => {
    execute.mockResolvedValueOnce([
      { token: "pk_conv_existing", last_ping_at: new Date("2026-07-06T11:59:00.000Z") },
    ]);
    execute.mockResolvedValueOnce([
      { last_event_at: "2026-07-06T12:00:00.000Z", event_types: ["signup"] },
    ]);
    const res = await request(app)
      .get("/orgs/brands/brand-1/conversion-token")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("live");
    expect(res.body.lastEventAt).toBe("2026-07-06T12:00:00.000Z");
    expect(res.body.eventTypesSeen).toEqual(["signup"]);
    expect(res.body.eventTypesSeen).not.toContain("ping");
  });
});

describe("GET /internal/brands/:brandId/conversion-counts", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    // The route first asks which hand-stated website visits the delivery layer already measured.
    // No such row for these brands → no email-gateway call, and the counts query follows.
    execute.mockResolvedValueOnce([]);
  });

  it("401 without x-api-key", async () => {
    const res = await request(app).get("/internal/brands/brand-1/conversion-counts");
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("zero conversions → 200 with all four keys at 0 (never 404)", async () => {
    execute.mockResolvedValueOnce([]); // count query → no rows
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ signup: 0, meeting_booked: 0, meeting_attended: 0, form_submission: 0, sale: 0, website_visit: 0, purchase: 0 });
  });

  it("counts real attributed events per type; missing types default to 0", async () => {
    execute.mockResolvedValueOnce([
      { event: "signup", n: 12 },
      { event: "sale", n: 2 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    // Canonical "sale" plus the legacy "purchase" mirror (same value) for the rename window.
    expect(res.body.counts).toEqual({ signup: 12, meeting_booked: 0, meeting_attended: 0, form_submission: 0, sale: 2, website_visit: 0, purchase: 2 });
  });

  it("folds a legacy 'purchase'-spelled row into the canonical 'sale' bucket", async () => {
    // A historical row stored before the rename backfill still carries "purchase".
    execute.mockResolvedValueOnce([
      { event: "sale", n: 3 },
      { event: "purchase", n: 4 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ signup: 0, meeting_booked: 0, meeting_attended: 0, form_submission: 0, sale: 7, website_visit: 0, purchase: 7 });
  });

  it("query is deduped-at-write, attributed-only, and ping-excluded", async () => {
    execute.mockResolvedValueOnce([]);
    await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    // The FIRST query is the measured-visit lookup (which hand-stated visits the delivery layer
    // already measured); the counts query is the second.
    const q = sqlAt(1);
    // Counts stored conversion_events rows (already deduped at write via the partial
    // unique index), grouped per event type.
    expect(q).toContain("from conversion_events");
    expect(q).toContain("group by ce.event");
    // Only conversions credited to a lead we emailed for the brand.
    expect(q).toContain("attribution_status = 'attributed'");
    // "ping" never lands in conversion_events, so it cannot leak into the counts —
    // and the handler only ever emits the four real event-type keys.
    expect(q).not.toContain("ping");
    const params = compile(execute.mock.calls[1][0]).params;
    expect(params).toContain("brand-1");
  });

  it("an unexpected event value in a row never leaks into the response", async () => {
    execute.mockResolvedValueOnce([
      { event: "signup", n: 3 },
      { event: "ping", n: 99 }, // must be ignored (isConversionEvent guard)
      { event: "garbage", n: 7 }, // must be ignored
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ signup: 3, meeting_booked: 0, meeting_attended: 0, form_submission: 0, sale: 0, website_visit: 0, purchase: 0 });
    expect(Object.keys(res.body.counts).sort()).toEqual(
      [
        "form_submission",
        "meeting_attended",
        "meeting_booked",
        "purchase",
        "sale",
        "signup",
        "website_visit",
      ].sort(),
    );
  });

  it("500 when the DB errors (fail loud)", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(500);
  });

  it("splits the same rows by who said so — tracker + manual === counts (AC: hand-stated is distinguishable)", async () => {
    execute.mockResolvedValueOnce([
      { event: "signup", source: "tracker", n: 12 },
      { event: "sale", source: "manual", n: 1 },
      { event: "meeting_booked", source: "manual", n: 4 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    // What every existing consumer reads keeps totalling BOTH sources.
    expect(res.body.counts.signup).toBe(12);
    expect(res.body.counts.sale).toBe(1);
    expect(res.body.counts.meeting_booked).toBe(4);
    expect(res.body.bySource.tracker.signup).toBe(12);
    expect(res.body.bySource.manual.signup).toBe(0);
    // The 4 booked meetings and 1 closed deal that lived as notes elsewhere, representable.
    expect(res.body.bySource.manual.meeting_booked).toBe(4);
    expect(res.body.bySource.manual.sale).toBe(1);
    for (const key of Object.keys(res.body.counts)) {
      expect(res.body.bySource.tracker[key] + res.body.bySource.manual[key]).toBe(
        res.body.counts[key],
      );
    }
  });

  it("counts a hand-stated meeting_attended exactly like the four the tracker reports", async () => {
    execute.mockResolvedValueOnce([{ event: "meeting_attended", source: "manual", n: 3 }]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts.meeting_attended).toBe(3);
    expect(res.body.bySource.manual.meeting_attended).toBe(3);
  });

  it("a row written before the source column existed counts as tracker-reported", async () => {
    execute.mockResolvedValueOnce([{ event: "signup", source: "tracker", n: 2 }]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.body.bySource.tracker.signup).toBe(2);
  });
});

describe("GET /internal/brands/:brandId/conversion-counts-by-day", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    execute.mockResolvedValueOnce([]); // measured-visit lookup: nothing to suppress
  });

  it("401 without x-api-key", async () => {
    const res = await request(app).get("/internal/brands/brand-1/conversion-counts-by-day");
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("zero conversions → 200, all four byDay empty + all-zero undated (never 404)", async () => {
    execute.mockResolvedValueOnce([]); // per-day query → no rows
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      byDay: { signup: {}, meeting_booked: {}, meeting_attended: {}, form_submission: {}, sale: {}, website_visit: {}, purchase: {} },
      undated: { signup: 0, meeting_booked: 0, meeting_attended: 0, form_submission: 0, sale: 0, website_visit: 0, purchase: 0 },
    });
  });

  it("buckets attributed conversions by day per event type; missing types stay empty/0", async () => {
    execute.mockResolvedValueOnce([
      { event: "signup", day: "2026-07-08", n: 2 },
      { event: "signup", day: "2026-07-09", n: 1 },
      { event: "form_submission", day: "2026-07-09", n: 3 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      byDay: {
        signup: { "2026-07-08": 2, "2026-07-09": 1 },
        meeting_booked: {},
        meeting_attended: {},
        form_submission: { "2026-07-09": 3 },
        sale: {},
        website_visit: {},
        purchase: {},
      },
      undated: { signup: 0, meeting_booked: 0, meeting_attended: 0, form_submission: 0, sale: 0, website_visit: 0, purchase: 0 },
    });
  });

  it("a null day is counted as undated (explicit), never dropped nor dated (AC2/AC4)", async () => {
    execute.mockResolvedValueOnce([
      { event: "signup", day: "2026-07-08", n: 2 },
      { event: "signup", day: null, n: 1 },
      { event: "sale", day: null, n: 4 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.byDay.signup).toEqual({ "2026-07-08": 2 });
    // Canonical "sale" plus the legacy "purchase" mirror (same value).
    expect(res.body.undated).toEqual({
      signup: 1,
      meeting_booked: 0,
      meeting_attended: 0,
      form_submission: 0,
      sale: 4,
      website_visit: 0,
      purchase: 4,
    });
  });

  it("sum(byDay) + undated reconciles to the conversion-counts total per event (AC3)", async () => {
    // Same brand, same attributed set — /conversion-counts would return signup: 4 (3 dated + 1 undated).
    execute.mockResolvedValueOnce([
      { event: "signup", day: "2026-07-08", n: 2 },
      { event: "signup", day: "2026-07-09", n: 1 },
      { event: "signup", day: null, n: 1 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    const dated = Object.values(res.body.byDay.signup as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(dated + res.body.undated.signup).toBe(4);
  });

  it("query is attributed-only, deduped-at-write, buckets by UTC day, and never fabricates a date", async () => {
    execute.mockResolvedValueOnce([]);
    await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    const q = sqlAt(1);
    expect(q).toContain("from conversion_events");
    expect(q).toContain("group by ce.event, day");
    // Same attributed-only set as /conversion-counts (reconciliation guarantee).
    expect(q).toContain("attribution_status = 'attributed'");
    // UTC calendar-day bucketing, matching the ingest dedupe UTC-day convention.
    expect(q).toContain("at time zone 'utc'");
    // Undated stays undated — a NULL received_at is bucketed as NULL, never coalesced to a date.
    expect(q).toContain("received_at is null");
    expect(q).not.toContain("ping");
    const params = compile(execute.mock.calls[0][0]).params;
    expect(params).toContain("brand-1");
  });

  it("an unexpected event value in a row never leaks into the response", async () => {
    execute.mockResolvedValueOnce([
      { event: "signup", day: "2026-07-08", n: 3 },
      { event: "ping", day: "2026-07-08", n: 99 }, // must be ignored (isConversionEvent guard)
      { event: "garbage", day: null, n: 7 }, // must be ignored
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.byDay.signup).toEqual({ "2026-07-08": 3 });
    expect(Object.keys(res.body.byDay).sort()).toEqual(
      [
        "form_submission",
        "meeting_attended",
        "meeting_booked",
        "purchase",
        "sale",
        "signup",
        "website_visit",
      ].sort(),
    );
    expect(res.body.undated).toEqual({
      signup: 0,
      meeting_booked: 0,
      meeting_attended: 0,
      form_submission: 0,
      sale: 0,
      website_visit: 0,
      purchase: 0,
    });
  });

  it("500 when the DB errors (fail loud)", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(500);
  });
});

describe("GET /internal/brands/:brandId/converted-lead-emails", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => execute.mockReset().mockResolvedValue([]));

  it("401 without x-api-key", async () => {
    const res = await request(app).get(
      "/internal/brands/brand-1/converted-lead-emails?event=form_submission",
    );
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 when event is missing", async () => {
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 when event is not a real conversion type (ping/garbage rejected)", async () => {
    for (const bad of ["ping", "garbage"]) {
      execute.mockClear();
      const res = await request(app)
        .get(`/internal/brands/brand-1/converted-lead-emails?event=${bad}`)
        .set("x-api-key", "test-api-key");
      expect(res.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("zero attributed conversions → 200 empty set (never 404)", async () => {
    execute.mockResolvedValueOnce([]); // email query → no rows
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=form_submission")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: "form_submission", emails: [] });
  });

  it("returns the deduped, lowercased matched-lead canonical emails, echoing the event", async () => {
    execute.mockResolvedValueOnce([
      { email: "jane@acme.com" },
      { email: "bob@globex.com" },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=form_submission")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event: "form_submission",
      emails: ["jane@acme.com", "bob@globex.com"],
    });
  });

  it("query is attributed-only, filters by brand + the requested event, joins the lead's canonical email", async () => {
    execute.mockResolvedValueOnce([]);
    await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=signup")
      .set("x-api-key", "test-api-key");
    const q = sqlAt(0);
    expect(q).toContain("from conversion_events");
    // Only conversions credited to a lead we emailed for the brand.
    expect(q).toContain("attribution_status = 'attributed'");
    // Canonical email = the matched lead's primary (earliest) email contact method.
    expect(q).toContain("lead_contact_methods");
    expect(q).toContain("lower(canonical.value)");
    expect(q).toContain("distinct");
    // brand + event are bound params, never interpolated.
    const params = compile(execute.mock.calls[0][0]).params;
    expect(params).toContain("brand-1");
    expect(params).toContain("signup");
  });

  it("drops null/empty emails defensively", async () => {
    execute.mockResolvedValueOnce([
      { email: "jane@acme.com" },
      { email: null },
      { email: "" },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=sale")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: "sale", emails: ["jane@acme.com"] });
  });

  it("accepts the legacy 'purchase' query, normalizes+echoes 'sale', binds 'sale' to SQL", async () => {
    execute.mockResolvedValueOnce([{ email: "jane@acme.com" }]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=purchase")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    // legacy input, canonical echo
    expect(res.body).toEqual({ event: "sale", emails: ["jane@acme.com"] });
    // SQL filters on the canonical stored spelling, never the legacy one.
    const params = compile(execute.mock.calls[0][0]).params;
    expect(params).toContain("sale");
    expect(params).not.toContain("purchase");
  });

  it("500 when the DB errors (fail loud)", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=form_submission")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(500);
  });
});

describe("POST /orgs/brands/:brandId/conversion-token/rotate", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => execute.mockReset().mockResolvedValue([]));

  it("rotate replaces the token (EXCLUDED.token) and returns the new one", async () => {
    execute.mockResolvedValueOnce([{ token: "pk_conv_new" }]);
    const res = await request(app)
      .post("/orgs/brands/brand-1/conversion-token/rotate")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    expect(res.body.token).toBe("pk_conv_new");
    expect(res.body.ingestUrl).toBe("https://api.distribute.you/public/conversions");
    expect(sqlAt(0)).toContain("excluded.token"); // rotate DOES replace
    expect(sqlAt(0)).toContain("rotated_at");
  });
});

describe("GET /internal/brands/:brandId/converted-leads", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => execute.mockReset().mockResolvedValue([]));

  it("401 without x-api-key", async () => {
    const res = await request(app).get("/internal/brands/brand-1/converted-leads?event=sale");
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 when event is missing or not a real step (ping/garbage rejected)", async () => {
    for (const q of ["", "?event=ping", "?event=garbage"]) {
      execute.mockClear();
      const res = await request(app)
        .get(`/internal/brands/brand-1/converted-leads${q}`)
        .set("x-api-key", "test-api-key");
      expect(res.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("zero attributed outcomes → 200 empty array (never 404)", async () => {
    execute.mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=sale")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: "sale", outcomes: [] });
  });

  it("legacy \"purchase\" is normalized to the canonical \"sale\" it queries and echoes", async () => {
    execute.mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=purchase")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.event).toBe("sale");
    expect(compile(execute.mock.calls[0][0]).params).toContain("sale");
  });

  it("each row carries when it happened, the campaign it is attributable to, and what it was worth", async () => {
    execute.mockResolvedValueOnce([
      {
        lead_id: "lead-1",
        campaign_id: "camp-1",
        value_cents: 490000,
        // A stated ZERO: the customer answered "this leg cost me nothing". It must survive as 0
        // and never be folded into the null that means nobody was ever asked.
        cost_cents: 0,
        // The customer states OUR outreach caused this deal.
        caused_by_outreach: true,
        stated_caused_by_outreach: true,
        source: "manual",
        // A raw `sql` row hands a timestamptz back as a STRING on some paths — the fixture
        // must be one, or a handler that calls .toISOString() on it ships green and throws in prod.
        received_at: "2026-08-19 14:30:00+00",
        email: "jane@acme.com",
      },
      {
        lead_id: "lead-2",
        campaign_id: null,
        value_cents: null,
        source: "tracker",
        // Not evaluated by the whose-win rule yet.
        cause_rule: null,
        received_at: "2026-08-18 09:00:00+00",
        email: "bob@globex.com",
      },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=sale")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.outcomes).toEqual([
      {
        leadId: "lead-1",
        email: "jane@acme.com",
        campaignId: "camp-1",
        occurredAt: "2026-08-19T14:30:00.000Z",
        valueCents: 490000,
        costCents: 0,
        causedByOutreach: true,
        causeBasis: "person",
        causeReason: null,
        source: "manual",
      },
      {
        leadId: "lead-2",
        email: "bob@globex.com",
        campaignId: null,
        occurredAt: "2026-08-18T09:00:00.000Z",
        // A tracker event observes a page load and knows nothing about the customer's spend,
        // and no more about WHY they bought: nobody was asked, which is neither answer.
        costCents: null,
        causedByOutreach: null,
        causeBasis: null,
        causeReason: null,
        valueCents: null,
        source: "tracker",
      },
    ]);
  });

  it("a lead with no email keeps its row (null email) so the read cannot disagree with the counts", async () => {
    execute.mockResolvedValueOnce([
      {
        lead_id: "lead-3",
        campaign_id: "camp-9",
        value_cents: 1000,
        source: "manual",
        received_at: null,
        email: null,
      },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=meeting_attended")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(1);
    expect(res.body.outcomes[0].email).toBeNull();
    // An outcome with no determinable date is the `undated` bucket of counts-by-day, never a
    // fabricated one.
    expect(res.body.outcomes[0].occurredAt).toBeNull();
  });

  it("queries the SAME set the counts count: attributed-only, brand + step, LEFT-joined email", async () => {
    execute.mockResolvedValueOnce([]);
    await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=signup")
      .set("x-api-key", "test-api-key");
    const q = lastSql();
    expect(q).toContain("attribution_status");
    expect(q).toContain("attributed");
    expect(q).toContain("left join lateral");
    expect(q).toContain("lead_contact_methods");
    expect(q).not.toContain("needs_review");
    expect(compile(execute.mock.calls[0][0]).params).toEqual(["brand-1", "signup"]);
  });

  it("500 when the DB errors (fail loud)", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=sale")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(500);
  });
});
