import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  FEATURES_SERVICE_URL: "http://features",
  HUMAN_SERVICE_URL: "http://human",
  HUMAN_SERVICE_API_KEY: "human-key",
}));

const ORIGINS = {
  origins: [
    { slug: "sourcing-apollo-cold-filters", audienceLists: ["apollo_search"] },
    { slug: "sourcing-apollo-buying-signals", audienceLists: ["apollo_buying_signal"] },
    { slug: "sourcing-crm-contacts", audienceLists: ["crm_contacts"] },
  ],
  sourcingChannels: ["sales-cold-email-outreach"],
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function route(audience: unknown, origins: unknown = ORIGINS, audienceStatus = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "http://features/public/sourcing-origins") return json(origins);
    if (url.startsWith("http://human/orgs/audiences/")) {
      expect((init?.headers as Record<string, string>)["x-org-id"]).toBe("org-1");
      return json(audience, audienceStatus);
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe("resolveSourcingOriginSlug", () => {
  beforeEach(async () => {
    const { resetSourcingOriginsCache } = await import("../../src/lib/sourcing-origin.js");
    resetSourcingOriginsCache();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("maps the audience's list kind to its origin slug through the catalogue", async () => {
    vi.stubGlobal("fetch", route({ audience: { channels: [{ list: "apollo_buying_signal" }] } }));
    const { resolveSourcingOriginSlug } = await import("../../src/lib/sourcing-origin.js");
    await expect(resolveSourcingOriginSlug({ audienceId: "aud-1", orgId: "org-1" })).resolves.toBe(
      "sourcing-apollo-buying-signals",
    );
  });

  it("throws when the audience states no list kind", async () => {
    vi.stubGlobal("fetch", route({ audience: { channels: [] } }));
    const { resolveSourcingOriginSlug } = await import("../../src/lib/sourcing-origin.js");
    await expect(resolveSourcingOriginSlug({ audienceId: "aud-1", orgId: "org-1" })).rejects.toThrow(/no list kind/);
  });

  it("throws when the catalogue has no origin for the list kind", async () => {
    vi.stubGlobal("fetch", route({ audience: { channels: [{ list: "linkedin_engagement" }] } }));
    const { resolveSourcingOriginSlug } = await import("../../src/lib/sourcing-origin.js");
    await expect(resolveSourcingOriginSlug({ audienceId: "aud-1", orgId: "org-1" })).rejects.toThrow(
      /no sourcing origin.*linkedin_engagement/,
    );
  });

  it("throws when human-service cannot read the audience", async () => {
    vi.stubGlobal("fetch", route({ error: "Audience not found" }, ORIGINS, 404));
    const { resolveSourcingOriginSlug } = await import("../../src/lib/sourcing-origin.js");
    await expect(resolveSourcingOriginSlug({ audienceId: "aud-1", orgId: "org-1" })).rejects.toThrow(/404/);
  });

  it("throws when the catalogue read is unreadable", async () => {
    vi.stubGlobal("fetch", route({ audience: { channels: [{ list: "apollo_search" }] } }, { nope: true }));
    const { resolveSourcingOriginSlug } = await import("../../src/lib/sourcing-origin.js");
    await expect(resolveSourcingOriginSlug({ audienceId: "aud-1", orgId: "org-1" })).rejects.toThrow(/origins list/);
  });
});
