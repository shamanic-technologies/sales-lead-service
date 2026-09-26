/**
 * WHOSE win was it — did OUR outreach cause this deal, or something else the customer already does?
 *
 * A brand contacts people through us AND through referrals, conferences, an existing pipeline and
 * other agencies, so some of the people we email go on to buy for reasons that have nothing to do
 * with us. What is asserted here is the whole of that distinction:
 *
 *   - a caller can state a closed deal AND say who caused it, in ONE statement;
 *   - a deal they say we did NOT cause is still a real deal: recorded, counted among the brand's
 *     own, never refused and never lesser;
 *   - NOBODY-WAS-ASKED is a third state that never collapses into either answer, so a statement
 *     made before this existed can never silently acquire one;
 *   - the internal reads split the two, so a consumer can leave the deals we did not cause out of
 *     the return it computes on our outreach.
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
function paramsOf(fragment: string): unknown[] {
  const call = execute.mock.calls.find((c) => compile(c[0]).sql.toLowerCase().includes(fragment));
  if (!call) throw new Error(`no statement matching ${fragment}`);
  return compile(call[0]).params;
}

const LEAD_ROW_ID = "40000000-0000-0000-0000-000000000001";
const LEAD_ID = "50000000-0000-0000-0000-000000000001";

function leadRow() {
  return [{ id: LEAD_ROW_ID, lead_id: LEAD_ID, campaign_id: "campaign-1", brand_ids: ["brand-1"] }];
}

async function buildStatementApp() {
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

describe("stating a closed deal AND who caused it, in one statement", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildStatementApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  function ledgerWriteReady() {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([]) // the "never" rows this outcome supersedes
      .mockResolvedValueOnce([{ id: "ce-1", received_at: "2026-08-27 10:00:00+00" }]);
  }

  it("records a deal OUR outreach caused, in the same statement that closes it", async () => {
    ledgerWriteReady();
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 490_000,
      costCents: 12_000,
      causedByOutreach: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.statement.causedByOutreach).toBe(true);
    // It reaches the ledger row itself — this is the column every internal read splits on.
    const params = paramsOf("insert into conversion_events");
    expect(params).toContain(true);
  });

  it("records a deal the customer says we did NOT cause — a real deal, not a refusal", async () => {
    ledgerWriteReady();
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 250_000,
      costCents: 0,
      causedByOutreach: false,
    });
    // 201, on the same ledger, with the same value: the brand still sees its own close. Saying
    // "this one was ours, not yours" must never cost the person saying it anything.
    expect(res.status).toBe(201);
    expect(res.body.statement.causedByOutreach).toBe(false);
    expect(res.body.statement.valueCents).toBe(250_000);
    expect(paramsOf("insert into conversion_events")).toContain(false);
  });

  it("records NOBODY WAS ASKED when the caller says nothing — never \"not us\"", async () => {
    ledgerWriteReady();
    const res = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 100_000,
      costCents: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.statement.causedByOutreach).toBeNull();
    // Bound as null, so it stays distinguishable from a stated `false` forever. A default either
    // way would give every historical deal an answer nobody gave.
    const params = paramsOf("insert into conversion_events");
    expect(params).not.toContain(false);
    expect(params).not.toContain(true);
  });

  it("refuses a cause on a \"never\": nothing happened, so nothing caused it", async () => {
    const res = await post(app, {
      step: "meeting_booked",
      kind: "never",
      costCents: 0,
      causedByOutreach: false,
    });
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("changes nothing else a statement already requires", async () => {
    // The cost is still mandatory and the value is still mandatory on a closed deal — naming the
    // cause does not buy a way past either.
    const noCost = await post(app, {
      step: "sale",
      kind: "outcome",
      valueCents: 1,
      causedByOutreach: true,
    });
    expect(noCost.status).toBe(400);
    expect(noCost.body.code).toBe("cost_required");

    const noValue = await post(app, {
      step: "sale",
      kind: "outcome",
      costCents: 0,
      causedByOutreach: true,
    });
    expect(noValue.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("reading back who caused a deal, for one lead", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildStatementApp();
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

  it("tells a stated \"not us\" from a deal nobody was ever asked about", async () => {
    execute
      .mockResolvedValueOnce(leadRow())
      .mockResolvedValueOnce([
        {
          event: "sale",
          source: "manual",
          value_cents: 250_000,
          cost_cents: 0,
          // The customer said it: a referral closed this one.
          caused_by_outreach: false,
          note: "came in through a referral",
          stated_by_user_id: "user-1",
          received_at: "2026-08-19 14:30:00+00",
        },
        {
          event: "meeting_attended",
          source: "manual",
          value_cents: null,
          cost_cents: null,
          // Stated before the question existed: nobody was ever asked.
          caused_by_outreach: null,
          note: null,
          stated_by_user_id: "user-1",
          received_at: "2026-08-18 09:00:00+00",
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await get();
    expect(res.status).toBe(200);
    const byStep = Object.fromEntries(
      (res.body.steps as Array<Record<string, unknown>>).map((s) => [s.step, s]),
    );
    expect(byStep.sale.causedByOutreach).toBe(false);
    expect(byStep.meeting_attended.causedByOutreach).toBeNull();
    // An IMPLIED step is not a statement, so nobody stated its cause either.
    expect(byStep.meeting_booked.state).toBe("outcome");
    expect(byStep.meeting_booked.origin).toBe("implied");
    expect(byStep.meeting_booked.causedByOutreach).toBeNull();
  });
});

async function buildConversionsApp() {
  const { default: route } = await import("../../src/routes/conversions.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  app.use((_e: Error, _r: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

describe("the internal reads hold OUR deals apart from the brand's own", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildConversionsApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
    // The measured-visit lookup the counts read runs first: no hand-stated visit, no gateway call.
    execute.mockResolvedValueOnce([]);
  });

  it("splits the counts three ways, and the three add up to what they always totalled", async () => {
    execute.mockResolvedValueOnce([
      { event: "sale", source: "manual", caused_by_outreach: true, n: 3 },
      { event: "sale", source: "manual", caused_by_outreach: false, n: 2 },
      { event: "sale", source: "manual", caused_by_outreach: null, n: 4 },
      { event: "signup", source: "tracker", caused_by_outreach: null, n: 7 },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/conversion-counts")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);

    // UNCHANGED for a consumer that does not ask: every attributed outcome is still counted,
    // including the ones the customer says we did not cause.
    expect(res.body.counts.sale).toBe(9);
    expect(res.body.counts.signup).toBe(7);

    expect(res.body.byCause.outreach.sale).toBe(3);
    expect(res.body.byCause.other.sale).toBe(2);
    expect(res.body.byCause.unstated.sale).toBe(4);
    // A tracker-reported outcome can never be anything but unstated: a page-load tag cannot know
    // why somebody bought.
    expect(res.body.byCause.unstated.signup).toBe(7);
    expect(res.body.byCause.outreach.signup).toBe(0);

    for (const key of ["signup", "meeting_booked", "meeting_attended", "form_submission", "sale", "website_visit"]) {
      expect(
        res.body.byCause.outreach[key] +
          res.body.byCause.other[key] +
          res.body.byCause.unstated[key],
      ).toBe(res.body.counts[key]);
    }
    // The split is read off the ledger, never guessed.
    expect(compile(execute.mock.calls[1][0]).sql.toLowerCase()).toContain("caused_by_outreach");
  });

  it("carries the answer per outcome, so a consumer can PRICE only the deals we caused", async () => {
    execute.mockReset().mockResolvedValue([]);
    execute.mockResolvedValueOnce([
      {
        lead_id: "lead-1",
        campaign_id: "camp-1",
        value_cents: 490_000,
        cost_cents: 0,
        caused_by_outreach: true,
        source: "manual",
        received_at: "2026-08-19 14:30:00+00",
        email: "jane@acme.com",
      },
      {
        lead_id: "lead-2",
        campaign_id: "camp-1",
        value_cents: 250_000,
        cost_cents: 0,
        caused_by_outreach: false,
        source: "manual",
        received_at: "2026-08-18 09:00:00+00",
        email: "bob@globex.com",
      },
    ]);
    const res = await request(app)
      .get("/internal/brands/brand-1/converted-leads?event=sale")
      .set("x-api-key", "test-api-key");
    expect(res.status).toBe(200);
    // BOTH rows come back — the set is still exactly the one the counts count, so the two reads
    // cannot disagree about how many deals exist.
    expect(res.body.outcomes).toHaveLength(2);
    expect(res.body.outcomes[0].causedByOutreach).toBe(true);
    expect(res.body.outcomes[1].causedByOutreach).toBe(false);
    // What the consumer does with it: the return on OUR outreach counts one of these two.
    const ours = (res.body.outcomes as Array<{ causedByOutreach: boolean | null; valueCents: number }>)
      .filter((o) => o.causedByOutreach === true)
      .reduce((sum, o) => sum + o.valueCents, 0);
    expect(ours).toBe(490_000);
  });
});
