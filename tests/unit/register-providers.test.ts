import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Env vars are set by tests/setup.ts before module imports

import { queryProviderRequirements, registerProviderRequirement } from "../../src/lib/key-service-client.js";
import { registerProviders } from "../../src/lib/register-providers.js";

describe("key-service-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("queryProviderRequirements", () => {
    it("sends endpoints and returns requirements", async () => {
      const response = {
        requirements: [
          { service: "apollo", method: "POST", path: "/search/next", provider: "apollo" },
        ],
        providers: ["apollo"],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(response),
      });

      const result = await queryProviderRequirements([
        { service: "apollo", method: "POST", path: "/search/next" },
      ]);

      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/provider-requirements");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({
        endpoints: [{ service: "apollo", method: "POST", path: "/search/next" }],
      });
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal error"),
      });

      await expect(
        queryProviderRequirements([{ service: "apollo", method: "POST", path: "/search" }])
      ).rejects.toThrow("Key service provider-requirements failed: 500");
    });
  });

  describe("registerProviderRequirement", () => {
    it("calls decrypt endpoint with x-caller headers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ provider: "apollo", key: "ak_123" }),
      });

      await registerProviderRequirement("apollo", "lead", "POST", "/orgs/buffer/next");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/keys/platform/apollo/decrypt");
      expect(opts.method).toBe("GET");
      expect(opts.headers["x-caller-service"]).toBe("lead");
      expect(opts.headers["x-caller-method"]).toBe("POST");
      expect(opts.headers["x-caller-path"]).toBe("/orgs/buffer/next");
    });

    it("tolerates 404 (key not configured)", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not found"),
      });

      await expect(
        registerProviderRequirement("apollo", "lead", "POST", "/orgs/buffer/next")
      ).resolves.toBeUndefined();
    });

    it("throws on non-404 errors", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });

      await expect(
        registerProviderRequirement("apollo", "lead", "POST", "/orgs/buffer/next")
      ).rejects.toThrow("Key service registration failed: 500");
    });
  });
});

describe("registerProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries apollo endpoints and registers lead endpoints with discovered providers", async () => {
    // First call: queryProviderRequirements
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "apollo", method: "POST", path: "/search/next", provider: "apollo" },
            { service: "apollo", method: "POST", path: "/search/dry-run", provider: "apollo" },
            { service: "apollo", method: "POST", path: "/enrich", provider: "apollo" },
            { service: "chat", method: "POST", path: "/complete", provider: "google" },
          ],
          providers: ["apollo", "google"],
        }),
    });

    // Subsequent calls: registerProviderRequirement (decrypt calls)
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ provider: "apollo", key: "ak_123" }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await registerProviders();

    // 1 query + 2 registrations: lead POST /orgs/buffer/next → apollo, google
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const queryBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(queryBody.endpoints).toHaveLength(5);
    expect(queryBody.endpoints).toContainEqual({ service: "apollo", method: "POST", path: "/search/next" });
    expect(queryBody.endpoints).toContainEqual({ service: "apollo", method: "POST", path: "/search/dry-run" });
    expect(queryBody.endpoints).toContainEqual({ service: "apollo", method: "POST", path: "/enrich" });
    expect(queryBody.endpoints).toContainEqual({ service: "chat", method: "POST", path: "/complete" });
    expect(queryBody.endpoints).toContainEqual({ service: "apollo", method: "POST", path: "/stats" });

    const registrationCalls = mockFetch.mock.calls.slice(1);
    const registeredPairs = registrationCalls.map(([url, opts]: [string, RequestInit & { headers: Record<string, string> }]) => ({
      provider: url.match(/\/keys\/platform\/(.+)\/decrypt/)?.[1],
      method: opts.headers["x-caller-method"],
      path: opts.headers["x-caller-path"],
      service: opts.headers["x-caller-service"],
    }));

    expect(registeredPairs).toContainEqual({ provider: "apollo", method: "POST", path: "/orgs/buffer/next", service: "lead" });
    expect(registeredPairs).toContainEqual({ provider: "google", method: "POST", path: "/orgs/buffer/next", service: "lead" });

    logSpy.mockRestore();
  });

  it("handles no requirements gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ requirements: [], providers: [] }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await registerProviders();

    // Only the query call, no registration calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[register-providers] No downstream provider requirements found");

    logSpy.mockRestore();
  });

  it("continues when individual registrations fail", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          requirements: [
            { service: "apollo", method: "POST", path: "/search/next", provider: "apollo" },
            { service: "chat", method: "POST", path: "/complete", provider: "google" },
          ],
          providers: ["apollo", "google"],
        }),
    });

    // First registration succeeds, second fails
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ provider: "apollo", key: "ak_123" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await registerProviders();

    // 1 query + 2 registration attempts
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to register lead POST /orgs/buffer/next"),
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });
});
