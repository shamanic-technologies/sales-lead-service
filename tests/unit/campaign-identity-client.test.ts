import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";

function campaign(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG,
    brandId: BRAND,
    brandIds: [BRAND],
    offerId: "offer-1",
    legKey: "start_to_conversation",
    acquisitionChannel: "cold_email",
    status: "stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("resolveCampaignFamily", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns every member of the requested campaign's identity", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          campaigns: [campaign("c1"), campaign("c2", { status: "ongoing" }), campaign("crm", { acquisitionChannel: "crm_email" })],
        }),
    });
    const { resolveCampaignFamily } = await import("../../src/lib/campaign-identity-client.js");

    await expect(resolveCampaignFamily("c1", { orgId: ORG, brandId: BRAND })).resolves.toEqual(["c1", "c2"]);
  });

  it("reads campaign-service ORG-scoped — a brand filter matches the legacy array and would drop a member", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ campaigns: [campaign("c1")] }),
    });
    const { resolveCampaignFamily } = await import("../../src/lib/campaign-identity-client.js");

    await resolveCampaignFamily("c1", { orgId: ORG, brandId: BRAND, userId: "u1", runId: "r1" });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://campaign.test/campaigns");
    expect(url).not.toContain("brandId=");
    expect(opts.headers["x-org-id"]).toBe(ORG);
    expect(opts.headers["X-API-Key"]).toBe("test-campaign-key");
  });

  it("falls back to the single stored row, loudly, when campaign-service fails — never a brand-wide answer", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve("down") });
    const { resolveCampaignFamily } = await import("../../src/lib/campaign-identity-client.js");

    await expect(resolveCampaignFamily("c1", { orgId: ORG })).resolves.toEqual(["c1"]);
    expect(errorLog).toHaveBeenCalled();
    expect(String(errorLog.mock.calls[0][0])).toContain("campaign identity unavailable");
  });

  it("falls back to the single stored row when the response carries no campaigns array", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const { resolveCampaignFamily } = await import("../../src/lib/campaign-identity-client.js");

    await expect(resolveCampaignFamily("c1", { orgId: ORG })).resolves.toEqual(["c1"]);
    expect(errorLog).toHaveBeenCalled();
  });

  it("warns and keeps the single row when campaign-service does not know the campaign", async () => {
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ campaigns: [campaign("other")] }),
    });
    const { resolveCampaignFamily } = await import("../../src/lib/campaign-identity-client.js");

    await expect(resolveCampaignFamily("c1", { orgId: ORG })).resolves.toEqual(["c1"]);
    expect(String(warnLog.mock.calls[0][0])).toContain("campaign identity unresolved");
  });
});
