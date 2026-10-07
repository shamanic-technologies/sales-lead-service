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
    generateSuggestions.mockResolvedValue([{ ...criterion, enabled: false, origin: "suggested", why: "Slow sites lose buyers." }]);
    const res = await request(app).post("/orgs/brands/b1/offers/offer-a/qualification/suggestions").set(H).send({});
    expect(res.status).toBe(200);
    expect(generateSuggestions.mock.calls[0][0]).toMatchObject({ orgId: "org-1", brandId: "b1", offerId: "offer-a", identity: { runId: "run-child" } });
    expect(res.body.criteria[0]).toMatchObject({ enabled: false, origin: "suggested", why: "Slow sites lose buyers." });
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
