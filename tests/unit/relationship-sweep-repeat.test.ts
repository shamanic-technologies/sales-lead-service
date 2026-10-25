/**
 * LEDGER-RESIDUAL-1025 (owner 2026-10-25): the relationship sweep re-asking Jev about a relation crm-service already
 * identified is WASTE: those judgments ride a run created with runs-service's `repeat_production` mark; a relation
 * nobody identified yet is production and rides a plain run. Never one run for both.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, unknown>> = [];
const judged: Array<{ who: string; runId: string; kind: string }> = [];
let identified = new Set<string>();

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: async (p: Record<string, unknown>) => {
    created.push(p);
    return { id: `run-${created.length}` };
  },
  updateRun: async () => undefined,
}));
const subject = (who: string, keys: string[]) => ({ orgId: "o", brandId: "b", humanId: who, companyKey: "", relationKeys: keys });
let tagTodo: ReturnType<typeof subject>[] = [];
let intentTodo: ReturnType<typeof subject>[] = [];
vi.mock("../../src/lib/relationship-judge.js", () => ({
  brandCardOf: async () => ({ hash: "h" }),
  subjectsToJudge: async () => tagTodo,
  judgeSubject: async (s: { humanId: string }, runId: string) => judged.push({ who: s.humanId, runId, kind: "tags" }),
  writeEvidence: async () => 0,
}));
vi.mock("../../src/lib/relationship-intent-judge.js", () => ({
  intentSubjectsToJudge: async () => intentTodo,
  judgeIntent: async (s: { humanId: string }, runId: string) => judged.push({ who: s.humanId, runId, kind: "intent" }),
}));
vi.mock("../../src/lib/relationship-subjects.js", () => ({ listScopes: async () => [], refreshSubjects: async () => ({ subjects: 0, withoutHuman: 0 }) }));
vi.mock("../../src/lib/relationship-read.js", () => ({ recomputePolicy: async () => 0 }));
vi.mock("../../src/lib/unibox-model.js", () => ({ refreshUniboxRows: async () => null }));
vi.mock("../../src/lib/hot-lead-triggers.js", () => ({ detectHotLeads: async () => null }));
vi.mock("../../src/lib/crm-lead-identified.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/crm-lead-identified.js")>()),
  crmIdentifiedAmong: async () => identified,
}));
vi.mock("../../src/db/index.js", () => ({ db: { execute: async () => [] } }));

const { sweepScope } = await import("../../src/lib/relationship-sweep.js");

describe("relationship sweep runs (LEDGER-RESIDUAL-1025)", () => {
  beforeEach(() => {
    created.length = 0;
    judged.length = 0;
    tagTodo = [];
    intentTodo = [];
  });

  it("judgments of crm-identified relations ride a repeat_production run, the others a production run", async () => {
    identified = new Set(["rel:known"]);
    tagTodo = [subject("A", ["rel:known"]), subject("B", ["rel:new"])];
    intentTodo = [subject("C", ["rel:other", "rel:known"])];
    await sweepScope({ orgId: "o", brandId: "b" });
    expect(created).toHaveLength(2);
    const repeatRun = created.findIndex((c) => c.repeatProduction === true);
    const productionRun = created.findIndex((c) => c.repeatProduction === false);
    expect(repeatRun).toBeGreaterThanOrEqual(0);
    expect(productionRun).toBeGreaterThanOrEqual(0);
    for (const c of created) expect(c.taskName).toBe("relationship-sweep");
    const runOf = (who: string) => judged.find((j) => j.who === who)!.runId;
    expect(runOf("A")).toBe(`run-${repeatRun + 1}`);
    expect(runOf("C")).toBe(`run-${repeatRun + 1}`);
    expect(runOf("B")).toBe(`run-${productionRun + 1}`);
  });

  it("nobody identified: one production run, no repeat mark", async () => {
    identified = new Set();
    tagTodo = [subject("A", ["rel:a"])];
    await sweepScope({ orgId: "o", brandId: "b" });
    expect(created).toEqual([expect.objectContaining({ taskName: "relationship-sweep", repeatProduction: false })]);
  });

  it("nothing to judge: no run opened", async () => {
    await sweepScope({ orgId: "o", brandId: "b" });
    expect(created).toEqual([]);
  });
});
