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

  describe("listRuns", () => {
    it("builds correct URL with query params and forwards required headers", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ runs: [] }) });
      const { listRuns } = await import("../../src/lib/runs-client.js");

      await listRuns({
        orgId: "org-1",
        campaignId: "camp-1",
        serviceName: "lead-service",
        status: "running",
        limit: 2,
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        "https://runs.test/v1/runs?campaignId=camp-1&serviceName=lead-service&status=running&limit=2",
      );
      expect(opts.method).toBe("GET");
      expect(opts.headers["x-org-id"]).toBe("org-1");
      expect(opts.headers["X-API-Key"]).toBe("test-runs-key");
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns parsed runs array on success", async () => {
      const runs = [
        { id: "r1", parentRunId: "p1", campaignId: "camp-1", startedAt: "2026-05-10T00:00:00Z" },
      ];
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ runs }) });
      const { listRuns } = await import("../../src/lib/runs-client.js");

      const result = await listRuns({
        orgId: "org-1",
        campaignId: "camp-1",
        serviceName: "lead-service",
        status: "running",
        limit: 2,
      });

      expect(result).toEqual(runs);
    });

    it("throws on non-OK response (no silent fallback)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("boom"),
      });
      const { listRuns } = await import("../../src/lib/runs-client.js");

      await expect(
        listRuns({
          orgId: "org-1",
          campaignId: "camp-1",
          serviceName: "lead-service",
          status: "running",
          limit: 2,
        }),
      ).rejects.toThrow(/500/);
    });
  });
});
