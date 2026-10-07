import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const pickFollowupCandidate = vi.fn();
const readFollowupState = vi.fn();
const writeFollowupStatement = vi.fn();
const lookupFollowupRowByEmail = vi.fn();
const recordActedByEmail = vi.fn();

vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

vi.mock("../../src/lib/followup-actions.js", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  recordActedByEmail: (...a: unknown[]) => recordActedByEmail(...a),
}));

vi.mock("../../src/lib/followup-queue.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    pickFollowupCandidate: (...a: unknown[]) => pickFollowupCandidate(...a),
    readFollowupState: (...a: unknown[]) => readFollowupState(...a),
    writeFollowupStatement: (...a: unknown[]) => writeFollowupStatement(...a),
    lookupFollowupRowByEmail: (...a: unknown[]) => lookupFollowupRowByEmail(...a),
  };
});

const ROW = "40000000-0000-0000-0000-000000000001";
const auth = { "x-api-key": "test-api-key", "x-org-id": "org-1" };

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/followups.js");
  app = express();
  app.use(express.json());
  app.use(route);
  app.use((_e: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
}, 30_000);

beforeEach(() => {
  pickFollowupCandidate.mockReset();
  readFollowupState.mockReset();
  writeFollowupStatement.mockReset();
  lookupFollowupRowByEmail.mockReset();
});

describe("POST /orgs/campaigns/:campaignId/followups/claim-next", () => {
  const url = "/orgs/campaigns/camp-1/followups/claim-next";

  it("401 without the api key", async () => {
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(401);
  });

  it("400 without an org", async () => {
    const res = await request(app).post(url).set("x-api-key", "test-api-key").send({});
    expect(res.status).toBe(400);
  });

  it("returns the claimed person", async () => {
    pickFollowupCandidate.mockResolvedValue({
      claimed: {
        id: ROW,
        leadId: "lead-1",
        campaignId: "camp-1",
        brandId: "brand-1",
        email: "a@b.com",
        audienceId: null,
        dueAt: "2026-09-01 09:00:00+00",
        followupCount: 2,
        lastActionAt: null,
      },
    });

    const res = await request(app).post(url).set(auth).send({});

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.followup).toMatchObject({ id: ROW, email: "a@b.com", followupCount: 2 });
  });

  it("normalizes a dueAt the driver handed back as a Date", async () => {
    pickFollowupCandidate.mockResolvedValue({
      claimed: {
        id: ROW,
        leadId: "lead-1",
        campaignId: "camp-1",
        brandId: "brand-1",
        email: "a@b.com",
        audienceId: null,
        dueAt: new Date("2026-09-01T09:00:00.000Z"),
        followupCount: 0,
        lastActionAt: new Date("2026-08-30T09:00:00.000Z"),
      },
    });

    const res = await request(app).post(url).set(auth).send({});

    expect(res.body.followup.dueAt).toBe("2026-09-01T09:00:00.000Z");
    expect(res.body.followup.lastActionAt).toBe("2026-08-30T09:00:00.000Z");
  });

  it("names why nobody came back", async () => {
    pickFollowupCandidate.mockResolvedValue({ claimed: null, reason: "nothing_due" });
    const res = await request(app).post(url).set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false, reason: "nothing_due" });
  });

  it("502 — never a silent fallback — when opt-outs cannot be read", async () => {
    const { FollowupOptOutLookupError } = await import("../../src/lib/followup-queue.js");
    pickFollowupCandidate.mockRejectedValue(new FollowupOptOutLookupError(new Error("down")));

    const res = await request(app).post(url).set(auth).send({});

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("opt_out_lookup_unavailable");
  });

  it("500 on an unexpected failure — the socket is answered, never hung", async () => {
    pickFollowupCandidate.mockRejectedValue(new Error("boom"));
    const res = await request(app).post(url).set(auth).send({});
    expect(res.status).toBe(500);
  });

  it("claims for the campaign named, not its identity family", async () => {
    pickFollowupCandidate.mockResolvedValue({ claimed: null, reason: "nothing_due" });
    await request(app).post(url).set({ ...auth, "x-run-id": "run-9" }).send({});
    expect(pickFollowupCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", campaignId: "camp-1", runId: "run-9" }),
    );
  });
});

describe("POST /orgs/leads/:id/followups", () => {
  const url = `/orgs/leads/${ROW}/followups`;
  const state = {
    id: ROW,
    leadId: "lead-1",
    campaignId: "camp-1",
    dueAt: "2026-09-09T09:00:00.000Z",
    claimedAt: null,
    followupCount: 3,
    lastActionAt: "2026-09-02T10:00:00.000Z",
    stoppedReason: null,
  };

  it("400 on a non-uuid id", async () => {
    const res = await request(app).post("/orgs/leads/not-a-uuid/followups").set(auth).send({
      kind: "stopped",
      reason: "x",
    });
    expect(res.status).toBe(400);
    expect(writeFollowupStatement).not.toHaveBeenCalled();
  });

  it("400 on an unknown kind", async () => {
    const res = await request(app).post(url).set(auth).send({ kind: "maybe" });
    expect(res.status).toBe(400);
  });

  it("records an action with the next due date the worker chose", async () => {
    writeFollowupStatement.mockResolvedValue(state);
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ kind: "acted", nextDueAt: "2027-01-15T09:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.followup).toEqual(state);
    expect(writeFollowupStatement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "acted", dueAtIso: "2027-01-15T09:00:00.000Z", reason: null }),
    );
  });

  it("400 with the bounds when the worker proposes a past date — not clamped", async () => {
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ kind: "acted", nextDueAt: "2020-01-01T00:00:00.000Z" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("due_date_out_of_bounds");
    expect(res.body.bounds.earliest).toBeTruthy();
    expect(res.body.bounds.latest).toBeTruthy();
    expect(writeFollowupStatement).not.toHaveBeenCalled();
  });

  it("400 with the bounds when the worker proposes an absurd horizon", async () => {
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ kind: "acted", nextDueAt: "2525-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("due_date_out_of_bounds");
  });

  it("400 when the date is unparseable", async () => {
    const res = await request(app).post(url).set(auth).send({ kind: "acted", nextDueAt: "soonish" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("due_date_unparseable");
  });

  it("400 when kind=acted carries no next due date", async () => {
    const res = await request(app).post(url).set(auth).send({ kind: "acted" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("due_date_unparseable");
  });

  it("schedules the first action after qualification", async () => {
    writeFollowupStatement.mockResolvedValue({ ...state, followupCount: 0 });
    const soon = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app).post(url).set(auth).send({ kind: "scheduled", dueAt: soon });

    expect(res.status).toBe(200);
    expect(writeFollowupStatement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "scheduled", dueAtIso: soon }),
    );
  });

  it("400 when a stop states no reason — absent is a refusal, never an empty string", async () => {
    const res = await request(app).post(url).set(auth).send({ kind: "stopped" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("reason_required");

    const blank = await request(app).post(url).set(auth).send({ kind: "stopped", reason: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe("reason_required");
  });

  it("stops the schedule when the prospect answered again", async () => {
    writeFollowupStatement.mockResolvedValue({
      ...state,
      dueAt: null,
      stoppedReason: "answered_again",
    });
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ kind: "stopped", reason: "answered_again" });

    expect(res.status).toBe(200);
    expect(res.body.followup.dueAt).toBeNull();
    expect(writeFollowupStatement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stopped", dueAtIso: null, reason: "answered_again" }),
    );
  });

  it("404 when the row is not this org's", async () => {
    writeFollowupStatement.mockResolvedValue(null);
    const res = await request(app).post(url).set(auth).send({ kind: "stopped", reason: "x" });
    expect(res.status).toBe(404);
  });
});

describe("GET /orgs/leads/:id/followups", () => {
  it("reads the state back", async () => {
    readFollowupState.mockResolvedValue({
      id: ROW,
      leadId: "lead-1",
      campaignId: "camp-1",
      dueAt: null,
      claimedAt: null,
      followupCount: 7,
      lastActionAt: null,
      stoppedReason: "opted_out",
    });

    const res = await request(app).get(`/orgs/leads/${ROW}/followups`).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.followup).toMatchObject({ followupCount: 7, stoppedReason: "opted_out" });
  });

  it("404 for a row this org does not have", async () => {
    readFollowupState.mockResolvedValue(null);
    const res = await request(app).get(`/orgs/leads/${ROW}/followups`).set(auth);
    expect(res.status).toBe(404);
  });

  it("400 on a non-uuid id", async () => {
    const res = await request(app).get("/orgs/leads/nope/followups").set(auth);
    expect(res.status).toBe(400);
  });
});

/**
 * The enqueue door. The queue worked and nothing ever seeded it, because the service that
 * qualifies a reply holds an email address rather than a row id.
 */
describe("POST /orgs/campaigns/:campaignId/followups/schedule-by-email", () => {
  const url = "/orgs/campaigns/camp-1/followups/schedule-by-email";
  const state = {
    id: ROW,
    leadId: "lead-1",
    campaignId: "camp-1",
    dueAt: "2026-09-05T09:00:00.000Z",
    claimedAt: null,
    followupCount: 0,
    lastActionAt: null,
    stoppedReason: null,
  };

  function dueNow() {
    return new Date().toISOString();
  }

  it("401 without the api key", async () => {
    const res = await request(app).post(url).send({ email: "a@b.com", dueAt: dueNow() });
    expect(res.status).toBe(401);
  });

  it("400 without an org", async () => {
    const res = await request(app)
      .post(url)
      .set("x-api-key", "test-api-key")
      .send({ email: "a@b.com", dueAt: dueNow() });
    expect(res.status).toBe(400);
  });

  it("enqueues the resolved row as a `scheduled` statement", async () => {
    lookupFollowupRowByEmail.mockResolvedValue({
      ok: true,
      id: ROW,
      leadId: "lead-1",
      email: "A@B.com",
    });
    writeFollowupStatement.mockResolvedValue(state);
    const dueAt = dueNow();

    const res = await request(app).post(url).set(auth).send({ email: " A@B.com ", dueAt });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ followup: state, leadId: "lead-1", email: "A@B.com" });
    expect(lookupFollowupRowByEmail).toHaveBeenCalledWith({
      orgId: "org-1",
      campaignId: "camp-1",
      email: "A@B.com",
    });
    expect(writeFollowupStatement).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", id: ROW, kind: "scheduled", reason: null }),
    );
  });

  it("404 with a NAMED code when no lead on this campaign holds that address", async () => {
    lookupFollowupRowByEmail.mockResolvedValue({ ok: false, code: "lead_not_found" });

    const res = await request(app).post(url).set(auth).send({ email: "ghost@b.com", dueAt: dueNow() });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("lead_not_found");
    expect(writeFollowupStatement).not.toHaveBeenCalled();
  });

  it("409 with the matches when the address is ambiguous — never a best guess", async () => {
    lookupFollowupRowByEmail.mockResolvedValue({
      ok: false,
      code: "ambiguous_lead",
      matches: [
        { id: ROW, leadId: "lead-1", email: "a@b.com" },
        { id: "40000000-0000-0000-0000-000000000002", leadId: "lead-2", email: "A@b.com" },
      ],
    });

    const res = await request(app).post(url).set(auth).send({ email: "a@b.com", dueAt: dueNow() });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ambiguous_lead");
    expect(res.body.matches).toHaveLength(2);
    expect(writeFollowupStatement).not.toHaveBeenCalled();
  });

  it("400 on a due date outside the accepted range, carrying the bounds — never clamped", async () => {
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ email: "a@b.com", dueAt: new Date(Date.now() + 5 * 365 * 24 * 3600_000).toISOString() });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("due_date_out_of_bounds");
    expect(res.body.bounds.latest).toBeTruthy();
    expect(lookupFollowupRowByEmail).not.toHaveBeenCalled();
  });

  it("400 on an unparseable due date", async () => {
    const res = await request(app).post(url).set(auth).send({ email: "a@b.com", dueAt: "soon" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("due_date_unparseable");
  });

  it("400 when the email is missing — no default, no silent no-op", async () => {
    const res = await request(app).post(url).set(auth).send({ dueAt: dueNow() });
    expect(res.status).toBe(400);
    expect(lookupFollowupRowByEmail).not.toHaveBeenCalled();
  });

  it("500 on an unexpected failure — the socket is answered, never hung", async () => {
    lookupFollowupRowByEmail.mockRejectedValue(new Error("boom"));
    const res = await request(app).post(url).set(auth).send({ email: "a@b.com", dueAt: dueNow() });
    expect(res.status).toBe(500);
  });
});

describe("POST /orgs/campaigns/:campaignId/followup-actions/by-email", () => {
  const url = "/orgs/campaigns/camp-held/followup-actions/by-email";
  const headers = { ...auth, "x-campaign-id": "camp-aic", "x-run-id": "ring-run-1" };

  beforeEach(() => {
    recordActedByEmail.mockReset();
    lookupFollowupRowByEmail.mockReset();
  });

  it("records the act for the acting campaign on the holding campaign's row (201)", async () => {
    lookupFollowupRowByEmail.mockResolvedValue({ ok: true, id: ROW, leadId: "lead-1", email: "P@x.com" });
    recordActedByEmail.mockResolvedValue("recorded");
    const res = await request(app).post(url).set(headers).send({ email: "p@x.com" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ outcome: "recorded", leadCampaignId: ROW, leadId: "lead-1", email: "P@x.com" });
    expect(lookupFollowupRowByEmail).toHaveBeenCalledWith({ orgId: "org-1", campaignId: "camp-held", email: "p@x.com" });
    expect(recordActedByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", leadCampaignId: ROW, actingCampaignId: "camp-aic", runId: "ring-run-1" }),
    );
  });

  it("a retry of the same run answers 200 already_recorded", async () => {
    lookupFollowupRowByEmail.mockResolvedValue({ ok: true, id: ROW, leadId: "lead-1", email: "p@x.com" });
    recordActedByEmail.mockResolvedValue("already_recorded");
    const res = await request(app).post(url).set(headers).send({ email: "p@x.com" });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("already_recorded");
  });

  it("400 without x-campaign-id or x-run-id, nothing written", async () => {
    const noActing = await request(app).post(url).set({ ...auth, "x-run-id": "r" }).send({ email: "p@x.com" });
    expect(noActing.status).toBe(400);
    expect(noActing.body.code).toBe("acting_campaign_required");
    const noRun = await request(app).post(url).set({ ...auth, "x-campaign-id": "c" }).send({ email: "p@x.com" });
    expect(noRun.status).toBe(400);
    expect(noRun.body.code).toBe("run_required");
    expect(recordActedByEmail).not.toHaveBeenCalled();
  });

  it("404 lead_not_found and 409 ambiguous_lead are named refusals", async () => {
    lookupFollowupRowByEmail.mockResolvedValueOnce({ ok: false, code: "lead_not_found" });
    const nf = await request(app).post(url).set(headers).send({ email: "p@x.com" });
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe("lead_not_found");
    lookupFollowupRowByEmail.mockResolvedValueOnce({ ok: false, code: "ambiguous_lead", matches: [] });
    const amb = await request(app).post(url).set(headers).send({ email: "p@x.com" });
    expect(amb.status).toBe(409);
    expect(recordActedByEmail).not.toHaveBeenCalled();
  });

  it("500 when the write throws (never a hung socket)", async () => {
    lookupFollowupRowByEmail.mockResolvedValue({ ok: true, id: ROW, leadId: "lead-1", email: "p@x.com" });
    recordActedByEmail.mockRejectedValue(new Error("db down"));
    const res = await request(app).post(url).set(headers).send({ email: "p@x.com" });
    expect(res.status).toBe(500);
  });
});
