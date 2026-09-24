import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OFFER = "0ffe0000-0000-4000-8000-000000000001";
const OTHER_OFFER = "0ffe0000-0000-4000-8000-000000000002";

function campaign(id: string, offerId: string | null, funnelKey: string | null = null) {
  return { id, orgId: ORG, brandId: BRAND, offerId, funnelKey };
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

  it("narrows to the offer's campaigns that STATE the funnel, in either spelling", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        campaigns: [
          campaign("a-reply", OFFER, "sales_meetings_from_conversation"),
          campaign("b-reply-legacy", OFFER, "reply_meeting"),
          campaign("c-visit", OFFER, "website_purchases"),
          campaign("d-pr", OFFER, null),
          campaign("e-other-offer", OTHER_OFFER, "sales_meetings_from_conversation"),
        ],
      }),
    });

    const { resolveOfferCampaignIds } = await import("../../src/lib/offer-campaigns-client.js");
    expect(
      await resolveOfferCampaignIds(OFFER, { orgId: ORG }, "sales_meetings_from_conversation"),
    ).toEqual(["a-reply", "b-reply-legacy"]);
  });

  it("never adopts a campaign stating no funnel into a funnel, so each funnel is a subset of the offer", async () => {
    const rows = [
      campaign("a-reply", OFFER, "sales_meetings_from_conversation"),
      campaign("c-visit", OFFER, "website_purchases"),
      campaign("d-pr", OFFER, null),
      campaign("f-unknown", OFFER, "something_else"),
    ];
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ campaigns: rows }) });

    const { resolveOfferCampaignIds } = await import("../../src/lib/offer-campaigns-client.js");
    const offer = await resolveOfferCampaignIds(OFFER, { orgId: ORG });
    const reply = await resolveOfferCampaignIds(OFFER, { orgId: ORG }, "sales_meetings_from_conversation");
    const visit = await resolveOfferCampaignIds(OFFER, { orgId: ORG }, "website_purchases");

    expect(offer).toEqual(["a-reply", "c-visit", "d-pr", "f-unknown"]);
    expect(reply).toEqual(["a-reply"]);
    expect(visit).toEqual(["c-visit"]);
    for (const id of [...reply, ...visit]) expect(offer).toContain(id);
    expect(reply.filter((id) => visit.includes(id))).toEqual([]);
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
