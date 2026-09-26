import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CONVERSION_INGEST_URL: "https://api.distribute.you/public/conversions",
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
}));


/**
 * Whether a lead went cold is derived by the standing resolver (tested in lead-cold*.test.ts);
 * here it is stubbed to "the rule does not apply" so the statement reads keep their exact queries.
 */
const readBrandColdLeads = vi.fn();
const readLeadRowCold = vi.fn();
vi.mock("../../src/lib/lead-cold-read.js", () => ({
  readBrandColdLeads: (...args: unknown[]) => readBrandColdLeads(...args),
  readLeadRowCold: (...args: unknown[]) => readLeadRowCold(...args),
}));
const NO_CRM = {
  eligible: false,
  reason: "crm_never_paired",
  evidences: { meeting_booked: false, meeting_attended: false },
};


const dialect = new PgDialect();
function compile(call: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(call as SQL);
}
function sqlAt(i: number): string {
  return compile(execute.mock.calls[i][0]).sql.toLowerCase();
}
function paramsAt(i: number): unknown[] {
  return compile(execute.mock.calls[i][0]).params;
}
function allSql(): string {
  return execute.mock.calls.map((c) => compile(c[0]).sql.toLowerCase()).join("\n");
}

/**
 * Faithfully reproduce postgres.js `Bind`: a raw `sql` template hands params straight to the
 * driver, which cannot serialize a JS `Date`. A plain vi.fn() mock never encodes params, which is
 * exactly how a 100%-broken handler shipped green once (#357/#370) — so assert on bind here.
 */
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

const LEAD_ROW_ID = "40000000-0000-0000-0000-000000000001";
const LEAD_ID = "50000000-0000-0000-0000-000000000001";

function leadRow(brandIds: string[] = ["brand-1"]) {
  return [
    {
      id: LEAD_ROW_ID,
      lead_id: LEAD_ID,
      campaign_id: "campaign-1",
      brand_ids: brandIds,
    },
  ];
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/step-statements.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  app.use((_e: Error, _r: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

// Stating what the step cost is MANDATORY, so every statement below carries one. The default is a
// stated ZERO — a real answer, not an absent one — and the cases that care about the cost pass their
// own. What happens when it is left out entirely lives in its own describe block.
function post(app: express.Express, body: unknown) {
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

describe("POST /orgs/leads/:id/step-statements", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    readBrandColdLeads.mockReset().mockResolvedValue({ eligibility: [], leads: [] });
    readLeadRowCold.mockReset().mockResolvedValue({ wentCold: null, eligibility: NO_CRM });
  });

  it("401 without the service api key", async () => {
    const res = await request(app)
      .post(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-org-id", "org-1")
      .send({ step: "sale", kind: "outcome" });
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 without an org — the caller is organisation-authenticated, not token-authenticated", async () => {
    const res = await request(app)
      .post(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .send({ step: "sale", kind: "outcome" });
    expect(res.status).toBe(400);
  });

  it("400 on an unknown step, and never touches the database", async () => {
    const res = await post(app, { step: "vibes", kind: "outcome" });
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 on a missing kind", async () => {
    const res = await post(app, { step: "sale" });
    expect(res.status).toBe(400);
  });

  it("400 when a \"never\" carries a value — refused, not silently dropped", async () => {
    const res = await post(app, { step: "sale", kind: "never", valueCents: 1000 });
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 on a \"sale\" outcome with no value — a won deal is never priced at the brand average", async () => {
    const res = await post(app, { step: "sale", kind: "outcome" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valueCents is required/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("the legacy \"purchase\" spelling is the same step, so it needs a value too", async () => {
    const res = await post(app, { step: "purchase", kind: "outcome" });
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("every OTHER step still records with no value — a large lead is worth stating before it closes", async () => {
    for (const step of ["signup", "meeting_booked", "meeting_attended", "form_submission"]) {
      execute
        .mockReset()
        .mockResolvedValueOnce(leadRow())
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
      const res = await post(app, { step, kind: "outcome" });
      expect(res.status).toBe(201);
      expect(res.body.statement.valueCents).toBeNull();
    }
  });

  it("a \"sale\" that is stated as never still needs no value", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no existing outcome
      .mockResolvedValueOnce([{ id: "d-1", created_at: "2026-08-19 14:30:00+00", updated_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "sale", kind: "never" });
    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({ step: "sale", kind: "never", valueCents: null });
  });

  it("400 on an unparseable occurredAt rather than falling back to now()", async () => {
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 1000,
      occurredAt: "last tuesday",
    });
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("404 when the row belongs to another org", async () => {
    execute.mockResolvedValueOnce([]); // lookup scoped by org_id finds nothing
    const res = await post(app, { step: "sale", kind: "outcome", valueCents: 1000 });
    expect(res.status).toBe(404);
    expect(sqlAt(0)).toContain("org_id =");
  });

  it("records a hand-stated outcome into the ledger the counts read, tagged manual", async () => {
    execute
      .mockResolvedValueOnce(leadRow()) // lead row
      .mockResolvedValueOnce([]) // retract "never" — none
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);

    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 490000,
      note: "Closed on the call.",
      occurredAt: "2026-08-19T14:30:00.000Z",
    });

    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({
      leadCampaignId: LEAD_ROW_ID,
      leadId: LEAD_ID,
      campaignId: "campaign-1",
      brandId: "brand-1",
      step: "sale",
      kind: "outcome",
      source: "manual",
      valueCents: 490000,
      statedByUserId: "user-1",
    });
    expect(res.body.retractedNever).toBe(false);

    const insert = sqlAt(2);
    expect(insert).toContain("insert into conversion_events");
    expect(insert).toContain("on conflict");
    // The identity was NAMED by the caller, so nothing is matched and nothing is guessed.
    expect(paramsAt(2)).toContain(LEAD_ID);
    expect(paramsAt(2)).toContain("2026-08-19T14:30:00.000Z");
    // Attributable to the campaign it was stated on, not only to the brand.
    expect(paramsAt(2)).toContain("campaign-1");
    assertBindable();
  });

  it("folds the legacy \"purchase\" spelling onto \"sale\"", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "purchase", kind: "outcome", valueCents: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.statement.step).toBe("sale");
  });

  it("accepts meeting_attended — the step no tracker can observe", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "meeting_attended", kind: "outcome" });
    expect(res.status).toBe(201);
    expect(res.body.statement.step).toBe("meeting_attended");
    expect(sqlAt(2)).toContain("insert into conversion_events");
  });

  it("an outcome retracts an earlier \"never\" for the same step, and says so", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ step: "sale" }]) // a "never" existed
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "sale", kind: "outcome", valueCents: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.retractedNever).toBe(true);
    expect(res.body.retractedNeverSteps).toEqual(["sale"]);
    // Marked retracted, never deleted: what somebody stated has to survive being superseded.
    expect(sqlAt(1)).toContain("update lead_step_disqualifications");
    expect(sqlAt(1)).toContain("retracted_at = now()");
  });

  it("a \"never\" NEVER lands in the conversion ledger", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no existing outcome
      .mockResolvedValueOnce([
        { id: "d-1", created_at: "2026-08-19 14:30:00+00", updated_at: "2026-08-19 14:30:00+00" },
      ]);
    const res = await post(app, { step: "meeting_booked", kind: "never", note: "left the company" });
    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({ step: "meeting_booked", kind: "never", valueCents: null });
    expect(allSql()).toContain("insert into lead_step_disqualifications");
    expect(allSql()).not.toContain("insert into conversion_events");
    assertBindable();
  });

  it("409 on \"never\" for a step that already happened", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ "?column?": 1 }]); // an attributed outcome exists
    const res = await post(app, { step: "sale", kind: "never" });
    expect(res.status).toBe(409);
    expect(allSql()).not.toContain("insert into lead_step_disqualifications");
  });

  it("404 for a brand scope the row is not part of, indistinguishable from an absent row", async () => {
    execute.mockResolvedValueOnce(leadRow(["brand-1"]));
    const res = await request(app)
      .post(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1")
      .set("x-brand-id", "brand-other")
      .send({ step: "sale", kind: "outcome", valueCents: 1000, costCents: 0 });
    expect(res.status).toBe(404);
    expect(allSql()).not.toContain("insert into conversion_events");
  });

  it("500 (not a hung socket) when the database throws", async () => {
    execute.mockRejectedValueOnce(new Error("boom"));
    const res = await post(app, { step: "sale", kind: "outcome", valueCents: 1000 });
    expect(res.status).toBe(500);
  });
});

describe("GET /orgs/leads/:id/step-statements", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    readBrandColdLeads.mockReset().mockResolvedValue({ eligibility: [], leads: [] });
    readLeadRowCold.mockReset().mockResolvedValue({ wentCold: null, eligibility: NO_CRM });
  });

  function get() {
    return request(app)
      .get(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
  }

  it("names every step, and pending is a state of its own", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // outcomes
      .mockResolvedValueOnce([]); // nevers
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.steps.map((s: { step: string }) => s.step)).toEqual([
      "signup",
      "meeting_booked",
      "form_submission",
      "sale",
      "meeting_attended",
      "website_visit",
    ]);
    expect(res.body.steps.every((s: { state: string }) => s.state === "pending")).toBe(true);
  });

  it("separates dead from pending, and hand-stated from tracker-reported", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([
        {
          event: "signup",
          source: "tracker",
          value_cents: null,
          note: null,
          stated_by_user_id: null,
          received_at: "2026-08-01 09:00:00+00",
        },
        {
          event: "meeting_attended",
          source: "manual",
          value_cents: null,
          note: "showed up",
          stated_by_user_id: "user-1",
          received_at: "2026-08-05 09:00:00+00",
        },
      ])
      .mockResolvedValueOnce([
        {
          step: "sale",
          note: "budget cut",
          stated_by_user_id: "user-1",
          updated_at: "2026-08-06 09:00:00+00",
        },
      ]);

    const res = await get();
    expect(res.status).toBe(200);
    const byStep = Object.fromEntries(
      res.body.steps.map((s: { step: string }) => [s.step, s]),
    ) as Record<string, { state: string; source: string | null; note: string | null }>;
    expect(byStep.signup).toMatchObject({ state: "outcome", source: "tracker" });
    expect(byStep.meeting_attended).toMatchObject({ state: "outcome", source: "manual" });
    expect(byStep.sale).toMatchObject({ state: "never", note: "budget cut" });
    expect(byStep.form_submission.state).toBe("pending");
  });

  it("400 when the id is not a lead row id", async () => {
    const res = await request(app)
      .get("/orgs/leads/not-a-uuid/step-statements")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("the leg graph constrains a statement's neighbours", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    readBrandColdLeads.mockReset().mockResolvedValue({ eligibility: [], leads: [] });
    readLeadRowCold.mockReset().mockResolvedValue({ wentCold: null, eligibility: NO_CRM });
  });

  it("refuses a \"never\" on a step a step only reachable through it says already happened", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ event: "meeting_attended" }]); // the lead attended
    const res = await post(app, { step: "meeting_booked", kind: "never" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("step_already_happened");
    expect(res.body.error).toMatch(/meeting_attended already happened/);
    expect(allSql()).not.toContain("insert into lead_step_disqualifications");
    // the refusal asks about the whole forward slice, not only the step itself
    expect(paramsAt(1)).toContainEqual(["meeting_booked", "meeting_attended"]);
  });

  it("an outcome retracts the nevers on steps every path to it goes through, and names them", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ step: "meeting_booked" }])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "meeting_attended", kind: "outcome" });
    expect(res.status).toBe(201);
    expect(res.body.retractedNever).toBe(true);
    expect(res.body.retractedNeverSteps).toEqual(["meeting_booked"]);
    expect(paramsAt(1)).toContainEqual(["meeting_booked", "meeting_attended"]);
    expect(sqlAt(1)).toContain("retracted_at is null");
  });

  it("a sale constrains only itself — a reply can close with no meeting", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "sale", kind: "outcome", valueCents: 1000 });
    expect(res.status).toBe(201);
    expect(paramsAt(1)).toContainEqual(["sale"]);
  });

  it("answers without asking campaign-service anything — the order is the legs'", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-19 14:30:00+00" }]);
    const res = await post(app, { step: "signup", kind: "outcome" });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("funnel" + "Key");
    expect(res.body).not.toHaveProperty("funnel" + "Steps");
  });

  it("restating a \"never\" clears an earlier retraction", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "d-1", created_at: "2026-08-19 14:30:00+00", updated_at: "2026-08-19 14:30:00+00" },
      ]);
    const res = await post(app, { step: "meeting_booked", kind: "never" });
    expect(res.status).toBe(201);
    expect(sqlAt(2)).toContain("retracted_at = null");
  });

  it("reads a stated never forward and a stated outcome backward, distinguishing the two", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no outcomes
      .mockResolvedValueOnce([
        {
          step: "meeting_booked",
          note: "left the company",
          stated_by_user_id: "user-1",
          updated_at: "2026-08-06 09:00:00+00",
        },
      ]);
    const res = await request(app)
      .get(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    const byStep = Object.fromEntries(
      res.body.steps.map((s: { step: string }) => [s.step, s]),
    ) as Record<string, { state: string; origin: string | null; impliedBy: string | null }>;
    expect(byStep.meeting_booked).toMatchObject({ state: "never", origin: "stated" });
    expect(byStep.meeting_attended).toMatchObject({
      state: "never",
      origin: "implied",
      impliedBy: "meeting_booked",
    });
    // a reply can still close with no meeting, so the sale stays pending
    expect(byStep.sale).toMatchObject({ state: "pending" });
    // the live read excludes retracted statements
    expect(sqlAt(2)).toContain("retracted_at is null");
  });

  it("the nonsense this feature removes is unreachable: booked never + attended outcome", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([
        {
          event: "meeting_attended",
          source: "manual",
          value_cents: null,
          note: "showed up",
          stated_by_user_id: "user-1",
          received_at: "2026-08-05 09:00:00+00",
        },
      ])
      .mockResolvedValueOnce([
        {
          step: "meeting_booked",
          note: "never booked",
          stated_by_user_id: "user-1",
          updated_at: "2026-08-04 09:00:00+00",
        },
      ]);
    const res = await request(app)
      .get(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    const byStep = Object.fromEntries(
      res.body.steps.map((s: { step: string }) => [s.step, s]),
    ) as Record<string, { state: string; origin: string | null; statedState: string | null }>;
    // a fact beats a prediction, and the prediction is still readable
    expect(byStep.meeting_booked).toMatchObject({
      state: "outcome",
      origin: "implied",
      statedState: "never",
    });
    expect(byStep.meeting_attended.state).toBe("outcome");
  });
});

describe("GET /internal/brands/:brandId/step-disqualifications", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    readBrandColdLeads.mockReset().mockResolvedValue({ eligibility: [], leads: [] });
    readLeadRowCold.mockReset().mockResolvedValue({ wentCold: null, eligibility: NO_CRM });
  });

  it("answers all-zero for a brand nobody disqualified anyone for", async () => {
    const res = await request(app)
      .get("/internal/brands/brand-1/step-disqualifications")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      signup: 0,
      meeting_booked: 0,
      form_submission: 0,
      sale: 0,
      meeting_attended: 0,
      website_visit: 0,
    });
    expect(res.body.byStep.sale).toEqual([]);
  });

  it("returns the canonical email join key per step", async () => {
    execute
      .mockResolvedValueOnce([{ step: "sale", n: 2 }])
      .mockResolvedValueOnce([
        { step: "sale", email: "a@x.com" },
        { step: "sale", email: "b@x.com" },
      ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/step-disqualifications")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(res.body.counts.sale).toBe(2);
    expect(res.body.byStep.sale).toEqual(["a@x.com", "b@x.com"]);
  });

  it("?implied=true applies the leg graph, and keeps stated apart from implied", async () => {
    execute
      .mockResolvedValueOnce([{ step: "meeting_booked", n: 1 }, { step: "signup", n: 1 }]) // counts
      .mockResolvedValueOnce([
        { step: "meeting_booked", email: "a@x.com" },
        { step: "signup", email: "b@x.com" },
      ]) // stated emails
      .mockResolvedValueOnce([
        {
          lead_id: "aaaaaaaa-0000-0000-0000-000000000001",
          campaign_id: "campaign-reply",
          org_id: "org-1",
          step: "meeting_booked",
          email: "a@x.com",
        },
        {
          lead_id: "bbbbbbbb-0000-0000-0000-000000000002",
          campaign_id: "campaign-web",
          org_id: "org-1",
          step: "signup",
          email: "b@x.com",
        },
      ]) // live statements
      .mockResolvedValueOnce([]); // no outcomes

    const res = await request(app)
      .get("/internal/brands/brand-1/step-disqualifications?implied=true")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    // what somebody stated — unchanged
    expect(res.body.counts.meeting_booked).toBe(1);
    expect(res.body.counts.sale).toBe(0);
    // what the leg graph concludes: never booked => never attended; nothing closes the sale
    expect(res.body.impliedByStep.meeting_attended).toEqual(["a@x.com"]);
    expect(res.body.impliedByStep.sale).toEqual([]);
    expect(res.body.impliedByStep.signup).toEqual([]);
    expect(res.body.effectiveCounts.sale).toBe(0);
    expect(res.body.effectiveCounts.signup).toBe(1);
    expect(res.body.effectiveByStep.meeting_booked).toEqual(["a@x.com"]);
  });

  it("a never contradicted by an outcome only reachable through it leaves the effective set", async () => {
    execute
      .mockResolvedValueOnce([{ step: "meeting_booked", n: 1 }])
      .mockResolvedValueOnce([{ step: "meeting_booked", email: "a@x.com" }])
      .mockResolvedValueOnce([
        {
          lead_id: "aaaaaaaa-0000-0000-0000-000000000001",
          campaign_id: "campaign-reply",
          org_id: "org-1",
          step: "meeting_booked",
          email: "a@x.com",
        },
      ])
      .mockResolvedValueOnce([
        { matched_lead_id: "aaaaaaaa-0000-0000-0000-000000000001", event: "meeting_attended" },
      ]);

    const res = await request(app)
      .get("/internal/brands/brand-1/step-disqualifications?implied=true")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    // the statement is still on the record ...
    expect(res.body.counts.meeting_booked).toBe(1);
    // ... and it is not read as dead anywhere, because the lead demonstrably attended
    expect(res.body.effectiveCounts.meeting_booked).toBe(0);
    expect(res.body.effectiveCounts.meeting_attended).toBe(0);
  });

  it("without ?implied it answers exactly as before", async () => {
    execute
      .mockResolvedValueOnce([{ step: "sale", n: 1 }])
      .mockResolvedValueOnce([{ step: "sale", email: "a@x.com" }]);
    const res = await request(app)
      .get("/internal/brands/brand-1/step-disqualifications")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      "byStep",
      "coldByStep",
      "coldCounts",
      "coldLeads",
      "coldRule",
      "counts",
    ]);
    expect(res.body.coldCounts).toEqual({ meeting_booked: 0, meeting_attended: 0 });
  });

  it("401 without the service api key", async () => {
    const res = await request(app).get("/internal/brands/brand-1/step-disqualifications");
    expect(res.status).toBe(401);
  });
});
