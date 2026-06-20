import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTopAudienceId } from "../../src/lib/features-client.js";

type CapturedRequest = { url: string; init: RequestInit };

function mockFetch(responseBody: unknown): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls };
}

const ctx = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1" };

describe("features-client getTopAudienceId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs persona-stats(limit=1) and returns the top row's audienceId as the audience id", async () => {
    const { calls } = mockFetch({
      personas: [
        { audienceId: "aud-top", sortMetric: 0.9 },
        { audienceId: "aud-second", sortMetric: 0.4 },
      ],
    });

    const audienceId = await getTopAudienceId({
      featureSlug: "lead-finder-v1",
      brandId: "brand-1",
      goal: "signup",
      ctx,
    });

    expect(audienceId).toBe("aud-top");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/features/lead-finder-v1/persona-stats");
    expect(url.searchParams.get("brandId")).toBe("brand-1");
    expect(url.searchParams.get("goal")).toBe("signup");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("limit")).toBe("1");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["X-API-Key"]).toBeDefined();
  });

  it("returns null when the brand/goal has no audience (empty personas)", async () => {
    mockFetch({ personas: [] });
    const audienceId = await getTopAudienceId({
      featureSlug: "lead-finder-v1",
      brandId: "brand-1",
      goal: "signup",
      ctx,
    });
    expect(audienceId).toBeNull();
  });

  it("throws on non-2xx (fail loud, no silent fallback)", async () => {
    const fetchSpy = vi.fn(async () => new Response("features down", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      getTopAudienceId({ featureSlug: "lead-finder-v1", brandId: "brand-1", goal: "signup", ctx }),
    ).rejects.toThrow(/features persona-stats failed: 503/);
  });
});
