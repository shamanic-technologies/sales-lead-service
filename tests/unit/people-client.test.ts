import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PeopleServiceError,
  serveNext,
  isPeopleCreditInsufficientError,
  isAudienceNotServeableError,
  type Person,
} from "../../src/lib/people-client.js";

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

const ctx = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandId: "brand-1",
  campaignId: "campaign-1",
  featureSlug: "lead-finder-v1",
  goal: "signup",
  audienceId: "aud-123",
};

const person: Person = {
  firstName: "Sara",
  lastName: "Lee",
  name: "Sara Lee",
  title: "Founder",
  headline: "Founder at Casco Bay",
  seniority: "owner",
  email: "sara@cascobay.com",
  emailStatus: "verified",
  catchAll: false,
  inferred: false,
  linkedinUrl: null,
  photoUrl: null,
  city: null,
  state: null,
  country: null,
  provider: "apollo",
  providerPersonId: "apollo-person-1",
  organization: null,
};

describe("people-client serveNext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs an empty body to /orgs/audiences/{id}/serve-next with identity headers", async () => {
    const { calls } = mockFetch({ status: "served", person });

    const result = await serveNext("aud-123", ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://human:3012/orgs/audiences/aud-123/serve-next");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({});

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-brand-id"]).toBe("brand-1");
    expect(headers["x-run-id"]).toBe("run-1");
    expect(headers["x-feature-slug"]).toBe("lead-finder-v1");
    expect(headers["x-goal"]).toBe("signup");
    // Regression guard: x-audience-id MUST be forwarded on internal egress so
    // runs-service can attribute the downstream (human-service) spend per audience.
    expect(headers["x-audience-id"]).toBe("aud-123");
    expect(headers["X-API-Key"]).toBeDefined();

    expect(result.status).toBe("served");
    expect(result.person?.email).toBe("sara@cascobay.com");
  });

  it("returns exhausted with a null person", async () => {
    mockFetch({ status: "exhausted", person: null });
    const result = await serveNext("aud-123", ctx);
    expect(result).toEqual({ status: "exhausted", person: null });
  });

  it("url-encodes the audience id", async () => {
    const { calls } = mockFetch({ status: "exhausted", person: null });
    await serveNext("aud/with space", ctx);
    expect(calls[0].url).toBe("http://human:3012/orgs/audiences/aud%2Fwith%20space/serve-next");
  });

  it("throws PeopleServiceError on non-2xx (no silent fallback)", async () => {
    const fetchSpy = vi.fn(async () => new Response("audience gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(serveNext("aud-123", ctx)).rejects.toBeInstanceOf(PeopleServiceError);
  });

  it("classifies a gateway 402 credit_insufficient response", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ type: "credit_insufficient", error: "Insufficient credits" }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    let caught: unknown;
    try {
      await serveNext("aud-123", ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PeopleServiceError);
    expect(isPeopleCreditInsufficientError(caught)).toBe(true);
  });

  it("classifies a serve-next 422 'no committed provider' as audience-not-serveable", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: "Audience has no committed provider — cannot serve people." }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    let caught: unknown;
    try {
      await serveNext("aud-123", ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PeopleServiceError);
    expect(isAudienceNotServeableError(caught)).toBe(true);
    expect(isPeopleCreditInsufficientError(caught)).toBe(false);
  });

  it("does NOT classify other errors as audience-not-serveable", () => {
    expect(isAudienceNotServeableError(new PeopleServiceError(500, "boom"))).toBe(false);
    expect(isAudienceNotServeableError(new PeopleServiceError(422, JSON.stringify({ error: "Audience exhausted" })))).toBe(false);
    expect(isAudienceNotServeableError(new Error("network"))).toBe(false);
    expect(isAudienceNotServeableError(null)).toBe(false);
  });
});
