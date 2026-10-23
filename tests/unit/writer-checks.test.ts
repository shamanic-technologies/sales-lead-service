import { beforeEach, describe, expect, it, vi } from "vitest";

const listCriteria = vi.fn();
const listBrandCriteria = vi.fn();
vi.mock("../../src/lib/qualification.js", () => ({
  listCriteria: (...a: unknown[]) => listCriteria(...a),
  listBrandCriteria: (...a: unknown[]) => listBrandCriteria(...a),
  probeOf: (row: { probe: unknown }) => row.probe,
}));

const runCriterionOnLeads = vi.fn();
const readLeadQualification = vi.fn();
vi.mock("../../src/lib/qualification-run.js", () => ({
  runCriterionOnLeads: (...a: unknown[]) => runCriterionOnLeads(...a),
  readLeadQualification: (...a: unknown[]) => readLeadQualification(...a),
}));

const createRun = vi.fn();
const updateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => createRun(...a),
  updateRun: (...a: unknown[]) => updateRun(...a),
}));
const declareRunOutcomes = vi.fn();
vi.mock("../../src/lib/run-outcomes.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/run-outcomes.js")>()),
  declareRunOutcomes: (...a: unknown[]) => declareRunOutcomes(...a),
}));

const { offerChecks, checksForWriter } = await import("../../src/lib/writer-checks.js");

const homepage = { kind: "treg", label: "homepage", reading: "text", calls: [{ endpointId: "fetch-homepage", method: "GET", params: {}, maxMicro: 100 }] };
const linkedin = { kind: "treg", label: "linkedin", reading: "text", calls: [{ endpointId: "linkedin-posts", method: "GET", params: {}, maxMicro: 100 }] };
const crit = (id: string, mode: string, probe: unknown, enabled = true) => ({ id, mode, probe, enabled, offerId: "offer-1", question: `q ${id}` });
const lead = { leadId: "lead-1", organization: { primaryDomain: "cascobay.com" } } as never;
const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };

describe("offerChecks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is every ENABLED check of the offer, Hard filter and Bonus alike", async () => {
    listCriteria.mockResolvedValue([crit("a", "must_pass", homepage), crit("b", "mention", linkedin), crit("c", "mention", linkedin, false)]);
    const rows = await offerChecks("org-1", "brand-1", "offer-1");
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("names nothing when the offer is unresolved, loudly when the brand has enabled checks", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    listBrandCriteria.mockResolvedValue([crit("b", "mention", linkedin)]);
    expect(await offerChecks("org-1", "brand-1", null)).toEqual([]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("offer-1"));
  });
});

describe("checksForWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readLeadQualification.mockResolvedValue({ domain: "cascobay.com", checks: [] });
    createRun.mockResolvedValue({ id: "research-1" });
    updateRun.mockResolvedValue(undefined);
  });

  it("runs every Bonus check on the lead, never a Hard filter, then reads ALL of them back", async () => {
    const filter = crit("a", "must_pass", homepage);
    const bonusA = crit("b", "mention", linkedin);
    const bonusB = crit("c", "mention", homepage);
    await checksForWriter(lead, [filter, bonusA, bonusB], identity);

    expect(runCriterionOnLeads.mock.calls.map((c) => c[0].id).sort()).toEqual(["b", "c"]);
    // The research is its own production order: a `company-research` child run of the serve run.
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", taskName: "company-research", parentRunId: "run-1", userId: "user-1" }));
    for (const call of runCriterionOnLeads.mock.calls) expect(call.slice(1, 3)).toEqual([["lead-1"], { ...identity, runId: "research-1" }]);
    expect(readLeadQualification).toHaveBeenCalledWith(lead, [filter, bonusA, bonusB]);
    expect(updateRun).toHaveBeenCalledWith("research-1", "completed", expect.objectContaining({ orgId: "org-1" }));
  });

  it("declares company_researched on the research run for the company it paid new research on, nothing when all was reused", async () => {
    runCriterionOnLeads.mockImplementation(async (_c: unknown, _l: unknown, _i: unknown, researched: Set<string>) => {
      researched.add("cascobay.com");
    });
    await checksForWriter(lead, [crit("b", "mention", linkedin)], identity);
    expect(declareRunOutcomes).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "research-1",
      produced: [{ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "cascobay.com" }],
      consumed: [],
    });
    declareRunOutcomes.mockClear();
    runCriterionOnLeads.mockResolvedValue([]);
    runCriterionOnLeads.mockImplementation(async () => []);
    await checksForWriter(lead, [crit("b", "mention", linkedin)], identity);
    expect(declareRunOutcomes).not.toHaveBeenCalled();
  });

  it("runs-service unable to open the research run: the checks still run, on the serve run, undeclared", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    createRun.mockRejectedValue(new Error("runs down"));
    await checksForWriter(lead, [crit("b", "mention", linkedin)], identity);
    expect(runCriterionOnLeads.mock.calls[0].slice(1, 3)).toEqual([["lead-1"], identity]);
    expect(declareRunOutcomes).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("runs two Bonus checks on the SAME probe one after the other, so the second reuses the observation", async () => {
    const order: string[] = [];
    runCriterionOnLeads.mockImplementation(async (c: { id: string }) => {
      order.push(`start:${c.id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${c.id}`);
    });
    await checksForWriter(lead, [crit("b", "mention", linkedin), crit("c", "mention", linkedin)], identity);
    expect(order).toEqual(["start:b", "end:b", "start:c", "end:c"]);
  });

  it("spends nothing with no Bonus check, and refuses a Bonus spend with no run to declare it on", async () => {
    await checksForWriter(lead, [crit("a", "must_pass", homepage)], null);
    expect(runCriterionOnLeads).not.toHaveBeenCalled();
    await expect(checksForWriter(lead, [crit("b", "mention", linkedin)], null)).rejects.toThrow(/run id/);
  });
});
