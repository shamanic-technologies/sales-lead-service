import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  RUNS_SERVICE_URL: "https://runs.test",
  RUNS_SERVICE_API_KEY: "test-runs-key",
}));

describe("runs-client", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createRun attaches a 5s AbortSignal — DAG retry must not wait minutes on a hung runs-service", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "run-1" }) });
    const { createRun } = await import("../../src/lib/runs-client.js");

    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "lead-serve" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("updateRun attaches a 5s AbortSignal", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const { updateRun } = await import("../../src/lib/runs-client.js");

    await updateRun("run-1", "completed");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});
