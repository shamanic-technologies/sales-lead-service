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

  it("names the offer the campaign sells with ?offerId= (multi-offer brand)", async () => {
    const { calls } = mockFetch({
      brand: { id: "brand-1" },
      currentGoal: "meetingBooked",
      brandProfile: null,
    });

    const goal = await getCurrentGoal("brand-1", "org-1", { runId: "run-1" }, "offer-7");

    expect(goal).toBe("meetingBooked");
    // brand-service's own per-offer param — the offer, never a guessed one.
    expect(calls[0].url).toBe(
      "http://brand:3005/internal/brands/brand-1/runtime-context?offerId=offer-7",
    );
  });

  it("keeps the brand-scoped read byte-identically when no offer is named", async () => {
    const { calls } = mockFetch({
      brand: { id: "brand-1" },
      currentGoal: "meetingBooked",
      brandProfile: null,
    });

    await getCurrentGoal("brand-1", "org-1", { runId: "run-1" }, null);
    await getCurrentGoal("brand-1", "org-1");

    for (const call of calls) {
      expect(call.url).toBe("http://brand:3005/internal/brands/brand-1/runtime-context");
    }
  });

  it("throws on non-2xx (no goal set → 404 → fail loud)", async () => {
    const fetchSpy = vi.fn(async () => new Response("Brand not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getCurrentGoal("brand-1", "org-1")).rejects.toThrow(
      /runtime-context failed for brand brand-1: 404/,
    );
  });

  // Per-brand configuration belongs to an (org, brand) pair: brand-service
  // refuses to guess for a brand several orgs claim. These guard the org
  // identity actually reaching the wire, so it cannot be dropped silently.
  it("asks for the requesting org's configuration, not a fixed one", async () => {
    const { calls } = mockFetch({
      brand: { id: "brand-shared" },
      currentGoal: "signup",
      brandProfile: null,
    });

    await getCurrentGoal("brand-shared", "org-a");
    await getCurrentGoal("brand-shared", "org-b");

    expect(calls.map((c) => (c.init.headers as Record<string, string>)["x-org-id"])).toEqual([
      "org-a",
      "org-b",
    ]);
  });

  it("fails loud without an org instead of letting brand-service pick one", async () => {
    const { calls } = mockFetch({ currentGoal: "signup" });

    await expect(getCurrentGoal("brand-1", "")).rejects.toThrow(/orgId is required/);
    expect(calls).toHaveLength(0);
  });

  // This is the serve path's own brand read, so a sibling mid-restart resetting the
  // connection must not fail a serve that would otherwise have succeeded.
  it("retries a connect-phase reset", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const ok = new Response(JSON.stringify({ currentGoal: "signup" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchSpy = vi.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce(ok);
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getCurrentGoal("brand-1", "org-1")).resolves.toBe("signup");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // A non-2xx is a real answer brand-service produced — including the 409 a
  // multi-offer brand returns for an unscoped read. Retrying it would turn a
  // loud configuration error into a slow one.
  it("does not retry a 409 SEVERAL_OFFERS — it fails loud, once", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "SEVERAL_OFFERS" }), { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getCurrentGoal("brand-1", "org-1")).rejects.toThrow(/409/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
