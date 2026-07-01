import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Read at module load by the client — set BEFORE importing it.
process.env.AUDIENCE_RESOLVE_BATCH_SIZE = "2";

vi.mock("../../src/config.js", () => ({
  HUMAN_SERVICE_URL: "http://human.test",
  HUMAN_SERVICE_API_KEY: "human-key",
}));

type CapturedRequest = { url: string; init: RequestInit };

function mockFetch(responseBodies: unknown[]): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let i = 0;
  const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = responseBodies[Math.min(i, responseBodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls };
}

const ctx = { orgId: "org-1", userId: "user-1", runId: "run-1" };

let resolveAudiences: typeof import("../../src/lib/audience-client.js").resolveAudiences;
let AudienceServiceError: typeof import("../../src/lib/audience-client.js").AudienceServiceError;

beforeAll(async () => {
  const mod = await import("../../src/lib/audience-client.js");
  resolveAudiences = mod.resolveAudiences;
  AudienceServiceError = mod.AudienceServiceError;
});

describe("audience-client resolveAudiences", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an empty map and makes no call when there are no leads", async () => {
    const { calls } = mockFetch([{ audiences: {} }]);
    const map = await resolveAudiences("brand-1", [], ctx);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("posts brandId + leads to the resolver with internal auth headers", async () => {
    const { calls } = mockFetch([
      { audiences: { "lead-1": { id: "aud-1", name: "A", avatarUrl: null } } },
    ]);

    const map = await resolveAudiences(
      "brand-1",
      [{ leadId: "lead-1", email: "a@b.com", audienceId: null }],
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://human.test/orgs/audiences/resolve");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("human-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      brandId: "brand-1",
      leads: [{ leadId: "lead-1", email: "a@b.com", audienceId: null }],
    });
    expect(map.get("lead-1")).toEqual({ id: "aud-1", name: "A", avatarUrl: null });
  });

  it("batches leads at AUDIENCE_RESOLVE_BATCH_SIZE and merges the maps", async () => {
    const { calls } = mockFetch([
      { audiences: { "lead-1": { id: "aud-1", name: "A", avatarUrl: null } } },
      { audiences: { "lead-3": { id: "aud-3", name: "C", avatarUrl: "u" } } },
    ]);

    const map = await resolveAudiences(
      "brand-1",
      [
        { leadId: "lead-1", email: "a@b.com", audienceId: null },
        { leadId: "lead-2", email: "b@b.com", audienceId: null },
        { leadId: "lead-3", email: "c@b.com", audienceId: "aud-3" },
      ],
      ctx,
    );

    // batch size 2 => 2 calls (2 + 1)
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init.body as string).leads).toHaveLength(2);
    expect(JSON.parse(calls[1].init.body as string).leads).toHaveLength(1);
    expect(map.get("lead-1")).toEqual({ id: "aud-1", name: "A", avatarUrl: null });
    expect(map.get("lead-3")).toEqual({ id: "aud-3", name: "C", avatarUrl: "u" });
    // lead-2 mapped to no active audience => absent
    expect(map.has("lead-2")).toBe(false);
  });

  it("throws AudienceServiceError on a non-2xx response (fail loud)", async () => {
    const fetchSpy = vi.fn(async () => new Response("boom", { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveAudiences("brand-1", [{ leadId: "lead-1", email: "a@b.com", audienceId: null }], ctx),
    ).rejects.toBeInstanceOf(AudienceServiceError);
  });
});
