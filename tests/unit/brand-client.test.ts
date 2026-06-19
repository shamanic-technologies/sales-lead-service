import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentGoal } from "../../src/lib/brand-client.js";

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

describe("brand-client getCurrentGoal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs runtime-context and returns the brand's currentGoal", async () => {
    const { calls } = mockFetch({
      brand: { id: "brand-1" },
      currentGoal: "meetingBooked",
      brandProfile: null,
    });

    const goal = await getCurrentGoal("brand-1", "org-1", { runId: "run-1" });

    expect(goal).toBe("meetingBooked");
    expect(calls[0].url).toBe("http://brand:3005/internal/brands/brand-1/runtime-context");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["X-API-Key"]).toBeDefined();
  });

  it("throws on non-2xx (no goal set → 404 → fail loud)", async () => {
    const fetchSpy = vi.fn(async () => new Response("Brand not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getCurrentGoal("brand-1", "org-1")).rejects.toThrow(
      /runtime-context failed for brand brand-1: 404/,
    );
  });
});
