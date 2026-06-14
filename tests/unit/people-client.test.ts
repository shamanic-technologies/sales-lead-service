import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PeopleServiceError,
  peopleSearch,
  resolveEmail,
  peopleDryRun,
  fetchFiltersPrompt,
  isPeopleCreditInsufficientError,
} from "../../src/lib/people-client.js";

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

const baseSearchCtx = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandId: "brand-1",
  campaignId: "campaign-1",
};

describe("people-client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("peopleSearch", () => {
    const page = { provider: "apollo", people: [], done: false, total: 0, nextOffset: null };

    it("apollo first page: posts provider + filters, no nextPage/offset, identity headers", async () => {
      const { calls } = mockFetch(page);
      await peopleSearch({
        provider: "apollo",
        filters: { titles: ["Dentist"] },
        ...baseSearchCtx,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://human:3012/orgs/people/search");
      const body = parseBody(calls[0].init);
      expect(body).toEqual({ provider: "apollo", filters: { titles: ["Dentist"] } });
      expect(body).not.toHaveProperty("nextPage");
      expect(body).not.toHaveProperty("offset");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org-1");
      expect(headers["x-user-id"]).toBe("user-1");
      expect(headers["x-campaign-id"]).toBe("campaign-1");
      expect(headers["x-brand-id"]).toBe("brand-1");
      expect(headers["x-run-id"]).toBe("run-1");
      expect(headers["X-API-Key"]).toBeDefined();
    });

    it("apollo next page: sends nextPage:true with no filters", async () => {
      const { calls } = mockFetch(page);
      await peopleSearch({ provider: "apollo", nextPage: true, ...baseSearchCtx });

      const body = parseBody(calls[0].init);
      expect(body).toEqual({ provider: "apollo", nextPage: true });
      expect(body).not.toHaveProperty("filters");
    });

    it("apify: sends filters + offset, returns nextOffset", async () => {
      const { calls } = mockFetch({
        provider: "apify",
        people: [],
        done: false,
        total: 0,
        nextOffset: 100,
      });
      const result = await peopleSearch({
        provider: "apify",
        filters: { companyNames: ["Acme"] },
        offset: 0,
        ...baseSearchCtx,
      });

      const body = parseBody(calls[0].init);
      expect(body).toEqual({ provider: "apify", filters: { companyNames: ["Acme"] }, offset: 0 });
      expect(result.nextOffset).toBe(100);
    });
  });

  describe("resolveEmail", () => {
    it("posts provider + name + domain to /orgs/people/resolve-email", async () => {
      const { calls } = mockFetch({ provider: "apollo", person: { email: "a@b.com" } });
      const result = await resolveEmail({
        provider: "apollo",
        firstName: "Sara",
        lastName: "Lee",
        domain: "cascobay.com",
        orgId: "org-1",
        userId: "user-1",
      });

      expect(calls[0].url).toBe("http://human:3012/orgs/people/resolve-email");
      const body = parseBody(calls[0].init);
      expect(body).toEqual({
        provider: "apollo",
        firstName: "Sara",
        lastName: "Lee",
        domain: "cascobay.com",
      });
      expect(result.person).toEqual({ email: "a@b.com" });
    });

    it("posts provider + providerPersonId (no name/domain) for the apollo enrich path", async () => {
      const { calls } = mockFetch({ provider: "apollo", person: { email: "a@b.com" } });
      await resolveEmail({
        provider: "apollo",
        providerPersonId: "apollo-person-1",
        orgId: "org-1",
        userId: "user-1",
      });

      const body = parseBody(calls[0].init);
      expect(body).toEqual({ provider: "apollo", providerPersonId: "apollo-person-1" });
      expect(body).not.toHaveProperty("firstName");
      expect(body).not.toHaveProperty("domain");
    });

    it("includes providerPersonId alongside name+domain when both are present", async () => {
      const { calls } = mockFetch({ provider: "apollo", person: { email: "a@b.com" } });
      await resolveEmail({
        provider: "apollo",
        providerPersonId: "apollo-person-1",
        firstName: "Sara",
        lastName: "Lee",
        domain: "cascobay.com",
        orgId: "org-1",
      });

      const body = parseBody(calls[0].init);
      expect(body).toEqual({
        provider: "apollo",
        providerPersonId: "apollo-person-1",
        firstName: "Sara",
        lastName: "Lee",
        domain: "cascobay.com",
      });
    });
  });

  describe("peopleDryRun", () => {
    it("posts provider + filters to /orgs/people/search/dry-run", async () => {
      const { calls } = mockFetch({ provider: "apollo", totalEntries: 3500 });
      const result = await peopleDryRun({
        provider: "apollo",
        filters: { titles: ["Dentist"] },
        orgId: "org-1",
      });

      expect(calls[0].url).toBe("http://human:3012/orgs/people/search/dry-run");
      const body = parseBody(calls[0].init);
      expect(body).toEqual({ provider: "apollo", filters: { titles: ["Dentist"] } });
      expect(result.totalEntries).toBe(3500);
    });
  });

  describe("fetchFiltersPrompt", () => {
    it("GETs /orgs/people/filters-prompt with provider query + identity headers", async () => {
      const { calls } = mockFetch({ provider: "apify", prompt: "DOC", schemaVersion: "v1" });

      const out = await fetchFiltersPrompt({ provider: "apify", orgId: "org-9", userId: "user-9" });

      expect(out).toEqual({ provider: "apify", prompt: "DOC", schemaVersion: "v1" });
      expect(calls[0].url).toBe("http://human:3012/orgs/people/filters-prompt?provider=apify");
      expect(calls[0].init.method ?? "GET").toBe("GET");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org-9");
      expect(headers["x-user-id"]).toBe("user-9");
      expect(headers["X-API-Key"]).toBeDefined();
    });

    it("omits x-user-id when userId is null", async () => {
      const { calls } = mockFetch({ provider: "apollo", prompt: "DOC", schemaVersion: "v1" });
      await fetchFiltersPrompt({ provider: "apollo", orgId: "org-9", userId: null });

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-org-id"]).toBe("org-9");
      expect(headers["x-user-id"]).toBeUndefined();
    });

    it("throws on non-2xx response (no silent fallback)", async () => {
      const fetchSpy = vi.fn(async () => new Response("gateway down", { status: 503 }));
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        fetchFiltersPrompt({ provider: "apollo", orgId: "org-1", userId: null }),
      ).rejects.toThrow(/People gateway call failed: 503/);
    });
  });

  describe("credit-insufficient classification", () => {
    it("classifies gateway 402 credit_insufficient responses", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(
          JSON.stringify({
            type: "credit_insufficient",
            error: "Insufficient credits",
            balance_cents: "0.31",
            required_cents: "2.83",
          }),
          { status: 402, headers: { "Content-Type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchSpy);

      let caught: unknown;
      try {
        await resolveEmail({
          provider: "apollo",
          firstName: "Sara",
          lastName: "Lee",
          domain: "cascobay.com",
          orgId: "org-1",
          userId: "user-1",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PeopleServiceError);
      expect(isPeopleCreditInsufficientError(caught)).toBe(true);
    });
  });
});
