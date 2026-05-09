import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config before importing the module under test
vi.mock("../../src/config.js", () => ({
  RUNS_SERVICE_URL: "https://runs.test",
  RUNS_SERVICE_API_KEY: "test-api-key",
  LEAD_SERVICE_API_KEY: "test-key",
  PORT: "3006",
  APOLLO_SERVICE_URL: "http://apollo",
  APOLLO_SERVICE_API_KEY: "key",
  BRAND_SERVICE_URL: "http://brand",
  BRAND_SERVICE_API_KEY: "key",
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "key",
  EMAIL_GATEWAY_SERVICE_URL: "http://email-gw",
  EMAIL_GATEWAY_SERVICE_API_KEY: "key",
  KEY_SERVICE_URL: "http://key",
  KEY_SERVICE_API_KEY: "key",
  FEATURES_SERVICE_URL: "http://features",
  FEATURES_SERVICE_API_KEY: "key",
  WORKFLOW_SERVICE_URL: "http://workflow",
  WORKFLOW_SERVICE_API_KEY: "key",
}));

describe("traceEvent", () => {
  const fetchSpy = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts correct payload to runs-service", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent("run-123", {
      service: "lead-service",
      event: "buffer-next-start",
      detail: "Starting buffer pull",
      level: "info",
      data: { campaignId: "c-1" },
    }, { "x-org-id": "org-1" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://runs.test/v1/runs/run-123/events");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      service: "lead-service",
      event: "buffer-next-start",
      detail: "Starting buffer pull",
      level: "info",
      data: { campaignId: "c-1" },
    });
  });

  it("attaches a 5s AbortSignal so a hung runs-service does not hang the caller", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent("run-123", { service: "lead-service", event: "test" }, { "x-org-id": "o" });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards all identity headers", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent("run-123", {
      service: "lead-service",
      event: "test",
    }, {
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-brand-id": "brand-1,brand-2",
      "x-campaign-id": "camp-1",
      "x-workflow-slug": "wf-slug",
      "x-feature-slug": "feat-slug",
    });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-user-id"]).toBe("user-1");
    expect(opts.headers["x-brand-id"]).toBe("brand-1,brand-2");
    expect(opts.headers["x-campaign-id"]).toBe("camp-1");
    expect(opts.headers["x-workflow-slug"]).toBe("wf-slug");
    expect(opts.headers["x-feature-slug"]).toBe("feat-slug");
  });

  it("skips missing optional headers", async () => {
    const { traceEvent } = await import("../../src/lib/trace-event.js");

    await traceEvent("run-123", {
      service: "lead-service",
      event: "test",
    }, { "x-org-id": "org-1" });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers).not.toHaveProperty("x-user-id");
    expect(opts.headers).not.toHaveProperty("x-brand-id");
    expect(opts.headers).not.toHaveProperty("x-campaign-id");
    expect(opts.headers).not.toHaveProperty("x-workflow-slug");
    expect(opts.headers).not.toHaveProperty("x-feature-slug");
  });

  it("swallows fetch errors and never throws", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { traceEvent } = await import("../../src/lib/trace-event.js");

    // Should NOT throw
    await expect(
      traceEvent("run-123", { service: "lead-service", event: "test" }, {})
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[lead-service] Failed to trace event:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("skips if RUNS_SERVICE_URL is missing", async () => {
    // Re-mock config with missing URL and re-import trace-event
    vi.resetModules();
    vi.doMock("../../src/config.js", () => ({
      RUNS_SERVICE_URL: "",
      RUNS_SERVICE_API_KEY: "test-api-key",
      LEAD_SERVICE_API_KEY: "test-key",
      PORT: "3006",
      APOLLO_SERVICE_URL: "http://apollo",
      APOLLO_SERVICE_API_KEY: "key",
      BRAND_SERVICE_URL: "http://brand",
      BRAND_SERVICE_API_KEY: "key",
      CAMPAIGN_SERVICE_URL: "http://campaign",
      CAMPAIGN_SERVICE_API_KEY: "key",
      EMAIL_GATEWAY_SERVICE_URL: "http://email-gw",
      EMAIL_GATEWAY_SERVICE_API_KEY: "key",
      KEY_SERVICE_URL: "http://key",
      KEY_SERVICE_API_KEY: "key",
      FEATURES_SERVICE_URL: "http://features",
      FEATURES_SERVICE_API_KEY: "key",
      WORKFLOW_SERVICE_URL: "http://workflow",
      WORKFLOW_SERVICE_API_KEY: "key",
    }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("../../src/lib/trace-event.js");

    await mod.traceEvent("run-123", { service: "lead-service", event: "test" }, {});

    expect(fetchSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
