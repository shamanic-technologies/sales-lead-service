/**
 * COST-SUPPORT-1024-LEAD: every run lead-service opens is classified (src/lib/run-tasks.ts). A task named in src that
 * the registry does not know would open an unclassified run, so this scans every literal task name the code passes to
 * createRun / createPlatformRun / openRun and requires a registry entry; a support task is created WITH its support.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../src/config.js", () => ({
  RUNS_SERVICE_URL: "https://runs.test",
  RUNS_SERVICE_API_KEY: "test-runs-key",
}));

const { RUN_TASKS, runSupportFor, SUPPORT_FUNCTIONS } = await import("../../src/lib/run-tasks.js");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Every literal task name the code opens a run with. */
function taskNamesInSrc(): Set<string> {
  const names = new Set<string>();
  const constants = new Map<string, string>();
  const files = sources(join(__dirname, "../../src"));
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/export const ([A-Z_]+_TASK) = "([^"]+)"/g)) constants.set(m[1], m[2]);
  }
  for (const f of files) {
    if (f.endsWith("run-tasks.ts")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/createRun\(\{[^}]*?taskName: (?:"([^"]+)"|([A-Z_]+_TASK))/gs)) names.add(m[1] ?? constants.get(m[2]) ?? `UNRESOLVED:${m[2]}`);
    for (const m of text.matchAll(/^\s*taskName: "([^"]+)",/gm)) names.add(m[1]);
    for (const m of text.matchAll(/createPlatformRun\("([^"]+)"/g)) names.add(m[1]);
    for (const m of text.matchAll(/openRun\([^)]*?"([a-z][a-z-]+)"\)/g)) names.add(m[1]);
  }
  return names;
}

describe("run-tasks registry", () => {
  it("names every task the code opens a run with", () => {
    const found = taskNamesInSrc();
    // The scan must see the known ones, or it scans nothing.
    for (const known of ["lead-serve", "company-research", "qualification-preview", "qualification-suggestions", "outcome-recording", "relationship-sweep", "followup-claim-relationship-judgment"]) {
      expect(found).toContain(known);
    }
    const missing = [...found].filter((t) => !(t in RUN_TASKS));
    expect(missing).toEqual([]);
  });

  it("states a known support function and a reason on every support task", () => {
    for (const [task, entry] of Object.entries(RUN_TASKS)) {
      if (!("support" in entry)) continue;
      expect(SUPPORT_FUNCTIONS, task).toContain(entry.support.kind);
      expect(entry.support.reason.length, task).toBeGreaterThan(10);
    }
  });

  it("refuses an unclassified task unless the caller states its support, and never lets a caller restate a classified one", () => {
    expect(() => runSupportFor("image-judge-bench-x")).toThrow(/not classified/);
    expect(runSupportFor("image-judge-bench-x", { kind: "staff_experiment", reason: "bench" })).toEqual({ kind: "staff_experiment", reason: "bench" });
    expect(runSupportFor("lead-serve")).toBeUndefined();
    expect(runSupportFor("qualification-suggestions")?.kind).toBe("product_feature");
    expect(() => runSupportFor("lead-serve", { kind: "staff_experiment", reason: "x" })).toThrow(/registry/);
  });

  it("a repeat run of the relationship sweep carries runs-service's repeat_production mark; no other task has one (LEDGER-RESIDUAL-1025)", () => {
    expect(runSupportFor("relationship-sweep")).toBeUndefined();
    expect(runSupportFor("relationship-sweep", undefined, { repeatProduction: true })?.kind).toBe("repeat_production");
    expect(() => runSupportFor("lead-serve", undefined, { repeatProduction: true })).toThrow(/no repeat_production/);
    expect(() => runSupportFor("relationship-sweep", { kind: "platform_llm", reason: "x" }, { repeatProduction: true })).toThrow(/never a caller/);
  });
});

describe("runs-client marks support at creation", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyOf = (i = 0) => JSON.parse(fetchSpy.mock.calls[i][1].body as string);

  it("sends the registry's support on a support task, nothing on a declaring one", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "run-1" }) });
    const { createRun } = await import("../../src/lib/runs-client.js");
    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "qualification-suggestions" });
    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "lead-serve" });
    expect(bodyOf(0).support).toEqual(RUN_TASKS["qualification-suggestions"].support);
    expect(bodyOf(1)).not.toHaveProperty("support");
  });

  it("sends a staff script's stated support, and refuses to open an unclassified run", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "run-1" }) });
    const { createRun, createPlatformRun } = await import("../../src/lib/runs-client.js");
    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "image-judge-bench-y", support: { kind: "staff_experiment", reason: "judge benchmark" } });
    expect(bodyOf(0).support).toEqual({ kind: "staff_experiment", reason: "judge benchmark" });
    await expect(createRun({ orgId: "o", serviceName: "lead-service", taskName: "image-judge-bench-z" })).rejects.toThrow(/not classified/);
    await createPlatformRun("followup-claim-relationship-judgment");
    expect(bodyOf(1).support.kind).toBe("platform_llm");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("opens a relationship-sweep repeat run WITH the repeat_production mark, a production one without", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "run-1" }) });
    const { createRun } = await import("../../src/lib/runs-client.js");
    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "relationship-sweep", repeatProduction: true });
    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "relationship-sweep", repeatProduction: false });
    expect(bodyOf(0).support).toEqual({ kind: "repeat_production", reason: RUN_TASKS["relationship-sweep"].repeat.reason });
    expect(bodyOf(1)).not.toHaveProperty("support");
  });
});
