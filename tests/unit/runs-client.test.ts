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

  it("LATE-UNIT-LINK-1117: a Unit stands when the ledger holds a produced occurrence of the key on the subject, not reversed", async () => {
    const { hasStandingProducedUnit } = await import("../../src/lib/runs-client.js");
    const occ = (over: Record<string, unknown>) => ({ direction: "produced", outcomeKey: "conversation", subjectService: "lead-service", subjectId: "L1", reversal: null, ...over });
    const answer = (occurrences: unknown[], nextCursor: string | null = null) => ({ ok: true, json: () => Promise.resolve({ occurrences, nextCursor }) });

    fetchSpy.mockResolvedValueOnce(answer([occ({ reversal: { reversedAt: "2026-11-05T00:00:00.000Z" } }), occ({ subjectId: "other" }), occ({ outcomeKey: "message_sent" })]));
    expect(await hasStandingProducedUnit("lead-service", ["L1", "L2"], "conversation", "2026-08-11T00:00:00.000Z")).toBe(false);
    const asked = new URL(fetchSpy.mock.calls[0][0]).searchParams;
    expect(Object.fromEntries(asked)).toEqual({ subjectService: "lead-service", subjectIds: "L1,L2", direction: "produced", outcomeKey: "conversation", limit: "1000", declaredBefore: "2026-08-11T00:00:00.000Z" });

    // A second page is read before answering "none"; a twin subject's Unit counts.
    fetchSpy.mockResolvedValueOnce(answer([occ({ reversal: { reversedAt: "x" } })], "c1")).mockResolvedValueOnce(answer([occ({ subjectId: "L2" })]));
    expect(await hasStandingProducedUnit("lead-service", ["L1", "L2"], "conversation", null)).toBe(true);
    expect(new URL(fetchSpy.mock.calls[2][0]).searchParams.get("cursor")).toBe("c1");
    expect(new URL(fetchSpy.mock.calls[1][0]).searchParams.has("declaredBefore")).toBe(false);

    // An unreadable ledger is never "none".
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("down") });
    await expect(hasStandingProducedUnit("lead-service", ["L1"], "conversation", null)).rejects.toThrow(/503/);
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    await expect(hasStandingProducedUnit("lead-service", ["L1"], "conversation", null)).rejects.toThrow(/no occurrences array/);
  });

  it("createRun attaches a 5s AbortSignal — DAG retry must not wait minutes on a hung runs-service", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "run-1" }) });
    const { createRun } = await import("../../src/lib/runs-client.js");

    await createRun({ orgId: "o", serviceName: "lead-service", taskName: "lead-serve" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("createRun forwards x-audience-id header so runs-service tags the run + cost rows per audience", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "run-1" }) });
    const { createRun } = await import("../../src/lib/runs-client.js");

    await createRun({
      orgId: "org-1",
      serviceName: "lead-service",
      taskName: "lead-serve",
      audienceId: "aud-123",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    // Regression guard: audience attribution rides the header (runs-service:
    // "header takes precedence, inherited from parent run"). Dropping it sends
    // ~97% of campaign spend to the unattributed bucket.
    expect(opts.headers["x-audience-id"]).toBe("aud-123");
  });

  it("updateRun forwards x-audience-id header", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const { updateRun } = await import("../../src/lib/runs-client.js");

    await updateRun("run-1", "completed", { orgId: "org-1", audienceId: "aud-123" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-audience-id"]).toBe("aud-123");
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
