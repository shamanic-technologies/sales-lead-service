/**
 * What a step cost the CUSTOMER.
 *
 * The platform automates the first leg and bills for it; the customer performs
 * the rest — they run the meeting, they close the deal — so they are the only one who can say what
 * those legs cost. Stating it is mandatory, ABSENT IS A REFUSAL (never a zero), a stated ZERO is a
 * real answer that must stay distinguishable from an absent one, and none of this money is ever
 * charged to the organisation or written to the platform's own spend ledger.
 */
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




const dialect = new PgDialect();
function compile(call: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(call as SQL);
}
function allSql(): string {
  return execute.mock.calls.map((c) => compile(c[0]).sql.toLowerCase()).join("\n");
}
function paramsOf(fragment: string): unknown[] {
  const call = execute.mock.calls.find((c) =>
    compile(c[0]).sql.toLowerCase().includes(fragment),
  );
  if (!call) throw new Error(`no statement matching ${fragment}`);
  return compile(call[0]).params;
}

const LEAD_ROW_ID = "40000000-0000-0000-0000-000000000001";
const LEAD_ID = "50000000-0000-0000-0000-000000000001";

function leadRow(brandIds: string[] = ["brand-1"]) {
  return [
    { id: LEAD_ROW_ID, lead_id: LEAD_ID, campaign_id: "campaign-1", brand_ids: brandIds },
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

function post(app: express.Express, body: unknown) {
  return request(app)
    .post(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", "org-1")
    .set("x-user-id", "user-1")
    .send(body as object);
}

describe("a statement states what the step cost the customer", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  it("refuses an outcome with no cost, and never touches the database", async () => {
    const res = await post(app, { step: "sale", kind: "outcome", valueCents: 490000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("cost_required");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a \"never\" with no cost too — a dead leg still cost what it cost", async () => {
    const res = await post(app, { step: "meeting_booked", kind: "never" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("cost_required");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a negative cost", async () => {
    const res = await post(app, { step: "sale", kind: "outcome", valueCents: 1, costCents: -1 });
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("records a stated ZERO as zero — not as an absent answer", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-27 10:00:00+00" }]);
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 490000,
      costCents: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.statement.costCents).toBe(0);
    // The zero reaches the INSERT as a bound 0, never as null: a null would be read back forever
    // after as "nobody was asked".
    const params = paramsOf("insert into conversion_events");
    expect(params).toContain(0);
  });

  it("carries a real cost onto the ledger row", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-27 10:00:00+00" }]);
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 490000,
      costCents: 12_000,
    });
    expect(res.status).toBe(201);
    expect(res.body.statement.costCents).toBe(12_000);
    expect(allSql()).toContain("cost_cents");
    expect(paramsOf("insert into conversion_events")).toContain(12_000);
  });

  it("carries the cost onto a \"never\" as well", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "d-1", cost_cents: 7_500, created_at: "x", updated_at: "2026-08-27 10:00:00+00" },
      ]);
    const res = await post(app, {
      step: "meeting_attended",
      kind: "never",
      costCents: 7_500,
    });
    expect(res.status).toBe(201);
    expect(res.body.statement.costCents).toBe(7_500);
    expect(paramsOf("insert into lead_step_disqualifications")).toContain(7_500);
  });

  it("is the CUSTOMER'S money: nothing is billed, nothing is declared to the platform's ledger", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-27 10:00:00+00" }]);
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 490000,
      costCents: 12_000,
    });
    expect(res.status).toBe(201);
    // The whole write is two of this service's own tables. No run, no cost row, no affordability
    // check — the platform's spend ledger lives in runs-service and this money never goes near it.
    const sql = allSql();
    expect(sql).not.toContain("runs");
    expect(sql).not.toContain("costs");
    expect(sql).not.toContain("billing");
  });
});

describe("reading a stated cost back", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  function get() {
    return request(app)
      .get(`/orgs/leads/${LEAD_ROW_ID}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "org-1");
  }

  it("tells a stated zero from a statement nobody was ever asked about", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      // outcomes: a zero somebody stated, and a legacy row written before the cost existed
      .mockResolvedValueOnce([
        {
          event: "sale",
          source: "manual",
          value_cents: 490000,
          cost_cents: 0,
          note: null,
          stated_by_user_id: "user-1",
          received_at: "2026-08-19 14:30:00+00",
        },
        {
          event: "meeting_booked",
          source: "manual",
          value_cents: null,
          cost_cents: null,
          note: null,
          stated_by_user_id: "user-1",
          received_at: "2026-08-01 09:00:00+00",
        },
      ])
      .mockResolvedValueOnce([]);
    const res = await get();
    expect(res.status).toBe(200);
    const byStep = Object.fromEntries(
      res.body.steps.map((s: { step: string }) => [s.step, s]),
    );
    expect(byStep.sale.costCents).toBe(0);
    expect(byStep.meeting_booked.costCents).toBeNull();
    // Nobody stated the attended step, so it carries no cost — pending is not a zero either.
    expect(byStep.meeting_attended.costCents).toBeNull();
  });

  it("reads a \"never\"'s cost back, and leaves an IMPLIED step costless", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          step: "meeting_booked",
          cost_cents: 7_500,
          note: "took the call, went nowhere",
          stated_by_user_id: "user-1",
          updated_at: "2026-08-19 14:30:00+00",
        },
      ]);
    const res = await get();
    expect(res.status).toBe(200);
    const byStep = Object.fromEntries(
      res.body.steps.map((s: { step: string }) => [s.step, s]),
    );
    expect(byStep.meeting_booked.costCents).toBe(7_500);
    expect(byStep.meeting_booked.origin).toBe("stated");
    // The leg graph makes the attendance never — but nobody stated THAT, so nobody stated a cost
    // for it either. An implied step is not a statement.
    expect(byStep.meeting_attended.state).toBe("never");
    expect(byStep.meeting_attended.origin).toBe("implied");
    expect(byStep.meeting_attended.costCents).toBeNull();
  });
});

describe("GET /internal/brands/:brandId/step-costs", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  function get(query = "") {
    return request(app)
      .get(`/internal/brands/brand-1/step-costs${query}`)
      .set("x-api-key", "test-api-key");
  }

  it("401 without the service api key", async () => {
    const res = await request(app).get("/internal/brands/brand-1/step-costs");
    expect(res.status).toBe(401);
  });

  it("400 on an unrecognised step, never a silent \"all steps\"", async () => {
    const res = await get("?step=vibes");
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns zeros and an empty array for a brand nobody stated a cost for", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.totalCostCents).toBe(0);
    expect(res.body.statedCount).toBe(0);
    expect(res.body.unstatedCount).toBe(0);
    expect(res.body.costs).toEqual([]);
  });

  it("sums stated costs across BOTH ledgers and never invents one for an unstated row", async () => {
    execute
      // hand-stated outcomes
      .mockResolvedValueOnce([
        {
          lead_id: LEAD_ID,
          lead_campaign_id: LEAD_ROW_ID,
          campaign_id: "campaign-1",
          step: "sale",
          cost_cents: 12_000,
          stated_by_user_id: "user-1",
          occurred_at: "2026-08-19 14:30:00+00",
          email: "jane@acme.com",
        },
        {
          lead_id: "lead-2",
          lead_campaign_id: "row-2",
          campaign_id: "campaign-1",
          step: "meeting_attended",
          // stated before the cost became mandatory: nobody was ever asked
          cost_cents: null,
          stated_by_user_id: "user-1",
          occurred_at: "2026-08-01 09:00:00+00",
          email: null,
        },
      ])
      // stated "never"s — a dead leg still cost
      .mockResolvedValueOnce([
        {
          lead_id: "lead-3",
          lead_campaign_id: "row-3",
          campaign_id: "campaign-2",
          step: "meeting_booked",
          cost_cents: 0,
          stated_by_user_id: "user-2",
          occurred_at: "2026-08-20 08:00:00+00",
          email: "bob@globex.com",
        },
      ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.totalCostCents).toBe(12_000);
    // A stated ZERO counts as an answer; the unstated row counts as no answer, and neither is
    // folded into the other.
    expect(res.body.statedCount).toBe(2);
    expect(res.body.unstatedCount).toBe(1);
    expect(res.body.byStep.sale).toEqual({ costCents: 12_000, statedCount: 1, unstatedCount: 0 });
    expect(res.body.byStep.meeting_booked).toEqual({
      costCents: 0,
      statedCount: 1,
      unstatedCount: 0,
    });
    expect(res.body.byStep.meeting_attended).toEqual({
      costCents: 0,
      statedCount: 0,
      unstatedCount: 1,
    });
    expect(res.body.costs).toHaveLength(3);
    expect(res.body.costs[0]).toEqual({
      leadId: LEAD_ID,
      leadCampaignId: LEAD_ROW_ID,
      campaignId: "campaign-1",
      email: "jane@acme.com",
      step: "sale",
      kind: "outcome",
      costCents: 12_000,
      statedByUserId: "user-1",
      occurredAt: "2026-08-19T14:30:00.000Z",
    });
    expect(res.body.costs[2].kind).toBe("never");
  });

  it("reads only LIVE statements the customer made — no tracker rows, no retracted nevers", async () => {
    await get();
    const sql = allSql();
    expect(sql).toContain("ce.source = 'manual'");
    expect(sql).toContain("d.retracted_at is null");
  });

  it("narrows to one step, folding the legacy \"purchase\" spelling", async () => {
    await get("?step=purchase");
    for (const call of execute.mock.calls) {
      expect(compile(call[0]).params).toContain("sale");
    }
  });
});
