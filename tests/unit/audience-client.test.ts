import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  HUMAN_SERVICE_URL: "http://human.test",
  HUMAN_SERVICE_API_KEY: "human-key",
}));

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

const ctx = { orgId: "org-1", userId: "user-1", runId: "run-1" };

let resolveAudiencesForBrand: typeof import("../../src/lib/audience-client.js").resolveAudiencesForBrand;
let AudienceServiceError: typeof import("../../src/lib/audience-client.js").AudienceServiceError;

beforeAll(async () => {
  const mod = await import("../../src/lib/audience-client.js");
  resolveAudiencesForBrand = mod.resolveAudiencesForBrand;
  AudienceServiceError = mod.AudienceServiceError;
});

describe("audience-client resolveAudiencesForBrand", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("short-circuits (no call) when there are no keys", async () => {
    const { calls } = mockFetch({ byAudienceId: {}, byEmail: {} });
    const res = await resolveAudiencesForBrand("brand-1", { audienceIds: [], emails: [] }, ctx);
    expect(res).toEqual({ byAudienceId: {}, byEmail: {} });
    expect(calls).toHaveLength(0);
  });

  it("posts orgId + brandId + key arrays to /internal/audiences/resolve with internal auth", async () => {
    const { calls } = mockFetch({
      byAudienceId: { "aud-t": { id: "aud-t", name: "Tagged", avatarUrl: null } },
      byEmail: { "a@b.com": { id: "aud-e", name: "ByEmail", avatarUrl: "u" } },
    });

    const res = await resolveAudiencesForBrand(
      "brand-1",
      { audienceIds: ["aud-t"], emails: ["a@b.com"] },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://human.test/internal/audiences/resolve");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("human-key");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      orgId: "org-1",
      brandId: "brand-1",
      audienceIds: ["aud-t"],
      emails: ["a@b.com"],
    });
    expect(res.byAudienceId["aud-t"]).toEqual({ id: "aud-t", name: "Tagged", avatarUrl: null });
    expect(res.byEmail["a@b.com"]).toEqual({ id: "aud-e", name: "ByEmail", avatarUrl: "u" });
  });

  it("defaults missing maps to empty objects", async () => {
    mockFetch({ byEmail: { "a@b.com": null } });
    const res = await resolveAudiencesForBrand("brand-1", { audienceIds: [], emails: ["a@b.com"] }, ctx);
    expect(res.byAudienceId).toEqual({});
    expect(res.byEmail["a@b.com"]).toBeNull();
  });

  it("throws AudienceServiceError on a non-2xx response (fail loud)", async () => {
    const fetchSpy = vi.fn(async () => new Response("boom", { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveAudiencesForBrand("brand-1", { audienceIds: [], emails: ["a@b.com"] }, ctx),
    ).rejects.toBeInstanceOf(AudienceServiceError);
  });
});

describe("audience-client resolveBrandMembershipsByEmail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks nothing when there is no email", async () => {
    const { calls } = mockFetch({ brandId: "brand-1", byEmail: {} });
    const { resolveBrandMembershipsByEmail } = await import("../../src/lib/audience-client.js");
    expect((await resolveBrandMembershipsByEmail("brand-1", [], ctx)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("posts orgId + emails to the brand's memberships/by-email read and keys every membership by email", async () => {
    const { calls } = mockFetch({
      brandId: "brand-1",
      byEmail: {
        "a@x.com": {
          personId: "p1",
          memberships: [
            { audienceId: "aud-1", offerId: null, list: "apollo_search", status: "active", provenance: "served", joinedAt: "2026-10-01T00:00:00Z" },
            { audienceId: "aud-2", offerId: "o", list: "linkedin_engagement", status: "active", provenance: "found_taken", joinedAt: "2026-10-02T00:00:00Z" },
          ],
        },
        "b@x.com": null,
      },
    });
    const { resolveBrandMembershipsByEmail } = await import("../../src/lib/audience-client.js");
    const out = await resolveBrandMembershipsByEmail("brand-1", ["a@x.com", "b@x.com"], ctx);
    expect(calls[0].url).toBe("http://human.test/internal/brands/brand-1/memberships/by-email");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ orgId: "org-1", emails: ["a@x.com", "b@x.com"] });
    expect((calls[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("human-key");
    expect(out.get("a@x.com")).toEqual([
      { audienceId: "aud-1", offerId: null, list: "apollo_search", provenance: "served" },
      { audienceId: "aud-2", offerId: "o", list: "linkedin_engagement", provenance: "found_taken" },
    ]);
    expect(out.get("b@x.com")).toEqual([]);
  });

  it("throws on a non-2xx and on a membership without provenance", async () => {
    const { resolveBrandMembershipsByEmail, AudienceServiceError: Err } = await import("../../src/lib/audience-client.js");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    await expect(resolveBrandMembershipsByEmail("brand-1", ["a@x.com"], ctx)).rejects.toBeInstanceOf(Err);
    mockFetch({ brandId: "brand-1", byEmail: { "a@x.com": { personId: "p", memberships: [{ audienceId: "aud-1" }] } } });
    await expect(resolveBrandMembershipsByEmail("brand-1", ["a@x.com"], ctx)).rejects.toBeInstanceOf(Err);
  });
});
