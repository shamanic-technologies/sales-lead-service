/**
 * A statement somebody made by hand can be TAKEN BACK.
 *
 * Wrong lead, wrong step, a reply read the wrong way round: before this, the only correction on
 * offer was stating the opposite thing — itself a false statement, and one that keeps counting. So
 * these assert the three things a consumer can observe: the statement stops being live (so the
 * counts and the customer's stated cost drop it), what the leg graph implied from it falls away with
 * it, and something nobody stated by hand is refused with a code rather than a 500.
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
function sqlAt(i: number): string {
  return compile(execute.mock.calls[i][0]).sql.toLowerCase();
}
function allSql(): string {
  return execute.mock.calls.map((c) => compile(c[0]).sql.toLowerCase()).join("\n");
}

/** postgres.js Bind cannot serialize a Date; a plain mock never notices (#357/#370). */
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
      email: null,
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

function withdraw(app: express.Express, step: string, headers: Record<string, string> = {}) {
  const req = request(app)
    .delete(`/orgs/leads/${LEAD_ROW_ID}/step-statements/${step}`)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", "org-1")
    .set("x-user-id", "user-1");
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req;
}

describe("DELETE /orgs/leads/:id/step-statements/:step", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  it("401 without the service api key", async () => {
    const res = await request(app)
      .delete(`/orgs/leads/${LEAD_ROW_ID}/step-statements/sale`)
      .set("x-org-id", "org-1");
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("400 without an org — organisation-authenticated, exactly like the write", async () => {
    const res = await request(app)
      .delete(`/orgs/leads/${LEAD_ROW_ID}/step-statements/sale`)
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(400);
  });

  it("400 on an unknown step, and never touches the database", async () => {
    const res = await withdraw(app, "vibes");
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("404 when the row belongs to another org", async () => {
    execute.mockResolvedValueOnce([]);
    const res = await withdraw(app, "sale");
    expect(res.status).toBe(404);
    expect(sqlAt(0)).toContain("org_id =");
  });

  it("404 for a brand scope the row is not part of", async () => {
    execute.mockResolvedValueOnce(leadRow(["brand-1"]));
    const res = await withdraw(app, "sale", { "x-brand-id": "brand-other" });
    expect(res.status).toBe(404);
    expect(allSql()).not.toContain("update conversion_events");
  });

  it("marks a hand-stated outcome withdrawn — never deletes it — and re-derives the steps", async () => {
    execute
      .mockResolvedValueOnce(leadRow()) // lead row
      .mockResolvedValueOnce([{ id: "ce-1" }]) // the live hand-stated outcome
      .mockResolvedValueOnce([]) // no live "never"
      .mockResolvedValueOnce([]) // UPDATE conversion_events
      .mockResolvedValueOnce([]) // no "never" to restore
      .mockResolvedValueOnce([]) // re-read: outcomes
      .mockResolvedValueOnce([]); // re-read: nevers

    const res = await withdraw(app, "sale");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      step: "sale",
      kind: "outcome",
      withdrawn: true,
      alreadyWithdrawn: false,
      withdrawnByUserId: "user-1",
    });

    const update = sqlAt(3);
    expect(update).toContain("update conversion_events");
    expect(update).toContain("withdrawn_at = now()");
    expect(allSql()).not.toContain("delete from");

    // The step reads exactly as it did before anybody spoke.
    const sale = res.body.steps.find((s: { step: string }) => s.step === "sale");
    expect(sale).toMatchObject({ state: "pending", origin: null, statedState: null });
    assertBindable();
  });

  it("only a HAND-stated outcome is reachable — the withdrawal keys on source = 'manual'", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ id: "ce-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await withdraw(app, "sale");
    expect(sqlAt(1)).toContain("source = 'manual'");
  });

  it("what the leg graph only implied falls away with the statement", async () => {
    // Before: a stated sale made meeting_booked and meeting_attended read as reached.
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ id: "ce-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // re-read outcomes: the sale is gone
      .mockResolvedValueOnce([]);
    const res = await withdraw(app, "sale");
    expect(res.status).toBe(200);
    for (const step of ["meeting_booked", "meeting_attended", "sale"]) {
      const s = res.body.steps.find((x: { step: string }) => x.step === step);
      expect(s.state).toBe("pending");
      expect(s.origin).toBeNull();
    }
  });

  it("withdrawing an outcome puts back the \"never\"s that outcome had retracted", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([{ id: "ce-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // UPDATE conversion_events
      .mockResolvedValueOnce([{ step: "meeting_booked" }]) // un-retracted
      .mockResolvedValueOnce([]) // re-read outcomes
      .mockResolvedValueOnce([
        { step: "meeting_booked", cost_cents: 0, note: null, stated_by_user_id: "user-1", updated_at: "2026-08-19 14:30:00+00" },
      ]);
    const res = await withdraw(app, "sale");
    expect(res.status).toBe(200);
    expect(res.body.restoredNeverSteps).toEqual(["meeting_booked"]);
    const restore = sqlAt(4);
    expect(restore).toContain("update lead_step_disqualifications");
    expect(restore).toContain("retracted_at = null");
    // A "never" somebody withdrew on its own account is left alone.
    expect(restore).toContain("withdrawn_at is null");
    const booked = res.body.steps.find((s: { step: string }) => s.step === "meeting_booked");
    expect(booked).toMatchObject({ state: "never", origin: "stated" });
  });

  it("withdraws a \"never\" too, and the steps it made never go back to pending", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no live outcome
      .mockResolvedValueOnce([{ id: "d-1" }]) // the live "never"
      .mockResolvedValueOnce([]) // UPDATE lead_step_disqualifications
      .mockResolvedValueOnce([]) // re-read outcomes
      .mockResolvedValueOnce([]); // re-read nevers: gone
    const res = await withdraw(app, "meeting_booked");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "never", withdrawn: true });
    expect(sqlAt(3)).toContain("update lead_step_disqualifications");
    expect(sqlAt(3)).toContain("withdrawn_at = now()");
    for (const step of ["meeting_booked", "meeting_attended", "sale"]) {
      expect(res.body.steps.find((x: { step: string }) => x.step === step).state).toBe("pending");
    }
    assertBindable();
  });

  it("withdrawing twice is a success that writes nothing", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // nothing live
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ hit: 1 }]) // it was already withdrawn
      .mockResolvedValueOnce([]) // re-read outcomes
      .mockResolvedValueOnce([]); // re-read nevers
    const res = await withdraw(app, "sale");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ withdrawn: false, alreadyWithdrawn: true });
    expect(allSql()).not.toContain("update conversion_events");
    expect(allSql()).not.toContain("update lead_step_disqualifications");
  });

  it("409 nothing_stated when nobody stated the step — distinguishable from a 500", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // nothing withdrawn either
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await withdraw(app, "sale");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("nothing_stated");
    expect(res.body.state).toBe("pending");
  });

  it("409 nothing_stated names the statement to withdraw instead, for an IMPLIED step", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // nothing hand-stated on meeting_booked
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // nothing withdrawn
      .mockResolvedValueOnce([
        { event: "meeting_attended", source: "manual", value_cents: null, cost_cents: 0, note: null, stated_by_user_id: "user-1", received_at: "2026-08-19 14:30:00+00" },
      ])
      .mockResolvedValueOnce([]);
    const res = await withdraw(app, "meeting_booked");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("nothing_stated");
    expect(res.body.origin).toBe("implied");
    expect(res.body.impliedBy).toBe("meeting_attended");
    expect(res.body.error).toMatch(/withdraw that statement instead/);
  });

  it("409 not_a_statement for something the TRACKER reported — this service does not edit it", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // no hand-stated row (source = manual finds nothing)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // nothing withdrawn
      .mockResolvedValueOnce([
        { event: "signup", source: "tracker", value_cents: null, cost_cents: null, note: null, stated_by_user_id: null, received_at: "2026-08-19 14:30:00+00" },
      ])
      .mockResolvedValueOnce([]);
    const res = await withdraw(app, "signup");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_a_statement");
    expect(allSql()).not.toContain("update conversion_events");
  });

  it("500 (not a hung socket) when the database throws", async () => {
    execute.mockRejectedValueOnce(new Error("boom"));
    const res = await withdraw(app, "sale");
    expect(res.status).toBe(500);
  });
});

describe("a withdrawn statement is excluded from every read that counts", () => {
  it("the outcome ledger reads filter withdrawn_at IS NULL", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/routes/conversions.ts", "utf8"),
    );
    // Every attributed-outcome read: counts, by-day, converted-lead-emails, converted-leads, and
    // the measured-visit suppression set.
    const attributed = src.match(/ce\.attribution_status = 'attributed'/g) ?? [];
    const withdrawn = src.match(/ce\.withdrawn_at IS NULL/g) ?? [];
    expect(withdrawn.length).toBe(attributed.length);
  });

  it("the customer's stated step costs drop it too", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/routes/step-statements.ts", "utf8"),
    );
    const stepCosts = src.slice(src.indexOf("/internal/brands/:brandId/step-costs"));
    expect(stepCosts).toContain("ce.withdrawn_at IS NULL");
    expect(stepCosts).toContain("d.withdrawn_at IS NULL");
  });
});
