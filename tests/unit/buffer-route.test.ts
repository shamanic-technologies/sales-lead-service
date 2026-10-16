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
vi.mock("../../src/lib/relationship-read.js", () => ({
  relationshipOfLead: vi.fn(async () => ({ humanId: null, company: null, tags: [], unsureTags: [], judgedAt: null, details: [], policies: { business_only: false } })),
}));
vi.mock("../../src/db/index.js", () => ({
  db: {
    query: { idempotencyCache: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    // The served person's row on the asking campaign (lead.leadCampaignId).
    execute: async () => [{ id: "row-1" }],
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
  isStepFilterRefusal: (e: { status?: number } | null, f: unknown) => !!f && e?.status === 400,
}));

const resolveSourcingOriginSlug = vi.fn();
// How each channel reaches a person (features-service contactMethodsByChannel), as the catalogue states it.
const CONTACT_METHODS: Record<string, string[]> = {
  "cold-whatsapp-outreach": ["phone"],
  "sales-cold-email-outreach": ["email"],
  "cold-linkedin-outreach": ["linkedin"],
};
vi.mock("../../src/lib/sourcing-origin.js", () => {
  class OriginNotFedError extends Error {
    constructor(
      readonly originSlug: string,
      readonly channelSlug: string,
      readonly audienceId: string,
    ) {
      super(`audience ${audienceId} serves from ${originSlug}, which does not feed ${channelSlug}`);
    }
  }
  return {
    OriginNotFedError,
    resolveSourcingOriginSlug: (...a: unknown[]) => resolveSourcingOriginSlug(...a),
    loadChannelContactMethods: async (slug: string) => CONTACT_METHODS[slug] ?? null,
  };
});

const resolveServeSource = vi.fn();
vi.mock("../../src/lib/source-campaign.js", () => ({
  resolveServeSource: (...a: unknown[]) => resolveServeSource(...a),
}));

// Default: campaign-service states no source that runs on its own (runsOnItsOwn absent) = today's serve.
const decideSourceMode = vi.fn();
vi.mock("../../src/lib/source-mode.js", () => ({
  decideSourceMode: (...a: unknown[]) => decideSourceMode(...a),
}));

const resolveSourceAudiences = vi.fn();
vi.mock("../../src/lib/source-audiences.js", () => ({
  resolveSourceAudiences: (...a: unknown[]) => resolveSourceAudiences(...a),
}));

const openOnDemandRun = vi.fn();
vi.mock("../../src/lib/on-demand-run.js", () => ({
  openOnDemandRun: (...a: unknown[]) => openOnDemandRun(...a),
}));

vi.mock("../../src/lib/source-audience-walk.js", () => ({
  loadEmptyAnswers: async () => new Map(),
  orderByEmptyAnswers: (ids: string[]) => ids,
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
    decideSourceMode.mockResolvedValue({ kind: "today", read: null });
    openOnDemandRun.mockImplementation(async (p: { campaignId: string }) => ({
      runId: "on-demand-run-1",
      campaignId: p.campaignId,
      featureSlug: "sourcing-apollo-cold-filters",
      workflowSlug: "sourcing-apollo-cold-filters-scheat",
      brandIds: [BRAND],
    }));
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
      sourceSlug: "sourcing-apollo-cold-filters",
      offerId: "70000000-0000-0000-0000-000000000001",
    });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(resolveServeSource).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      brandId: BRAND,
      outreachCampaignId: CAMPAIGN,
      originSlug: "sourcing-apollo-cold-filters",
      runId: RUN,
    }));
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        taskName: "lead-serve",
        // Under the source unit's own on-demand run (src/lib/on-demand-run.ts), never the cold email run.
        parentRunId: "on-demand-run-1",
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

  it("a serve filed under LEAD SOURCING runs under `lead-sourcing` (owner 2026-10-11), the lead stays the outreach campaign's", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-buying-signals");
    resolveServeSource.mockResolvedValueOnce({
      kind: "source",
      campaignId: SOURCE_CAMPAIGN,
      originSlug: "sourcing-apollo-buying-signals",
      sourceSlug: "lead-sourcing",
      offerId: "70000000-0000-0000-0000-000000000001",
    });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ taskName: "lead-serve", campaignId: SOURCE_CAMPAIGN, featureSlug: "lead-sourcing" }));
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, runCampaignId: SOURCE_CAMPAIGN, runFeatureSlug: "lead-sourcing" }),
      expect.anything(),
    );
    expect(updateRun).toHaveBeenCalledWith("serve-run-1", "completed", expect.objectContaining({ campaignId: SOURCE_CAMPAIGN, featureSlug: "lead-sourcing" }));
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
    resolveServeSource.mockResolvedValue({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-cold-filters", sourceSlug: "sourcing-apollo-cold-filters", offerId: "o" });
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
  // ── on_demand: the source unit's OWN run (src/lib/on-demand-run.ts, owner 2026-10-11) ──────
  it("a serve under a source unit runs under the unit's OWN on-demand run, with the unit's workflow, and closes it", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-cold-filters", sourceSlug: "sourcing-apollo-cold-filters", offerId: "offer-1" });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(200);
    expect(openOnDemandRun).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, callerRunId: RUN, campaignId: SOURCE_CAMPAIGN, audienceId: AUDIENCE }),
    );
    // The serve hangs from the unit's run, never the cold email run, and carries the unit's workflow.
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "lead-serve", parentRunId: "on-demand-run-1", campaignId: SOURCE_CAMPAIGN, workflowSlug: "sourcing-apollo-cold-filters-scheat" }),
    );
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "serve-run-1", workflowSlug: "sourcing-apollo-cold-filters-scheat", parentRunId: RUN }),
      expect.anything(),
    );
    expect(updateRun).toHaveBeenCalledWith("serve-run-1", "completed", expect.objectContaining({ workflowSlug: "sourcing-apollo-cold-filters-scheat" }));
    expect(updateRun).toHaveBeenCalledWith("on-demand-run-1", "completed", expect.objectContaining({ campaignId: SOURCE_CAMPAIGN }));
  });

  it("a legacy serve (no source unit) opens no on-demand run: today's serve under the caller's run", async () => {
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    await post(app);

    expect(openOnDemandRun).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: RUN }));
  });

  it("fails loud (500, no serve) when the unit's run cannot be opened", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-cold-filters", sourceSlug: "sourcing-apollo-cold-filters", offerId: "offer-1" });
    openOnDemandRun.mockRejectedValueOnce(new Error("campaign-service refused to open the on-demand run (409)"));

    const res = await post(app, AUDIENCE);

    expect(res.status).toBe(500);
    expect(createRun).not.toHaveBeenCalled();
    expect(pullNext).not.toHaveBeenCalled();
  });

  // ── on_demand trigger events (src/lib/lead-requested-events.ts) ───────────────────────
  it("records ONE on_demand event `ran` under the SOURCE campaign, naming the lead and the outreach campaign that asked", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-cold-filters", sourceSlug: "sourcing-apollo-cold-filters", offerId: "offer-1" });
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
    resolveServeSource.mockResolvedValueOnce({ kind: "refused", reason: "source_campaign_off", campaignId: SOURCE_CAMPAIGN, detail: "source campaign is off" });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);

    await post(app, AUDIENCE);

    expect(recordLeadRequested).toHaveBeenCalledWith(
      expect.objectContaining({ performed: { outcome: "skipped", reason: "source_campaign_off", detail: "source campaign is off" } }),
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

  // --- LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): every pipe is independent (src/lib/source-mode.ts) ---

  const UNIT = "80000000-0000-0000-0000-000000000001";
  const OFFER_ID = "70000000-0000-0000-0000-000000000001";
  const unit = (status = "ongoing") => ({ id: UNIT, featureSlug: "sourcing-apollo-cold-filters", offerId: OFFER_ID, brandId: BRAND, status });
  const postAsUnit = (audienceId?: string, body: Record<string, unknown> = {}) => {
    const r = request(app)
      .post("/orgs/buffer/next")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .set("x-run-id", RUN)
      .set("x-campaign-id", UNIT)
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", "sourcing-apollo-cold-filters");
    if (audienceId) r.set("x-audience-id", audienceId);
    return r.send(body);
  };

  it("a source unit's OWN run (no x-audience-id) finds in its own audiences, files under itself, opens no on-demand run, records no on_demand event", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1", "aud-2"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    const res = await postAsUnit();

    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(decideSourceMode).toHaveBeenCalledWith({ orgId: ORG, campaignId: UNIT, featureSlug: "sourcing-apollo-cold-filters" });
    expect(resolveSourceAudiences).toHaveBeenCalledWith(expect.objectContaining({ brandId: BRAND, offerId: OFFER_ID, unitSlug: "sourcing-apollo-cold-filters", preferredAudienceId: null }));
    expect(openOnDemandRun).not.toHaveBeenCalled();
    expect(resolveSourcingOriginSlug).not.toHaveBeenCalled();
    expect(resolveServeSource).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: RUN, campaignId: UNIT, featureSlug: "sourcing-apollo-cold-filters" }));
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: UNIT,
        runCampaignId: UNIT,
        featureSlug: "sourcing-apollo-cold-filters",
        runFeatureSlug: "sourcing-apollo-cold-filters",
        mode: { kind: "find", audienceIds: ["aud-1", "aud-2"] },
      }),
      expect.anything(),
    );
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("a source unit's own run stating population contacted_pure_prospects walks no audience, finds in the brand's contacted people, answers the row id (NEVER-NO-FOLLOWUP-1014)", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co", data: {} } });

    const res = await postAsUnit(undefined, { population: "contacted_pure_prospects" });

    expect(res.status).toBe(200);
    expect(res.body.lead.leadCampaignId).toBe("row-1");
    expect(resolveSourceAudiences).not.toHaveBeenCalled();
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ campaignId: UNIT, mode: { kind: "find_contacted" } }), expect.anything());
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("population stated by a campaign that is not a source unit is a 400, nothing served", async () => {
    const res = await request(app)
      .post("/orgs/buffer/next")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .set("x-run-id", RUN)
      .set("x-campaign-id", CAMPAIGN)
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", "lead-finder-v1")
      .send({ population: "contacted_pure_prospects" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("population_needs_source_unit");
    expect(pullNext).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("a source unit's own run asks with the email policy ITS OWN workflow states (CATCHALL-SOURCE-OWNS-1014)", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    await postAsUnit(undefined, { acceptedEmails: "valid_and_catch_all" });

    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ acceptedEmails: "valid_and_catch_all", mode: { kind: "find", audienceIds: ["aud-1"] } }), expect.anything());
  });

  it("valid_catch_all_and_unknown reaches the serve as itself, never narrowed to valid_and_catch_all (UNKNOWN-RESTORE-1016)", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    const res = await postAsUnit(undefined, { acceptedEmails: "valid_catch_all_and_unknown" });

    expect(res.status).toBe(200);
    expect(pullNext.mock.calls[0][0].acceptedEmails).toBe("valid_catch_all_and_unknown");
  });

  it("a source unit's own run stating nothing sends no policy, whatever the pipes it feeds accept (valid only)", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    await postAsUnit();

    expect(pullNext.mock.calls[0][0]).not.toHaveProperty("acceptedEmails");
  });

  it("a stock ask passes the pipe's own word only, and records nothing for the sources it reads", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "stock", sourceCampaignIds: [UNIT], read: { offerId: OFFER_ID, sourced: true, sourceCampaigns: [] } });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "source_stock_empty" });

    await request(app)
      .post("/orgs/buffer/next")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .set("x-run-id", RUN)
      .set("x-campaign-id", CAMPAIGN)
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", "sales-cold-email-outreach")
      .send({});

    expect(pullNext.mock.calls[0][0]).not.toHaveProperty("acceptedEmails");
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ mode: { kind: "stock", sourceCampaignIds: [UNIT] } }), expect.anything());
  });

  it("a source unit's own run walks its audiences with the reach its lead strategy states (the workflow's reachableBy)", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1", "aud-2"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    const res = await postAsUnit(undefined, { reachableBy: ["phone"] });

    expect(res.status).toBe(200);
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ reachableBy: ["phone"], mode: { kind: "find", audienceIds: ["aud-1", "aud-2"] } }), expect.anything());
  });

  // --- CRM-WARM-NURTURE-1015: the pipe's CRM funnel-step filter, crm-service's vocabulary, carried verbatim ---
  const STEP_FILTER = { reached: ["form_submission", "meeting_booked"], notReached: ["sale", "disqualified"] };

  it("a source unit's own run passes its stepFilter VERBATIM to the serve", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    const res = await postAsUnit(undefined, { stepFilter: { ...STEP_FILTER, futureKey: ["x"] } });

    expect(res.status).toBe(200);
    expect(pullNext.mock.calls[0][0].stepFilter).toEqual({ ...STEP_FILTER, futureKey: ["x"] });
  });

  it("a run stating no stepFilter passes none (today's serve)", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    await postAsUnit();

    expect(pullNext.mock.calls[0][0]).not.toHaveProperty("stepFilter");
  });

  it("a stepFilter crm-service refuses (400 downstream) is a 400 step_filter_refused, never found:false, nothing cached", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockRejectedValueOnce(Object.assign(new Error('People gateway call failed: 400 - {"error":"unknown step: meeting"}'), { status: 400 }));

    const res = await postAsUnit(undefined, { stepFilter: { reached: ["meeting"] } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("step_filter_refused");
    expect(res.body.detail).toContain("unknown step: meeting");
    expect(res.body).not.toHaveProperty("found");
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledWith("serve-run-1", "failed", expect.anything());
  });

  it("a downstream 400 on a run stating NO stepFilter stays today's 500", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit() });
    resolveSourceAudiences.mockResolvedValueOnce({ kind: "walk", audienceIds: ["aud-1"] });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockRejectedValueOnce(Object.assign(new Error("People gateway call failed: 400 - bad"), { status: 400 }));

    const res = await postAsUnit();

    expect(res.status).toBe(500);
  });

  it("stepFilter with population is a 400 (the contacted people are walked where no step filter applies), nothing served", async () => {
    const res = await postAsUnit(undefined, { population: "contacted_pure_prospects", stepFilter: STEP_FILTER });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("step_filter_needs_audience_serve");
    expect(decideSourceMode).not.toHaveBeenCalled();
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("a stepFilter that is not an object, or a step list that is not strings, is a 400", async () => {
    for (const stepFilter of ["sale", ["sale"], { reached: "sale" }, { notReached: [1] }]) {
      const res = await postAsUnit(undefined, { stepFilter });
      expect(res.status).toBe(400);
    }
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("a reachableBy outside email|phone, or empty, is a 400 and nothing is bought", async () => {
    for (const reachableBy of [["linkedin"], [], "phone"]) {
      const res = await postAsUnit(undefined, { reachableBy });
      expect(res.status).toBe(400);
    }
    expect(decideSourceMode).not.toHaveBeenCalled();
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("a source unit that is not ongoing finds nothing: found:false source_campaign_off, nothing bought", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "own_run", unit: unit("stopped") });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);

    const res = await postAsUnit();

    expect(res.body).toEqual({ found: false, reason: "source_campaign_off" });
    expect(pullNext).not.toHaveBeenCalled();
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("an outreach campaign whose source runs on its own serves the STOCK: no on-demand find, no on_demand event, empty = source_stock_empty", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "stock", sourceCampaignIds: [UNIT], read: { offerId: OFFER_ID, sourced: true, sourceCampaigns: [] } });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "source_stock_empty" });

    const res = await post(app);

    expect(res.body).toEqual({ found: false, reason: "source_stock_empty" });
    expect(openOnDemandRun).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: RUN, campaignId: CAMPAIGN, featureSlug: "lead-finder-v1" }));
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: CAMPAIGN, runCampaignId: CAMPAIGN, mode: { kind: "stock", sourceCampaignIds: [UNIT] } }),
      expect.anything(),
    );
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("stock mode: an audience whose origin resolves to a source that runs on its own is served from stock, never found on demand", async () => {
    const read = { offerId: OFFER_ID, sourced: true, sourceCampaigns: [] };
    decideSourceMode.mockResolvedValueOnce({ kind: "stock", sourceCampaignIds: [UNIT], read });
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: UNIT, originSlug: "sourcing-apollo-cold-filters", sourceSlug: "sourcing-apollo-cold-filters", offerId: OFFER_ID });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    await post(app, AUDIENCE);

    expect(resolveServeSource).toHaveBeenCalledWith(expect.objectContaining({ read }));
    expect(openOnDemandRun).not.toHaveBeenCalled();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ campaignId: CAMPAIGN, featureSlug: "lead-finder-v1" }));
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ mode: { kind: "stock", sourceCampaignIds: [UNIT] } }), expect.anything());
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("stock mode: an audience whose source still answers ON DEMAND keeps today's on-demand serve", async () => {
    decideSourceMode.mockResolvedValueOnce({ kind: "stock", sourceCampaignIds: [UNIT], read: { offerId: OFFER_ID, sourced: true, sourceCampaigns: [] } });
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-buying-signals");
    resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: SOURCE_CAMPAIGN, originSlug: "sourcing-apollo-buying-signals", sourceSlug: "sourcing-apollo-buying-signals", offerId: OFFER_ID });
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

    await post(app, AUDIENCE);

    expect(openOnDemandRun).toHaveBeenCalledWith(expect.objectContaining({ campaignId: SOURCE_CAMPAIGN }));
    const pullArgs = pullNext.mock.calls[0][0] as Record<string, unknown>;
    expect(pullArgs.mode).toBeUndefined();
    expect(pullArgs.runCampaignId).toBe(SOURCE_CAMPAIGN);
    expect(recordLeadRequested).toHaveBeenCalledWith(expect.objectContaining({ performed: { outcome: "ran", campaignId: SOURCE_CAMPAIGN } }));
  });

  it("today's mode hands the sources read on: resolveServeSource does not read campaign-service twice", async () => {
    const read = { offerId: OFFER_ID, sourced: true, sourceCampaigns: [] };
    decideSourceMode.mockResolvedValueOnce({ kind: "today", read });
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    createRun.mockResolvedValueOnce({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValueOnce({ found: false, reason: "audience_exhausted" });

    await post(app, AUDIENCE);

    expect(resolveServeSource).toHaveBeenCalledWith(expect.objectContaining({ read }));
    const pullArgs = pullNext.mock.calls[0][0] as Record<string, unknown>;
    expect(pullArgs.mode).toBeUndefined();
  });
});

describe("POST /orgs/buffer/next — the pipe's reach and its sources (owner 2026-10-12)", () => {
  let app: express.Express;
  beforeAll(async () => {
    const { default: route } = await import("../../src/routes/buffer.js");
    app = express();
    app.use(express.json());
    app.use(route);
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue(undefined);
    checkConcurrentBufferNext.mockResolvedValue({ blocked: false });
    resolveServeSource.mockResolvedValue({ kind: "legacy", why: "offer_not_on_source_campaigns" });
    decideSourceMode.mockResolvedValue({ kind: "today", read: null });
    createRun.mockResolvedValue({ id: "serve-run-1" });
    updateRun.mockResolvedValue(undefined);
    pullNext.mockResolvedValue({ found: false, reason: "audience_exhausted" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function postFor(featureSlug: string) {
    return request(app)
      .post("/orgs/buffer/next")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .set("x-run-id", `${RUN.slice(0, -1)}${featureSlug.length % 10}`)
      .set("x-campaign-id", `${CAMPAIGN}-${featureSlug}`)
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", featureSlug)
      .set("x-audience-id", AUDIENCE)
      .send({});
  }

  it("a WhatsApp campaign's serve carries the phone requirement", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-crm-contacts");
    const res = await postFor("cold-whatsapp-outreach");
    expect(res.status).toBe(200);
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ reachableBy: ["phone"] }), expect.anything());
    // WA-RESERVE-LOOP-1014: its paid pool asks the channel's own sender whether a person was written to.
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ poolSender: "channel" }), expect.anything());
  });

  it("an email campaign's serve carries the email requirement", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce("sourcing-apollo-cold-filters");
    const res = await postFor("sales-cold-email-outreach");
    expect(res.status).toBe(200);
    expect(pullNext).toHaveBeenCalledWith(expect.objectContaining({ reachableBy: ["email"] }), expect.anything());
    // Email campaigns keep email-gateway: nothing new on the call.
    expect(pullNext.mock.calls[0][0]).not.toHaveProperty("poolSender");
  });

  it("a channel whose method reachableBy cannot express passes nothing", async () => {
    resolveSourcingOriginSlug.mockResolvedValueOnce(null);
    await postFor("cold-linkedin-outreach");
    expect(pullNext.mock.calls[0][0]).not.toHaveProperty("reachableBy");
  });

  it("an audience whose origin does not feed the channel is never served: the fresh serve is refused, the outreach label kept", async () => {
    const { OriginNotFedError } = await import("../../src/lib/sourcing-origin.js");
    resolveSourcingOriginSlug.mockRejectedValueOnce(
      new OriginNotFedError("sourcing-apollo-cold-filters", "cold-whatsapp-outreach", AUDIENCE),
    );
    const res = await postFor("cold-whatsapp-outreach");
    expect(res.status).toBe(200);
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({
        runFeatureSlug: "cold-whatsapp-outreach",
        freshServeRefused: expect.objectContaining({ reason: "origin_not_fed" }),
      }),
      expect.anything(),
    );
    expect(resolveServeSource).not.toHaveBeenCalled();
  });
});

describe("POST /orgs/buffer/next — a serve that NAMES its person (LEAD-NAMED-SERVE-1015)", () => {
  let app: express.Express;
  beforeAll(async () => {
    const { default: route } = await import("../../src/routes/buffer.js");
    app = express();
    app.use(express.json());
    app.use(route);
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue(undefined);
    checkConcurrentBufferNext.mockResolvedValue({ blocked: false });
    decideSourceMode.mockResolvedValue({ kind: "today", read: null });
    createRun.mockResolvedValue({ id: "serve-run-named" });
    updateRun.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  const LEAD = "60000000-0000-4000-8000-000000000001";
  let n = 0;
  function postNamed(body: Record<string, unknown>) {
    n++;
    return request(app)
      .post("/orgs/buffer/next")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG)
      .set("x-run-id", `${RUN.slice(0, -2)}${String(n).padStart(2, "0")}`)
      .set("x-campaign-id", `${CAMPAIGN}-named-${n}`)
      .set("x-brand-id", BRAND)
      .set("x-feature-slug", "sales-cold-email-outreach")
      .send(body);
  }

  it("serves in mode `named`, reads no source and records no on-demand ask", async () => {
    pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: LEAD, email: "kevin+x@distribute.you", data: {} } });
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-1" } });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(pullNext).toHaveBeenCalledWith(
      expect.objectContaining({ mode: { kind: "named", named: { leadId: LEAD, triggerEventId: "evt-1" } } }),
      expect.anything(),
    );
    expect(decideSourceMode).not.toHaveBeenCalled();
    expect(resolveSourcingOriginSlug).not.toHaveBeenCalled();
    expect(recordLeadRequested).not.toHaveBeenCalled();
  });

  it("passes a named refusal through: code, sentence, final", async () => {
    pullNext.mockResolvedValueOnce({ found: false, reason: "named_lead_unwritable", message: "We only know this person's email address.", final: true });
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-2" } });
    expect(res.body).toEqual({ found: false, reason: "named_lead_unwritable", message: "We only know this person's email address.", final: true });
  });

  it("a timed-out look is a stated wait", async () => {
    pullNext.mockResolvedValueOnce({ found: false, reason: "serve_timed_out" });
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-3" } });
    expect(res.body).toMatchObject({ found: false, reason: "serve_timed_out", final: false });
    expect(typeof res.body.message).toBe("string");
  });

  it("credit refused is a stated wait", async () => {
    pullNext.mockRejectedValueOnce(Object.assign(new Error("insufficient credit"), { name: "InsufficientCreditError" }));
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-4" } });
    expect(res.body).toMatchObject({ found: false, reason: "credit_insufficient", final: false });
  });

  it("a sales-funnel MAX BUDGET refusal names its cause: billing's reason + sales_funnel_cap verbatim, a wait (FUNNEL-CAP-NAMED-402-1016)", async () => {
    const { InsufficientCreditError } = await import("../../src/lib/treg-client.js");
    const cap = { salesFunnelId: "sf-1", salesFunnelCampaignId: "c-1", amountCents: 5000, period: "day", consumedCents: 5000, reservedCents: 0 };
    pullNext.mockRejectedValueOnce(new InsufficientCreditError(90000, 3, { reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap }));
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-cap" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      found: false,
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: cap,
      message: "This campaign reached the max budget set for it. Raise its max budget to keep it running.",
      final: false,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/credit_insufficient|topped up/);
  });

  it("apollo's cap 402 relayed through human-service keeps the cause on the serve", async () => {
    const cap = { salesFunnelId: "sf-2", salesFunnelCampaignId: "c-2", amountCents: 100, period: "week", consumedCents: 100, reservedCents: 0 };
    const apolloBody = JSON.stringify({ type: "credit_insufficient", error: "Sales funnel max budget reached", reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
    const humanBody = JSON.stringify({ error: `Apollo serve failed: 402 - ${apolloBody}`, provider: "apollo", upstreamStatus: 402 });
    pullNext.mockRejectedValueOnce(Object.assign(new Error(`People gateway call failed: 502 - ${humanBody}`), { status: 502, body: JSON.parse(humanBody) }));
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-cap-2" } });
    expect(res.body).toMatchObject({ found: false, reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap, final: false });
  });

  it("a balance refusal (no reason) is byte-identical to today", async () => {
    const { InsufficientCreditError } = await import("../../src/lib/treg-client.js");
    pullNext.mockRejectedValueOnce(new InsufficientCreditError(0, 3));
    const res = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-bal" } });
    expect(res.body).toEqual({ found: false, reason: "credit_insufficient", message: "Your balance cannot cover looking this person up. We will try again once it is topped up.", final: false });
  });

  it("refuses namedLead with population (400), and a malformed namedLead (400)", async () => {
    const both = await postNamed({ namedLead: { leadId: LEAD, triggerEventId: "evt-5" }, population: "contacted_pure_prospects" });
    expect(both.status).toBe(400);
    expect(both.body.error).toBe("named_lead_excludes_population");
    const bad = await postNamed({ namedLead: { leadId: "not-a-uuid", triggerEventId: "evt-6" } });
    expect(bad.status).toBe(400);
    expect(pullNext).not.toHaveBeenCalled();
  });

  it("a body without namedLead is today's serve (no `named` mode, no message/final added)", async () => {
    pullNext.mockResolvedValueOnce({ found: false, reason: "no_audience" });
    const res = await postNamed({});
    expect(res.body).toEqual({ found: false, reason: "no_audience" });
    expect((pullNext.mock.calls[0][0] as Record<string, unknown>).mode).toBeUndefined();
    expect(decideSourceMode).toHaveBeenCalled();
  });
});
