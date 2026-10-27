import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PeopleServiceError,
  serveNext,
  serveBody,
  isStepFilterRefusal,
  isPeopleCreditInsufficientError,
  isAudienceNotServeableError,
  HumanServiceStalledError,
  revealCandidate,
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

describe("people-client serveNext: the serving pipe's reach on the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends reachableBy when the pipe states one (WhatsApp: phone)", async () => {
    const { calls } = mockFetch({ status: "exhausted", person: null });
    await serveNext("aud-123", { ...ctx, reachableBy: ["phone"] });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ reachableBy: ["phone"] });
  });

  it("sends an empty body when it states none (bytes unchanged)", async () => {
    const { calls } = mockFetch({ status: "exhausted", person: null });
    await serveNext("aud-123", ctx);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
  });
});

// CRM-WARM-NURTURE-1015: crm-service's step filter, carried verbatim on the wire; absent = today's bytes.
describe("people-client stepFilter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serve-next carries the pipe's stepFilter byte for byte", async () => {
    const stepFilter = { reached: ["form_submission", "meeting_booked"], notReached: ["sale", "disqualified"] };
    const { calls } = mockFetch({ status: "served", person });
    await serveNext("aud-123", { ...ctx, stepFilter });
    expect(calls[0].init.body).toBe(JSON.stringify({ stepFilter }));
  });

  it("no stepFilter: the body is byte-identical to today's", async () => {
    const { calls } = mockFetch({ status: "served", person });
    await serveNext("aud-123", { ...ctx, relationships: "business_only" });
    expect(calls[0].init.body).toBe(JSON.stringify({ relationships: "business_only" }));
    expect(serveBody(ctx)).toEqual({});
  });

  it("serve-next, candidates/next and reveal carry the serve's re-contact window verbatim (FRESH-2-MONTHS-1027)", async () => {
    const { calls } = mockFetch({ status: "served", person });
    await serveNext("aud-123", { ...ctx, excludeEmailedWithin: "2_months" });
    expect(calls[0].init.body).toBe(JSON.stringify({ excludeEmailedWithin: "2_months" }));
    await revealCandidate("aud-1", "cand-1", "basis", { ...ctx, excludeEmailedWithin: "2_months" });
    expect(calls[1].init.body).toBe(JSON.stringify({ basis: "basis", excludeEmailedWithin: "2_months" }));
    await revealCandidate("aud-1", "cand-1", "basis", ctx);
    expect(calls[2].init.body).toBe(JSON.stringify({ basis: "basis" }));
  });

  it("a 400 is a step-filter refusal only when the pipe stated one", () => {
    const err = new PeopleServiceError(400, '{"error":"unknown step"}');
    expect(isStepFilterRefusal(err, { reached: ["x"] })).toBe(true);
    expect(isStepFilterRefusal(err, undefined)).toBe(false);
    expect(isStepFilterRefusal(new PeopleServiceError(502, "down"), { reached: ["x"] })).toBe(false);
    expect(isStepFilterRefusal(new Error("boom"), { reached: ["x"] })).toBe(false);
  });
});

// DOCDINNERS-SERVE-TIMEOUT-1027: a call human-service never answers ends at the caller's stated time as a NAMED error.
describe("a human-service call that never answers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ends at its own timeout as HumanServiceStalledError, never a bare DOMException after 300s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const started = Date.now();
    const call = revealCandidate("aud-1", "cand-1", "basis", ctx, 50);
    await expect(call).rejects.toBeInstanceOf(HumanServiceStalledError);
    await expect(call).rejects.toThrow(/did not answer .*candidates\/cand-1\/reveal within 50ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
