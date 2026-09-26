import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OFFER = "0ffe0000-0000-4000-8000-000000000001";
const OTHER_OFFER = "0ffe0000-0000-4000-8000-000000000002";

function campaign(id: string, offerId: string | null) {
  return { id, orgId: ORG, brandId: BRAND, offerId };
}

describe("resolveOfferCampaignIds", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns every campaign in the org that names the offer, ascending", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        campaigns: [
          campaign("c-live", OFFER),
          campaign("a-stopped", OFFER),
          campaign("b-other-offer", OTHER_OFFER),
        ],
      }),
    });

    const { resolveOfferCampaignIds } = await import("../../src/lib/offer-campaigns-client.js");
    const ids = await resolveOfferCampaignIds(OFFER, { orgId: ORG, brandId: BRAND });

    expect(ids).toEqual(["a-stopped", "c-live"]);
  });

  it("never adopts a campaign that states no offer", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ campaigns: [campaign("c-1", OFFER), campaign("c-2", null)] }),
    });

    const { resolveOfferCampaignIds } = await import("../../src/lib/offer-campaigns-client.js");
    expect(await resolveOfferCampaignIds(OFFER, { orgId: ORG })).toEqual(["c-1"]);
  });

  it("reads the whole org list — a bound would silently drop the offer's stopped campaigns", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ campaigns: [] }) });

    const { resolveOfferCampaignIds } = await import("../../src/lib/offer-campaigns-client.js");
    await resolveOfferCampaignIds(OFFER, { orgId: ORG, userId: "u-1", runId: "r-1", brandId: BRAND });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://campaign.test/campaigns");
    expect(url).not.toContain("limit");
    expect(init.headers["x-org-id"]).toBe(ORG);
    expect(init.headers["X-API-Key"]).toBe("test-campaign-key");
    expect(init.headers["x-brand-id"]).toBe(BRAND);
  });

  it("an offer no campaign sells is an EMPTY answer, not a failure", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ campaigns: [campaign("c-1", OTHER_OFFER)] }),
    });

    const { resolveOfferCampaignIds } = await import("../../src/lib/offer-campaigns-client.js");
    expect(await resolveOfferCampaignIds(OFFER, { orgId: ORG })).toEqual([]);
  });

  it("throws rather than falling back when campaign-service answers with an error", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503, text: async () => "down" });

    const { resolveOfferCampaignIds, OfferCampaignsUnavailableError } = await import(
      "../../src/lib/offer-campaigns-client.js"
    );
    await expect(resolveOfferCampaignIds(OFFER, { orgId: ORG })).rejects.toBeInstanceOf(
      OfferCampaignsUnavailableError,
    );
  });

  it("throws when campaign-service is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const { resolveOfferCampaignIds, OfferCampaignsUnavailableError } = await import(
      "../../src/lib/offer-campaigns-client.js"
    );
    await expect(resolveOfferCampaignIds(OFFER, { orgId: ORG })).rejects.toBeInstanceOf(
      OfferCampaignsUnavailableError,
    );
  });

  it("throws on a body carrying no campaigns array — an unreadable answer is not an empty offer", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const { resolveOfferCampaignIds, OfferCampaignsUnavailableError } = await import(
      "../../src/lib/offer-campaigns-client.js"
    );
    await expect(resolveOfferCampaignIds(OFFER, { orgId: ORG })).rejects.toBeInstanceOf(
      OfferCampaignsUnavailableError,
    );
  });
});
