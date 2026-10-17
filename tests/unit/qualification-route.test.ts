import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const getCriterion = vi.fn();
const listCriteria = vi.fn();
const estimateCostPerRow = vi.fn();
const resolveProbe = vi.fn();
const runCriterionOnLeads = vi.fn();
const recentServedLeadIds = vi.fn();
const leadsOfBrand = vi.fn();
const createRun = vi.fn();
const updateRun = vi.fn();
const getRunTotalCents = vi.fn();
const insertReturning = vi.fn();
const insertedValues: unknown[] = [];
const updateSet: unknown[] = [];
const updateReturning = vi.fn();
const passRates = vi.fn();
const listBrandCriteria = vi.fn();
const generateSuggestions = vi.fn();
const readLeadQualification = vi.fn();
const buildFullLeadsBatch = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (v: unknown) => (insertedValues.push(v), { returning: insertReturning }) }),
    update: () => ({ set: (v: unknown) => (updateSet.push(v), { where: () => ({ returning: updateReturning }) }) }),
  },
}));

vi.mock("../../src/lib/lead-shape.js", () => ({ buildFullLeadsBatch: (...a: unknown[]) => buildFullLeadsBatch(...a) }));

vi.mock("../../src/lib/qualification.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getCriterion: (...a: unknown[]) => getCriterion(...a),
    listCriteria: (...a: unknown[]) => listCriteria(...a),
    listBrandCriteria: (...a: unknown[]) => listBrandCriteria(...a),
    passRates: (...a: unknown[]) => passRates(...a),
    estimateCostPerRow: (...a: unknown[]) => estimateCostPerRow(...a),
    resolveProbe: (...a: unknown[]) => resolveProbe(...a),
  };
});

vi.mock("../../src/lib/qualification-run.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    runCriterionOnLeads: (...a: unknown[]) => runCriterionOnLeads(...a),
    recentServedLeadIds: (...a: unknown[]) => recentServedLeadIds(...a),
    leadsOfBrand: (...a: unknown[]) => leadsOfBrand(...a),
    generateSuggestions: (...a: unknown[]) => generateSuggestions(...a),
    readLeadQualification: (...a: unknown[]) => readLeadQualification(...a),
  };
});

const runPreview = vi.fn();
const getPreview = vi.fn();
const readPreview = vi.fn();
vi.mock("../../src/lib/qualification-preview.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    PREVIEW_WAIT_MS: 50,
    runPreview: (...a: unknown[]) => runPreview(...a),
    getPreview: (...a: unknown[]) => getPreview(...a),
    previewCriteria: async () => [],
    readPreview: (...a: unknown[]) => readPreview(...a),
  };
});

vi.mock("../../src/lib/runs-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createRun: (...a: unknown[]) => createRun(...a),
    updateRun: (...a: unknown[]) => updateRun(...a),
    getRunTotalCents: (...a: unknown[]) => getRunTotalCents(...a),
  };
});

let app: express.Express;
beforeAll(async () => {
  const { default: routes } = await import("../../src/routes/qualification.js");
  app = express();
  app.use(express.json());
  app.use(routes);
});

const LEAD_A = "11111111-1111-4111-8111-111111111111";
const criterion = {
  id: "c1",
  orgId: "org-1",
  brandId: "b1",
  offerId: "offer-a",
  question: "Is the site slow?",
  why: null,
  title: null,
  recommendedMode: null,
  recommendedModeReason: null,
  probe: { kind: "company_data" },
  mode: "mention",
  enabled: true,
  origin: "custom",
  createdAt: new Date("2026-10-07T00:00:00Z"),
  updatedAt: null,
};
const RATE = { checked: 4, yes: 1, no: 2, unavailable: 1, passRate: 0.25 };
const H = { "x-api-key": "test-api-key", "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "run-parent" };

beforeEach(() => {
  vi.clearAllMocks();
  estimateCostPerRow.mockResolvedValue({ perRowUsd: 0.01, probeUsd: 0.008, aiUsd: 0.002, storageUsd: 0 });
  createRun.mockResolvedValue({ id: "run-child" });
  updateRun.mockResolvedValue(undefined);
  getRunTotalCents.mockResolvedValue({ totalCents: 3, actualCents: 3 });
  insertedValues.length = 0;
  updateSet.length = 0;
  passRates.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, RATE])));
});

describe("POST sample", () => {
  const path = "/orgs/brands/b1/offers/offer-a/qualification/criteria/c1/sample";

  it("refuses to spend without a user and a run", async () => {
    getCriterion.mockResolvedValue(criterion);
    recentServedLeadIds.mockResolvedValue([LEAD_A]);
    const res = await request(app).post(path).set({ "x-api-key": "test-api-key", "x-org-id": "org-1" }).send({ limit: 2 });
    expect(res.status).toBe(400);
    expect(runCriterionOnLeads).not.toHaveBeenCalled();
  });

  it("refuses both or neither of limit and leadIds, and a sample above the cap", async () => {
    expect((await request(app).post(path).set(H).send({})).status).toBe(400);
    expect((await request(app).post(path).set(H).send({ limit: 2, leadIds: [LEAD_A] })).status).toBe(400);
    expect((await request(app).post(path).set(H).send({ limit: 26 })).status).toBe(400);
  });

  it("404s an unknown criterion (looked up on THIS offer) and a lead of another brand", async () => {
    getCriterion.mockResolvedValue(null);
    expect((await request(app).post(path).set(H).send({ limit: 2 })).status).toBe(404);
    expect(getCriterion).toHaveBeenCalledWith({ orgId: "org-1", brandId: "b1", offerId: "offer-a" }, "c1");
    getCriterion.mockResolvedValue(criterion);
    leadsOfBrand.mockResolvedValue(new Set());
    const res = await request(app).post(path).set(H).send({ leadIds: [LEAD_A] });
    expect(res.status).toBe(404);
    expect(res.body.leadIds).toEqual([LEAD_A]);
  });

  it("runs on a child run of the caller's run and reports the measured cost per row", async () => {
    getCriterion.mockResolvedValue(criterion);
    recentServedLeadIds.mockResolvedValue([LEAD_A, "22222222-2222-4222-8222-222222222222"]);
    runCriterionOnLeads.mockResolvedValue([{ leadId: LEAD_A }, { leadId: "x" }]);
    const res = await request(app).post(path).set(H).send({ limit: 2 });
    expect(res.status).toBe(200);
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ parentRunId: "run-parent", orgId: "org-1", userId: "user-1", taskName: "qualification-sample" }));
    expect(runCriterionOnLeads.mock.calls[0][2]).toMatchObject({ runId: "run-child", orgId: "org-1", userId: "user-1", brandId: "b1" });
    expect(res.body.run).toEqual({ id: "run-child", rows: 2, totalCostUsd: 0.03, costPerRowUsd: 0.015 });
    expect(updateRun).toHaveBeenCalledWith("run-child", "completed", expect.anything());
  });

  it("insufficient credit is a 402 and the run is closed failed", async () => {
    const { InsufficientCreditError } = await import("../../src/lib/treg-client.js");
    getCriterion.mockResolvedValue(criterion);
    recentServedLeadIds.mockResolvedValue([LEAD_A]);
    runCriterionOnLeads.mockRejectedValue(new InsufficientCreditError(0, 5));
    const res = await request(app).post(path).set(H).send({ limit: 1 });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe("insufficient_credit");
    expect(updateRun).toHaveBeenCalledWith("run-child", "failed", expect.anything());
  });
});

describe("POST criteria", () => {
  const path = "/orgs/brands/b1/offers/offer-a/qualification/criteria";

  it("refuses an unusable probe with its reason", async () => {
    resolveProbe.mockResolvedValue({ ok: false, reason: "x.y: unbindable_input" });
    const res = await request(app).post(path).set(H).send({ question: "Do they hire?", probe: { tregEndpointIds: ["x.y"] }, mode: "mention", enabled: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "unusable_probe", reason: "x.y: unbindable_input" });
  });

  it("refuses an unknown mode", async () => {
    const res = await request(app).post(path).set(H).send({ question: "Do they hire?", probe: { builtin: "job_postings" }, mode: "maybe" });
    expect(res.status).toBe(400);
  });

  it("refuses a create that does not say on or off", async () => {
    const res = await request(app).post(path).set(H).send({ question: "Do they hire?", probe: { builtin: "job_postings" }, mode: "mention" });
    expect(res.status).toBe(400);
  });

  it("creates on the offer with its estimate, switch and pass rate", async () => {
    resolveProbe.mockResolvedValue({ ok: true, spec: { kind: "company_data" } });
    insertReturning.mockResolvedValue([criterion]);
    const res = await request(app).post(path).set(H).send({ question: "Is the site slow?", probe: { builtin: "company_data" }, mode: "mention", enabled: true });
    expect(res.status).toBe(201);
    expect(insertedValues[0]).toMatchObject({ orgId: "org-1", brandId: "b1", offerId: "offer-a", enabled: true, origin: "custom" });
    expect(res.body.criterion).toMatchObject({ id: "c1", offerId: "offer-a", enabled: true, origin: "custom", availability: "in_our_data", source: "Company data we hold", estimate: { perRowUsd: 0.01 }, passRate: RATE });
  });

  it("lists the offer's criteria with their pass rates", async () => {
    listCriteria.mockResolvedValue([criterion]);
    const res = await request(app).get(path).set(H);
    expect(res.status).toBe(200);
    expect(listCriteria).toHaveBeenCalledWith({ orgId: "org-1", brandId: "b1", offerId: "offer-a" });
    expect(res.body.criteria[0]).toMatchObject({ id: "c1", passRate: RATE });
  });
});

describe("PATCH / DELETE criterion", () => {
  const path = "/orgs/brands/b1/offers/offer-a/qualification/criteria/c1";

  it("turns a check on and changes its mode, stamping who-touched-it time", async () => {
    updateReturning.mockResolvedValue([{ ...criterion, enabled: true, mode: "must_pass" }]);
    const res = await request(app).patch(path).set(H).send({ enabled: true, mode: "must_pass" });
    expect(res.status).toBe(200);
    expect(updateSet[0]).toMatchObject({ enabled: true, mode: "must_pass", updatedAt: expect.any(Date) });
    expect(res.body.criterion).toMatchObject({ enabled: true, mode: "must_pass" });
  });

  it("refuses an empty patch and an unknown field", async () => {
    expect((await request(app).patch(path).set(H).send({})).status).toBe(400);
    expect((await request(app).patch(path).set(H).send({ question: "x" })).status).toBe(400);
  });

  it("404s a criterion not on this offer", async () => {
    updateReturning.mockResolvedValue([]);
    expect((await request(app).patch(path).set(H).send({ enabled: false })).status).toBe(404);
    expect((await request(app).delete(path).set(H)).status).toBe(404);
  });
});

describe("POST suggestions", () => {
  it("writes them as criteria of the offer and returns them with pass rates", async () => {
    generateSuggestions.mockResolvedValue({
      rows: [
        {
          ...criterion,
          enabled: false,
          origin: "suggested",
          why: "Slow sites lose buyers.",
          title: "Slow site",
          mode: "must_pass",
          recommendedMode: "must_pass",
          recommendedModeReason: "Must have: a fast site cannot use this offer.",
        },
      ],
      dropped: [{ question: "Is it in retail?", reason: "firmographic_not_universal" }],
    });
    const res = await request(app).post("/orgs/brands/b1/offers/offer-a/qualification/suggestions").set(H).send({});
    expect(res.status).toBe(200);
    expect(res.body.dropped).toEqual([{ question: "Is it in retail?", reason: "firmographic_not_universal" }]);
    expect(generateSuggestions.mock.calls[0][0]).toMatchObject({ orgId: "org-1", brandId: "b1", offerId: "offer-a", identity: { runId: "run-child" } });
    expect(res.body.criteria[0]).toMatchObject({
      enabled: false,
      origin: "suggested",
      why: "Slow sites lose buyers.",
      title: "Slow site",
      mode: "must_pass",
      recommendation: { mode: "must_pass", reason: "Must have: a fast site cannot use this offer." },
    });
  });
});

describe("POST suggestions, unreadable draft", () => {
  it("is a 502 with a code the dashboard can name, and the run is closed failed", async () => {
    const { SuggestionDraftUnreadableError } = await import("../../src/lib/qualification-run.js");
    generateSuggestions.mockRejectedValue(new SuggestionDraftUnreadableError("hello"));
    const res = await request(app).post("/orgs/brands/b1/offers/offer-a/qualification/suggestions").set(H).send({});
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "suggestion_draft_unreadable", runId: "run-child" });
    expect(updateRun).toHaveBeenCalledWith("run-child", "failed", expect.anything());
  });
});

describe("POST suggestions, chat-service refuses for lack of money", () => {
  it("is a 402 insufficient_credit, never a 502, and the run is closed failed", async () => {
    // The refusal exactly as chat-service /complete answers it (prod 2026-10-12, org at $0).
    const { complete } = await import("../../src/lib/chat-complete-client.js");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Insufficient credits", balance_cents: 0, required_cents: 3 }), { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const refusal = await complete({ systemPrompt: "s", message: "m", json: true }, { orgId: "org-1", userId: "user-1", runId: "run-child", brandId: "b1", campaignId: null, workflowSlug: null, featureSlug: null }).catch((e) => e);
    vi.unstubAllGlobals();
    generateSuggestions.mockRejectedValue(refusal);
    const res = await request(app).post("/orgs/brands/b1/offers/offer-a/qualification/suggestions").set(H).send({});
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "Insufficient credit", code: "insufficient_credit", balanceCents: 0, requiredCents: 3 });
    expect(updateRun).toHaveBeenCalledWith("run-child", "failed", expect.anything());
  });
});

describe("a sales-funnel MAX BUDGET refusal (FUNNEL-CAP-NAMED-402-1016)", () => {
  it("billing's cap refusal stays a 402 insufficient_credit, names the cause and carries reason + sales_funnel_cap verbatim", async () => {
    const { InsufficientCreditError } = await import("../../src/lib/treg-client.js");
    const cap = { salesFunnelId: "sf-1", salesFunnelCampaignId: "c-1", amountCents: 5000, period: "day", consumedCents: 5000, reservedCents: 0 };
    generateSuggestions.mockRejectedValue(new InsufficientCreditError(90000, 3, { reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap }));
    const res = await request(app).post("/orgs/brands/b1/offers/offer-a/qualification/suggestions").set(H).send({});
    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      error: "Sales funnel max budget reached",
      code: "insufficient_credit",
      balanceCents: 90000,
      requiredCents: 3,
      reason: "sales_funnel_max_budget_reached",
      sales_funnel_cap: cap,
    });
  });

  it("a balance refusal (no reason) is byte-identical to today", async () => {
    const { InsufficientCreditError } = await import("../../src/lib/treg-client.js");
    generateSuggestions.mockRejectedValue(new InsufficientCreditError(0, 3));
    const res = await request(app).post("/orgs/brands/b1/offers/offer-a/qualification/suggestions").set(H).send({});
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "Insufficient credit", code: "insufficient_credit", balanceCents: 0, requiredCents: 3 });
  });
});

describe("GET lead qualification", () => {
  const lead = { leadId: LEAD_A, organization: null };
  beforeEach(() => {
    leadsOfBrand.mockResolvedValue(new Set([LEAD_A]));
    buildFullLeadsBatch.mockResolvedValue(new Map([[LEAD_A, lead]]));
    readLeadQualification.mockResolvedValue({ domain: null, checks: [] });
  });

  it("reads only ENABLED criteria, of the offer named", async () => {
    listCriteria.mockResolvedValue([criterion, { ...criterion, id: "off", enabled: false }]);
    const res = await request(app).get(`/orgs/leads/${LEAD_A}/qualification?brandId=b1&offerId=offer-a`).set(H);
    expect(res.status).toBe(200);
    expect(listCriteria).toHaveBeenCalledWith({ orgId: "org-1", brandId: "b1", offerId: "offer-a" });
    expect(readLeadQualification.mock.calls[0][1].map((c: { id: string }) => c.id)).toEqual(["c1"]);
  });

  it("without an offer, reads every offer of the brand", async () => {
    listBrandCriteria.mockResolvedValue([criterion]);
    await request(app).get(`/orgs/leads/${LEAD_A}/qualification?brandId=b1`).set(H);
    expect(listBrandCriteria).toHaveBeenCalledWith("org-1", "b1");
  });

  it("refuses an empty offerId", async () => {
    expect((await request(app).get(`/orgs/leads/${LEAD_A}/qualification?brandId=b1&offerId=`).set(H)).status).toBe(400);
  });
});

describe("POST/GET previews (companies that are not leads, PREVIEW-CHECKS-1017)", () => {
  const path = "/orgs/brands/b1/offers/offer-a/qualification/previews";
  const PREVIEW_ID = "22222222-2222-4222-8222-222222222222";
  const row = (status: string, error: string | null = null) => ({ id: PREVIEW_ID, orgId: "org-1", brandId: "b1", offerId: "offer-a", runId: "run-child", status, error, companies: [], criterionIds: ["c1"], createdAt: new Date(), finishedAt: null });
  const answer = (status: string, error: { code: string; message: string } | null = null) => ({ id: PREVIEW_ID, brandId: "b1", offerId: "offer-a", status, error, createdAt: "t", finishedAt: null, checks: [], companies: [] });

  it("refuses an unusable domain, an empty list and more than 10 companies, before anything is spent", async () => {
    for (const body of [{ companies: [{ domain: "nope", name: "x" }] }, { companies: [] }, { companies: Array.from({ length: 11 }, (_, i) => ({ domain: `c${i}.com`, name: "x" })) }]) {
      const res = await request(app).post(path).set(H).send(body);
      expect(res.status).toBe(400);
    }
    const res = await request(app).post(path).set(H).send({ companies: [{ domain: "nope", name: "x" }] });
    expect(res.body).toMatchObject({ code: "invalid_domain", domains: ["nope"] });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("refuses to spend without a user and a run when the offer has enabled checks", async () => {
    listCriteria.mockResolvedValue([criterion]);
    const res = await request(app).post(path).set({ "x-api-key": "test-api-key", "x-org-id": "org-1" }).send({ companies: [{ domain: "acme.com", name: "Acme" }] });
    expect(res.status).toBe(400);
    expect(runPreview).not.toHaveBeenCalled();
  });

  it("opens a child run, starts the checks with only the ENABLED criteria, and answers 202 while running", async () => {
    listCriteria.mockResolvedValue([criterion, { ...criterion, id: "c-off", enabled: false }]);
    insertReturning.mockResolvedValue([row("running")]);
    runPreview.mockReturnValue(new Promise(() => {}));
    getPreview.mockResolvedValue(row("running"));
    readPreview.mockResolvedValue(answer("running"));
    const res = await request(app).post(path).set(H).send({ companies: [{ domain: "https://www.Acme.com", name: "Acme" }, { domain: "acme.com", name: "dup" }] });
    expect(res.status).toBe(202);
    expect(res.body.preview).toMatchObject({ id: PREVIEW_ID, status: "running", run: { id: "run-child", totalCostUsd: null } });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", userId: "user-1", parentRunId: "run-parent", taskName: "qualification-preview" }));
    expect(insertedValues[0]).toMatchObject({ companies: [{ domain: "acme.com", name: "Acme" }], criterionIds: ["c1"], runId: "run-child", status: "running" });
    expect((runPreview.mock.calls[0][1] as Array<{ id: string }>).map((c) => c.id)).toEqual(["c1"]);
  });

  it("answers 200 with the run total once done, and 402 when the org could not pay", async () => {
    listCriteria.mockResolvedValue([criterion]);
    insertReturning.mockResolvedValue([row("running")]);
    runPreview.mockResolvedValue(undefined);
    getPreview.mockResolvedValue(row("completed"));
    readPreview.mockResolvedValue(answer("completed"));
    const ok = await request(app).post(path).set(H).send({ companies: [{ domain: "acme.com", name: "Acme" }] });
    expect(ok.status).toBe(200);
    expect(ok.body.preview.run).toEqual({ id: "run-child", totalCostUsd: 0.03 });

    getPreview.mockResolvedValue(row("failed", "insufficient_credit: balance 0c"));
    readPreview.mockResolvedValue(answer("failed", { code: "insufficient_credit", message: "balance 0c" }));
    const broke = await request(app).post(path).set(H).send({ companies: [{ domain: "acme.com", name: "Acme" }] });
    expect(broke.status).toBe(402);
    expect(broke.body).toMatchObject({ code: "insufficient_credit", preview: { status: "failed" } });
  });

  it("an offer with no enabled check runs nothing and spends nothing", async () => {
    listCriteria.mockResolvedValue([{ ...criterion, enabled: false }]);
    insertReturning.mockResolvedValue([{ ...row("completed"), runId: null, criterionIds: [] }]);
    getPreview.mockResolvedValue({ ...row("completed"), runId: null, criterionIds: [] });
    readPreview.mockResolvedValue(answer("completed"));
    const res = await request(app).post(path).set({ "x-api-key": "test-api-key", "x-org-id": "org-1" }).send({ companies: [{ domain: "acme.com", name: "Acme" }] });
    expect(res.status).toBe(200);
    expect(res.body.preview.run).toBeNull();
    expect(createRun).not.toHaveBeenCalled();
    expect(runPreview).not.toHaveBeenCalled();
  });

  it("GET reads the preview back; an unknown or malformed id is 404 preview_not_found", async () => {
    getPreview.mockResolvedValue(row("completed"));
    readPreview.mockResolvedValue(answer("completed"));
    const res = await request(app).get(`${path}/${PREVIEW_ID}`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.preview.id).toBe(PREVIEW_ID);
    getPreview.mockResolvedValue(null);
    expect((await request(app).get(`${path}/${PREVIEW_ID}`).set(H)).body.code).toBe("preview_not_found");
    expect((await request(app).get(`${path}/not-a-uuid`).set(H)).status).toBe(404);
  });
});
