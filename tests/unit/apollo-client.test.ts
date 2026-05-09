import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchApolloStats,
  apolloEnrich,
  fetchApolloFiltersPrompt,
} from "../../src/lib/apollo-client.js";

type CapturedRequest = { url: string; init: RequestInit };

function mockFetch(responseBody: unknown): { fetchSpy: ReturnType<typeof vi.fn>; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { fetchSpy, calls };
}

function parseBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("apollo-client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchApolloStats", () => {
    const stats = {
      enrichedLeadsCount: 1,
      searchCount: 2,
      fetchedPeopleCount: 3,
      totalMatchingPeople: 4,
    };

    it("posts brandIds as an array (single brand)", async () => {
      const { calls } = mockFetch({ stats });
      await fetchApolloStats({ brandIds: ["b1"], runIds: ["r1"], campaignId: "c1" }, "org-1");

      expect(calls).toHaveLength(1);
      const body = parseBody(calls[0].init);
      expect(body).toEqual({ brandIds: ["b1"], runIds: ["r1"], campaignId: "c1" });
      expect(body).not.toHaveProperty("brandId");
      expect(calls[0].url).toBe("http://apollo:3003/stats");
    });

    it("posts brandIds verbatim for multi-brand filter", async () => {
      const { calls } = mockFetch({ stats });
      await fetchApolloStats({ brandIds: ["b1", "b2", "b3"] }, "org-1");

      const body = parseBody(calls[0].init);
      expect(body.brandIds).toEqual(["b1", "b2", "b3"]);
      expect(body).not.toHaveProperty("brandId");
    });

    it("omits brand fields when no brandIds provided", async () => {
      const { calls } = mockFetch({ stats });
      await fetchApolloStats({ campaignId: "c1" }, "org-1");

      const body = parseBody(calls[0].init);
      expect(body).not.toHaveProperty("brandIds");
      expect(body).not.toHaveProperty("brandId");
      expect(body).toEqual({ campaignId: "c1" });
    });
  });

  describe("apolloEnrich", () => {
    const person = { id: "p1", email: "a@b.com" };

    it("propagates cached:true from response", async () => {
      mockFetch({ person, cached: true });
      const result = await apolloEnrich("p1");

      expect(result).toEqual({ person, cached: true });
    });

    it("propagates cached:false from response", async () => {
      mockFetch({ person, cached: false });
      const result = await apolloEnrich("p1");

      expect(result).toEqual({ person, cached: false });
    });
  });

  describe("fetchApolloFiltersPrompt", () => {
    it("GETs /search/filters-prompt with x-org-id and x-user-id headers", async () => {
      const { calls } = mockFetch({ prompt: "DOC", schemaVersion: "v1" });

      const out = await fetchApolloFiltersPrompt({ orgId: "org-9", userId: "user-9" });

      expect(out).toEqual({ prompt: "DOC", schemaVersion: "v1" });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://apollo:3003/search/filters-prompt");
      expect(calls[0].init.method ?? "GET").toBe("GET");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org-9");
      expect(headers["x-user-id"]).toBe("user-9");
      expect(headers["X-API-Key"]).toBeDefined();
    });

    it("omits x-user-id when userId is null", async () => {
      const { calls } = mockFetch({ prompt: "DOC", schemaVersion: "v1" });

      await fetchApolloFiltersPrompt({ orgId: "org-9", userId: null });

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org-9");
      expect(headers["x-user-id"]).toBeUndefined();
    });

    it("throws on non-2xx response (no silent fallback)", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response("apollo down", { status: 503 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        fetchApolloFiltersPrompt({ orgId: "org-1", userId: null }),
      ).rejects.toThrow(/Apollo service call failed: 503/);
    });
  });
});
