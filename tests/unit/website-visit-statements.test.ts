/**
 * A website visit stated by hand.
 *
 * Two of the four sales funnels START at a website visit, and it was the one step of those funnels
 * a person could not state: the panel showed a row it could only read above three it could act on.
 * The automatic signal for a visit is a CLICK measured by the delivery layer, and it misses — so a
 * human states what it missed. Nothing about what the delivery layer measures changes, and a lead
 * carrying BOTH is counted once: the hand-stated row is suppressed from the counts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.fn();
const checkDeliveryStatus = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CONVERSION_INGEST_URL: "https://api.distribute.you/public/conversions",
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
}));

// WHICH funnel the lead is on is campaign-service's answer. These leads sell meetings off the
// website — website_visit -> meeting_booked -> meeting_attended -> sale — one of the two funnels
// that START at the visit this file is about.


vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatus(...args),
}));

const dialect = new PgDialect();
function compile(call: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(call as SQL);
}
function allSql(): string {
  return execute.mock.calls.map((c) => compile(c[0]).sql.toLowerCase()).join("\n");
}
function paramsAt(i: number): unknown[] {
  return compile(execute.mock.calls[i][0]).params;
}

/** Faithful to postgres.js Bind: a raw `Date` param throws there, so it must throw here. */
function assertBindable(): void {
  for (const call of execute.mock.calls) {
    for (const p of compile(call[0]).params) {
      if (p instanceof Date) {
        throw new TypeError(
          'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date',
        );
      }
    }
  }
}

/** What email-gateway answers for a set of emails: those listed have a measured click. */
function measured(...emails: string[]) {
  return async (_brand: string, _campaign: unknown, items: Array<{ email: string }>) => ({
    results: items.map((item) => ({
      email: item.email,
      broadcast: { brand: { clicked: emails.includes(item.email) } },
    })),
  });
}

const LEAD_ROW_ID = "40000000-0000-0000-0000-000000000001";
const LEAD_ID = "50000000-0000-0000-0000-000000000001";
const VISIT_ROW_ID = "60000000-0000-0000-0000-000000000001";
const OTHER_VISIT_ROW_ID = "60000000-0000-0000-0000-000000000002";

function leadRow(email: string | null = "jane@acme.com") {
  return [
    {
      id: LEAD_ROW_ID,
      lead_id: LEAD_ID,
      campaign_id: "campaign-1",
      brand_ids: ["brand-1"],
      email,
    },
  ];
}

async function buildApp(module: string) {
  const { default: route } = await import(module);
  const app = express();
  app.use(express.json());
  app.use(route);
  app.use((_e: Error, _r: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("stating a website visit by hand", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp("../../src/routes/step-statements.js");
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    checkDeliveryStatus.mockReset().mockImplementation(measured());
  });

  // Stating what the step cost is mandatory, so every statement here carries one — a stated ZERO
  // unless the case says otherwise.
  function post(body: unknown) {
    const withCost =
      body && typeof body === "object" && !("costCents" in (body as object))
        ? { costCents: 0, ...(body as object) }
        : (body as object);
    return request(app)
      .post(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1")
      .set("x-user-id", "user-1")
      .send(withCost);
  }

  it("writes the visit to the ledger every consumer already counts, tagged manual", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // retract a "never", if any
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-20 10:00:00+00" }]);

    const res = await post({ step: "website_visit", kind: "outcome", note: "saw them on the demo page" });

    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({
      step: "website_visit",
      kind: "outcome",
      source: "manual",
      campaignId: "campaign-1",
      leadCampaignId: LEAD_ROW_ID,
    });
    const sql = allSql();
    expect(sql).toContain("insert into conversion_events");
    // The dedupe signature keys on the row + step, so restating corrects instead of counting twice.
    expect(paramsAt(2)).toContain(`m:${LEAD_ROW_ID}:website_visit`);
    expect(paramsAt(2)).toContain("website_visit");
    assertBindable();
    // Stating a visit never asks the delivery layer for anything — it does not touch what it measures.
    expect(checkDeliveryStatus).not.toHaveBeenCalled();
  });

  it("a value is optional on a visit, exactly as on every step that is not a sale", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-20 10:00:00+00" }]);
    const res = await post({ step: "website_visit", kind: "outcome" });
    expect(res.status).toBe(201);
  });

  it("accepts \"never\" for the visit, and it lands where NO count reads", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no outcome on the ledger for this step
      .mockResolvedValueOnce([{ id: "d-1", created_at: "x", updated_at: "2026-08-20 10:00:00+00" }]);

    const res = await post({ step: "website_visit", kind: "never", note: "site is region-locked" });

    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({ step: "website_visit", kind: "never" });
    const sql = allSql();
    expect(sql).toContain("insert into lead_step_disqualifications");
    expect(sql).not.toContain("insert into conversion_events");
  });

  it("refuses \"never\" when the delivery layer already measured the visit", async () => {
    checkDeliveryStatus.mockImplementation(measured("jane@acme.com"));
    execute.mockResolvedValueOnce(leadRow());

    const res = await post({ step: "website_visit", kind: "never" });

    expect(res.status).toBe(409);
    expect(allSql()).not.toContain("insert into lead_step_disqualifications");
  });

  it("502 rather than a guess when email-gateway cannot answer", async () => {
    checkDeliveryStatus.mockRejectedValue(new Error("gateway down"));
    execute.mockResolvedValueOnce(leadRow());

    const res = await post({ step: "website_visit", kind: "never" });

    expect(res.status).toBe(502);
    expect(allSql()).not.toContain("insert into lead_step_disqualifications");
  });

  it("leaves the five steps that already ship untouched — no gateway call, same behaviour", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no outcome for the step
      .mockResolvedValueOnce([{ id: "d-1", created_at: "x", updated_at: "2026-08-20 10:00:00+00" }]);
    const res = await post({ step: "meeting_booked", kind: "never" });
    expect(res.status).toBe(201);
    expect(checkDeliveryStatus).not.toHaveBeenCalled();
  });
});

describe("reading a lead's steps back", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp("../../src/routes/step-statements.js");
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    checkDeliveryStatus.mockReset().mockImplementation(measured());
  });

  function get() {
    return request(app)
      .get(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
  }

  it("reads back the visit a human stated", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([
        {
          event: "website_visit",
          source: "manual",
          value_cents: null,
          note: "saw them on the demo page",
          stated_by_user_id: "user-1",
          received_at: "2026-08-20 10:00:00+00",
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await get();
    const byStep = Object.fromEntries(res.body.steps.map((s: { step: string }) => [s.step, s]));
    expect(byStep.website_visit).toMatchObject({
      state: "outcome",
      source: "manual",
      note: "saw them on the demo page",
    });
  });

  it("shows a MEASURED visit as reported by the tracker, so nobody restates what is known", async () => {
    checkDeliveryStatus.mockImplementation(measured("jane@acme.com"));
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await get();
    const byStep = Object.fromEntries(res.body.steps.map((s: { step: string }) => [s.step, s]));
    expect(byStep.website_visit).toMatchObject({ state: "outcome", source: "tracker" });
    // The five steps that already ship are unaffected by the delivery-layer read.
    expect(byStep.signup.state).toBe("pending");
    expect(byStep.meeting_attended.state).toBe("pending");
  });

  it("a lead with no registered email carries no delivery evidence — pending, never a guess", async () => {
    execute
      .mockResolvedValueOnce(leadRow(null))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await get();
    const byStep = Object.fromEntries(res.body.steps.map((s: { step: string }) => [s.step, s]));
    expect(byStep.website_visit.state).toBe("pending");
    expect(checkDeliveryStatus).not.toHaveBeenCalled();
  });

  it("502 rather than a step state that could contradict the counts", async () => {
    checkDeliveryStatus.mockRejectedValue(new Error("gateway down"));
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await get();
    expect(res.status).toBe(502);
  });
});

describe("counting website visits without counting anybody twice", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp("../../src/routes/conversions.js");
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    checkDeliveryStatus.mockReset().mockImplementation(measured());
  });

  /** The measured-visit lookup: the hand-stated visit rows this brand carries. */
  function statedVisits() {
    return [
      { id: VISIT_ROW_ID, org_id: "org-1", email: "jane@acme.com" },
      { id: OTHER_VISIT_ROW_ID, org_id: "org-1", email: "sam@acme.com" },
    ];
  }

  it("suppresses the hand-stated visit of a lead the delivery layer already measured", async () => {
    checkDeliveryStatus.mockImplementation(measured("jane@acme.com"));
    execute
      .mockResolvedValueOnce(statedVisits())
      .mockResolvedValueOnce([{ event: "website_visit", source: "manual", n: 1 }]);

    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body.counts.website_visit).toBe(1);
    // Only Jane's row is excluded — Sam was never measured, so his hand-stated visit counts.
    // Only Jane's row id reaches the query.
    expect(JSON.stringify(paramsAt(1))).toContain(VISIT_ROW_ID);
    expect(JSON.stringify(paramsAt(1))).not.toContain(OTHER_VISIT_ROW_ID);
    expect(allSql()).toContain("ce.id <> all(");
  });

  it("costs no network call at all for a brand nobody hand-stated a visit for", async () => {
    execute
      .mockResolvedValueOnce([]) // no hand-stated visit rows
      .mockResolvedValueOnce([{ event: "signup", source: "tracker", n: 4 }]);

    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body.counts.signup).toBe(4);
    expect(checkDeliveryStatus).not.toHaveBeenCalled();
    // Nothing to suppress → no exclusion predicate at all, byte-identical to before.
    expect(allSql()).not.toContain("<> all(");
  });

  it("502 rather than a count that might double-count somebody", async () => {
    checkDeliveryStatus.mockRejectedValue(new Error("gateway down"));
    execute.mockResolvedValueOnce(statedVisits());

    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(502);
  });

  it("applies the same suppression to the by-day series, so the two reads reconcile", async () => {
    checkDeliveryStatus.mockImplementation(measured("jane@acme.com"));
    execute
      .mockResolvedValueOnce(statedVisits())
      .mockResolvedValueOnce([{ event: "website_visit", day: "2026-08-20", n: 1 }]);

    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts-by-day")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body.byDay.website_visit).toEqual({ "2026-08-20": 1 });
    expect(JSON.stringify(paramsAt(1))).toContain(VISIT_ROW_ID);
  });

  it("leaves a suppressed lead out of the per-outcome read too", async () => {
    checkDeliveryStatus.mockImplementation(measured("jane@acme.com"));
    execute
      .mockResolvedValueOnce(statedVisits())
      .mockResolvedValueOnce([
        {
          lead_id: LEAD_ID,
          campaign_id: "campaign-1",
          value_cents: null,
          source: "manual",
          received_at: "2026-08-20 10:00:00+00",
          email: "sam@acme.com",
        },
      ]);

    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=website_visit")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body.outcomes).toHaveLength(1);
    expect(res.body.outcomes[0]).toMatchObject({ email: "sam@acme.com", source: "manual" });
    expect(JSON.stringify(paramsAt(1))).toContain(VISIT_ROW_ID);
  });

  it("never asks the delivery layer when the caller is reading another step", async () => {
    execute.mockResolvedValueOnce([{ email: "a@x.com" }]);

    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=sale")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual(["a@x.com"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(checkDeliveryStatus).not.toHaveBeenCalled();
  });

  it("accepts website_visit as a step the outcome reads answer for", async () => {
    execute
      .mockResolvedValueOnce([]) // nothing hand-stated → nothing to suppress
      .mockResolvedValueOnce([{ email: "sam@acme.com" }]);

    const res = await request(app)
      .get("/internal/brands/brand-1/converted-lead-emails?event=website_visit")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: "website_visit", emails: ["sam@acme.com"] });
  });
});
