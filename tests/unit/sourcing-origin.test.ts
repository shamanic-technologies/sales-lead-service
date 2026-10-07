import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  FEATURES_SERVICE_URL: "http://features",
  HUMAN_SERVICE_URL: "http://human",
  HUMAN_SERVICE_API_KEY: "human-key",
}));

const CATALOGUE = {
  origins: [],
  sourcingChannels: ["sales-cold-email-outreach", "sales-crm-email-outreach"],
  originsByChannel: {
    "sales-cold-email-outreach": ["sourcing-apollo-cold-filters", "sourcing-apollo-buying-signals"],
    "sales-crm-email-outreach": ["sourcing-crm-contacts"],
  },
};
const COLD = { audienceId: "aud-1", orgId: "org-1", outreachFeatureSlug: "sales-cold-email-outreach" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** human-service answers `origin` (or `status`), features-service answers `catalogue`. */
function route(origin: unknown, opts: { status?: number; catalogue?: unknown; seen?: Record<string, string>[] } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "http://features/public/sourcing-origins") return json(opts.catalogue ?? CATALOGUE);
    if (url === "http://human/orgs/audiences/aud-1/sourcing-origin") {
      opts.seen?.push(init?.headers as Record<string, string>);
      return json(origin, opts.status ?? 200);
    }
    throw new Error(`unexpected ${url}`);
  });
}

async function resolve(params = COLD) {
  const { resolveSourcingOriginSlug } = await import("../../src/lib/sourcing-origin.js");
  return resolveSourcingOriginSlug(params);
}

describe("resolveSourcingOriginSlug", () => {
  beforeEach(async () => {
    const { resetSourcingOriginsCache } = await import("../../src/lib/sourcing-origin.js");
    resetSourcingOriginsCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns human-service's origin, asked with the org and the OUTREACH slug", async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal("fetch", route({ sourcingFeatureSlug: "sourcing-apollo-buying-signals" }, { seen }));
    await expect(resolve()).resolves.toBe("sourcing-apollo-buying-signals");
    expect(seen[0]["x-org-id"]).toBe("org-1");
    expect(seen[0]["x-feature-slug"]).toBe("sales-cold-email-outreach");
  });

  it("returns null when the audience serves from no list (422): nothing will be bought", async () => {
    vi.stubGlobal("fetch", route({ error: "no committed provider" }, { status: 422 }));
    await expect(resolve()).resolves.toBeNull();
  });

  it("throws when human-service cannot answer", async () => {
    vi.stubGlobal("fetch", route({ error: "features-service down" }, { status: 502 }));
    await expect(resolve()).rejects.toThrow(/502/);
  });

  it("throws when human-service answers no slug", async () => {
    vi.stubGlobal("fetch", route({ audienceId: "aud-1", list: "apollo_search" }));
    await expect(resolve()).rejects.toThrow(/no sourcingFeatureSlug/);
  });

  it("keeps the outreach label (null) and logs an error for an origin the channel does not count", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", route({ sourcingFeatureSlug: "sourcing-crm-contacts" }));
    await expect(resolve()).resolves.toBeNull();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/origin=sourcing-crm-contacts is not one the outreach channel counts/);
  });

  it("accepts the CRM origin under the CRM channel", async () => {
    vi.stubGlobal("fetch", route({ sourcingFeatureSlug: "sourcing-crm-contacts" }));
    await expect(resolve({ ...COLD, outreachFeatureSlug: "sales-crm-email-outreach" })).resolves.toBe(
      "sourcing-crm-contacts",
    );
  });

  it("keeps the outreach label (null) and logs an error for a channel that is not a sourcing channel", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", route({ sourcingFeatureSlug: "sourcing-apollo-cold-filters" }));
    await expect(resolve({ ...COLD, outreachFeatureSlug: "some-other-channel" })).resolves.toBeNull();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/not a sourcing channel/);
  });

  it("refuses a catalogue that states no originsByChannel", async () => {
    vi.stubGlobal("fetch", route({ sourcingFeatureSlug: "sourcing-apollo-cold-filters" }, { catalogue: { origins: [] } }));
    await expect(resolve()).rejects.toThrow(/originsByChannel/);
  });
});
