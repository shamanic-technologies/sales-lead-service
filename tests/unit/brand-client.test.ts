import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExtractedFields, getCurrentGoal } from "../../src/lib/brand-client.js";

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
    expect(String(calls[0].url)).toBe("http://brand:3005/internal/brands/brand-1/runtime-context");
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

  // Per-brand configuration belongs to an (org, brand) pair: brand-service
  // refuses to guess for a brand several orgs claim. These guard the org
  // identity actually reaching the wire, so it cannot be dropped silently.
  it("sends x-org-id on every internal per-brand configuration read", async () => {
    const { calls } = mockFetch({ brandId: "brand-1", fields: [] });

    await fetchExtractedFields("brand-1", "org-2", { runId: "run-1" });

    expect(calls[0].url).toBe("http://brand:3005/internal/brands/brand-1/extracted-fields");
    expect((calls[0].init.headers as Record<string, string>)["x-org-id"]).toBe("org-2");
  });

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
    await expect(fetchExtractedFields("brand-1", "")).rejects.toThrow(/orgId is required/);
    expect(calls).toHaveLength(0);
  });
});

describe("getCurrentGoal — a brand selling SEVERAL offers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the CAMPAIGN's offer and retries, instead of failing the run", async () => {
    process.env.CAMPAIGN_SERVICE_URL = "http://campaign:8080";
    process.env.CAMPAIGN_SERVICE_API_KEY = "svc-key";
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchSpy = vi.fn(async (url: URL | string, init: RequestInit) => {
      const u = new URL(String(url));
      calls.push({ url: u, init });
      if (u.pathname.endsWith("/runtime-context") && !u.searchParams.has("offerId")) {
        return new Response(
          JSON.stringify({
            error: "Brand brand-1 sells 2 offers (Product-led, Sales-led)",
            code: "SEVERAL_OFFERS",
          }),
          { status: 409 },
        );
      }
      if (u.pathname.endsWith("/campaigns/camp-1")) {
        return new Response(JSON.stringify({ campaign: { id: "camp-1", offerId: "offer-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ currentGoal: "signup" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const goal = await getCurrentGoal("brand-1", "org-1", { campaignId: "camp-1" });

    expect(goal).toBe("signup");
    const retry = calls.find((c) => c.url.searchParams.has("offerId"));
    expect(retry?.url.searchParams.get("offerId")).toBe("offer-1");
  });

  it("fails loud when the campaign states NO offer — never a guessed one", async () => {
    process.env.CAMPAIGN_SERVICE_URL = "http://campaign:8080";
    process.env.CAMPAIGN_SERVICE_API_KEY = "svc-key";
    const fetchSpy = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/campaigns/camp-1")) {
        return new Response(JSON.stringify({ campaign: { id: "camp-1", offerId: null } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "SEVERAL_OFFERS" }), { status: 409 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await expect(getCurrentGoal("brand-1", "org-1", { campaignId: "camp-1" })).rejects.toThrow(
      /states none/,
    );
  });
});
