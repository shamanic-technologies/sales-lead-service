import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// The idempotency lookup, in-flight guard, and child-run creation run BEFORE the
// main pullNext try/catch. A throw there (e.g. runs-service unreachable through
// its Neon cold-start window) must return a clean 500 from the handler itself —
// NOT escape the async handler as an unhandled rejection that hangs the socket.
// Express 4 does NOT forward an async rejection to error middleware, so this app
// mounts NO error handler: a passing 500 proves the handler sends the response.

const findFirst = vi.fn();
const insertValues = vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) }));
vi.mock("../../src/db/index.js", () => ({
  db: {
    query: { idempotencyCache: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
    delete: () => ({ where: () => ({ then: (r: (x: unknown[]) => void) => Promise.resolve([]).then(r), catch: () => {} }) }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  idempotencyCache: { idempotencyKey: "idempotency_key", createdAt: "created_at" },
}));

const checkConcurrentBufferNext = vi.fn();
vi.mock("../../src/lib/inflight-guard.js", () => ({
  checkConcurrentBufferNext: (...a: unknown[]) => checkConcurrentBufferNext(...a),
}));

const createRun = vi.fn();
const updateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => createRun(...a),
  updateRun: (...a: unknown[]) => updateRun(...a),
}));

const pullNext = vi.fn();
vi.mock("../../src/lib/buffer.js", () => ({
  pullNext: (...a: unknown[]) => pullNext(...a),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/people-client.js", () => ({
  AUDIENCE_NOT_SERVEABLE_REASON: "audience_not_serveable",
  isAudienceNotServeableError: () => false,
}));

const resolveSourcingOriginSlug = vi.fn();
vi.mock("../../src/lib/sourcing-origin.js", () => ({
  resolveSourcingOriginSlug: (...a: unknown[]) => resolveSourcingOriginSlug(...a),
}));

const resolveServeSource = vi.fn();
vi.mock("../../src/lib/source-campaign.js", () => ({
  resolveServeSource: (...a: unknown[]) => resolveServeSource(...a),
}));

const recordLeadRequested = vi.fn();
vi.mock("../../src/lib/lead-requested-events.js", () => ({
  recordLeadRequested: (...a: unknown[]) => recordLeadRequested(...a),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  PULL_NEXT_TIMEOUT_MS: 60_000,
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";
const RUN = "10000000-0000-0000-0000-000000000001";
const CAMPAIGN = "40000000-0000-0000-0000-000000000001";

const AUDIENCE = "50000000-0000-0000-0000-000000000001";

function post(app: express.Express, audienceId?: string) {
  const r = request(app)
    .post("/orgs/buffer/next")
    .set("x-api-key", "test-api-key")
    .set("x-org-id", ORG)
    .set("x-run-id", RUN)
    .set("x-campaign-id", CAMPAIGN)
    .set("x-brand-id", BRAND)
    .set("x-feature-slug", "lead-finder-v1");
  if (audienceId) r.set("x-audience-id", audienceId);
  return r.send({});
}

describe("POST /orgs/buffer/next — pre-serve failure handling", () => {
  let app: express.Express;
  beforeAll(async () => {
    const { default: route } = await import("../../src/routes/buffer.js");
    app = express();
    app.use(express.json());
    app.use(route);
    // Intentionally NO error middleware: proves the handler itself responds.
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue(undefined);
    checkConcurrentBufferNext.mockResolvedValue({ blocked: false });
    resolveServeSource.mockResolvedValue({ kind: "legacy", why: "offer_not_on_source_campaigns" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns 500 (not an unhandled rejection) when the in-flight guard throws (runs-service unreachable)", async () => {
    checkConcurrentBufferNext.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    );

    const res = await post(app);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Lead serve setup failed");
    // Never proceeded to create a run or serve a lead.
    expect(createRun).not.toHaveBeenCalled();
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("returns 500 when createRun throws (runs-service outage after retries)", async () => {
    createRun.mockRejectedValueOnce(new Error("Runs service call failed: 503"));

    const res = await post(app);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Lead serve setup failed");
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("still returns 409 when the in-flight guard blocks (early return preserved)", async () => {
    checkConcurrentBufferNext.mockResolvedValueOnce({
      blocked: true,
      detail: "Concurrent buffer/next call",
      existing: { id: "run-x" },
    });

    const res = await post(app);

    expect(res.status).toBe(409);
    expect(createRun).not.toHaveBeenCalled();
  });

  it("puts the empty answer's reason on the wire, so a caller can tell why it is empty", async () => {
    // The handler passes pullNext's result through verbatim; without the reason reaching
    // the body, a first ask that looked at nobody is byte-identical to a walked, dry
    // audience — and the caller stops the campaign for good on that reading.
    pullNext.mockResolvedValueOnce({ found: false, reason: "no_audience" });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false, reason: "no_audience" });
    expect(res.body.reason).not.toBe("audience_exhausted");
    // and the cached idempotent replay carries it too
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ response: { found: false, reason: "no_audience" } }),
    );
  });

  it("still returns the cached response on an idempotency hit (early return preserved)", async () => {
    findFirst.mockResolvedValueOnce({ response: { found: true, lead: { leadId: "cached-1" } } });

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(res.body.lead.leadId).toBe("cached-1");
    expect(checkConcurrentBufferNext).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("labels the serve run with the audience's SOURCING origin, keeps the outreach slug for the lead row", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-buying-signals");
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(resolveSourcingOriginSlug).toHaveBeenCalledWith({
      audienceId: AUDIENCE,
      orgId: ORG,
      outreachFeatureSlug: "lead-finder-v1",
    });
    // Parent link, campaign, audience unchanged; only the slug moves.
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: "lead-serve",
        parentRunId: RUN,
        campaignId: CAMPAIGN,
        audienceId: AUDIENCE,
        featureSlug: "sourcing-apollo-buying-signals",
      }),
    );
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({ featureSlug: "lead-finder-v1", runFeatureSlug: "sourcing-apollo-buying-signals" }),
      expect.anything(),
    );
    expect(updateRun).toHaveBeenCalledWith(
      "serve-run-1",
      "completed",
      expect.objectContaining({ featureSlug: "sourcing-apollo-buying-signals" }),
    );
  });

  it("fails loud (500, no run, no serve) when the sourcing origin cannot be resolved", async () => {
    resolveSourcingOriginSlug.mockRejectedValueOnce(new Error("audience=x states no list kind"));

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Lead serve setup failed");
    expect(res.body.detail).toContain("no list kind");
    expect(createRun).not.toHaveBeenCalled();
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("asks for no origin when no audience is named (nothing is bought)", async () => {
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "no_audience" });

    await post(app);

    expect(resolveSourcingOriginSlug).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ featureSlug: "lead-finder-v1" }));
  });

  it("keeps the outreach slug when the audience serves from no list (nothing is bought)", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce(null);
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_not_serveable" });

    await post(app, AUDIENCE);

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ featureSlug: "lead-finder-v1" }));
  });

  // ── SOURCE CAMPAIGNS (src/lib/source-campaign.ts) ──────────────────────────────
  const SOURCE_CAMPAIGN = "60000000-0000-0000-0000-000000000001";

  it("files the serve under the ON source campaign of the audience's origin; the lead stays the outreach campaign's", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({
      kind: "source",
      campaignId: SOURCE_CAMPAIGN,
      originSlug: "sourcing-apollo-cold-filters",
      offerId: "70000000-0000-0000-0000-000000000001",
    });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(resolveServeSource).toHaveBeenCalledWith({
      orgId: ORG,
      brandId: BRAND,
      outreachCampaignId: CAMPAIGN,
      originSlug: "sourcing-apollo-cold-filters",
    });
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: "lead-serve",
        parentRunId: RUN,
        campaignId: SOURCE_CAMPAIGN,
        featureSlug: "sourcing-apollo-cold-filters",
      }),
    );
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, runCampaignId: SOURCE_CAMPAIGN }),
      expect.anything(),
    );
    expect(updateRun).toHaveBeenCalledWith("serve-run-1", "completed", expect.objectContaining({ campaignId: SOURCE_CAMPAIGN }));
  });

  it("a source campaign that is OFF buys nothing: found:false source_campaign_off, run closed, no serve", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-linkedin-engagement-signals");
    resolveServeSource.mockResolvedValueOnce({
      kind: "refused",
      reason: "source_campaign_off",
      campaignId: SOURCE_CAMPAIGN,
      detail: "off",
    });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: false, reason: "source_campaign_off" });
    expect(pullNext).not.toHaveBeenCalled();
    // Nothing filed under the off source: the run stays the outreach campaign's.
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ campaignId: CAMPAIGN }));
    expect(updateRun).toHaveBeenCalledWith("serve-run-1", "completed", expect.anything());
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: RUN, response: { found: false, reason: "source_campaign_off" } }));
  });

  it("a source over its daily budget answers source_budget_reached", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "refused", reason: "source_budget_reached", campaignId: SOURCE_CAMPAIGN, detail: "spent" });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);

    const res = await post(app, AUDIENCE);

    expect(res.body).toEqual({ found: false, reason: "source_budget_reached" });
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("fails loud (500, no run, no serve) when the source campaign cannot be read", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockRejectedValueOnce(new Error("campaign-service source-campaigns read failed: 502"));

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(500);
    expect(res.body.detail).toContain("source-campaigns read failed");
    expect(createRun).not.toHaveBeenCalled();
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("asks no source campaign when the serve has no origin (no audience): today's serve", async () => {
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "no_audience" });

    await post(app);

    expect(resolveServeSource).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ campaignId: CAMPAIGN }));
  });

  it("holds the per-outreach-campaign serial invariant in-process (a serve filed under a source is invisible to the runs guard)", async () => {
    resolveSourcingOriginSlug.mockResolvedValue("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValue({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-cold-filters", offerId: "o" });
    createRun.mockResolvedValue({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    let release: (v: unknown) => void = () => {};
    pullNext.mockImplementationOnce(() => new Promise((r) => (release = r)));

    // supertest sends on .then(): start the first serve, leave it in flight.
    const first = post(app, AUDIENCE).then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(app, AUDIENCE);
    expect(second.status).toBe(409);

    release({ found: false, reason: "audience_exhausted" });
    expect((await first).status).toBe(200);
    resolveSourcingOriginSlug.mockReset();
  });
  // ── lead_requested trigger events (src/lib/lead-requested-events.ts) ───────────────────────
  it("records ONE lead_requested event `ran` under the SOURCE campaign, naming the lead and the outreach campaign that asked", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-cold-filters", offerId: "offer-1" });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(recordLeadRequested).toHaveBeenCalledTimes(1);
    expect(recordLeadRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        brandId: BRAND,
        offerId: "offer-1",
        requestedByCampaignId: CAMPAIGN,
        callerRunId: RUN,
        leadId: "lead-1",
        performed: { outcome: "ran", campaignId: SOURCE_CAMPAIGN },
      }),
    );
  });

  it("records an empty serve as `skipped` with the serve's own reason (offer read at delivery)", async () => {
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    await post(app);

    expect(recordLeadRequested).toHaveBeenCalledTimes(1);
    expect(recordLeadRequested).toHaveBeenCalledWith(
      expect.objectContaining({ offerId: null, leadId: null, performed: { outcome: "skipped", reason: "audience_exhausted" } }),
    );
  });

  it("records a refused source as `skipped` with its reason and detail", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "refused", reason: "source_budget_reached", campaignId: SOURCE_CAMPAIGN, detail: "spent 500c of 500c" });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);

    await post(app, AUDIENCE);

    expect(recordLeadRequested).toHaveBeenCalledWith(
      expect.objectContaining({ performed: { outcome: "skipped", reason: "source_budget_reached", detail: "spent 500c of 500c" } }),
    );
  });

  it("a retried serve answered from the idempotency cache records nothing (one ask, one event)", async () => {
    findFirst.mockResolvedValueOnce({ response: { found: true, lead: { leadId: "cached-1" } } });

    await post(app);

    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("a serve that fails (500) records nothing: the caller's retry under the same run is the ask", async () => {
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockRejectedValueOnce(new Error("boom"));

    const res = await post(app);

    expect(res.status).toBe(500);
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });
});
