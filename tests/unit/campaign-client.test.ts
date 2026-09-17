import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "https://campaign.test",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
}));

describe("campaign-client", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchCampaign attaches a 5s AbortSignal — DAG retry must not wait minutes on a hung campaign-service", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c", name: "x" } }),
    });
    const { fetchCampaign } = await import("../../src/lib/campaign-client.js");

    await fetchCampaign("c1", "org-1");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  // The serve path names the campaign's offer on its brand-service goal read, so a
  // sibling mid-restart resetting the connection must not silently cost the offer —
  // a multi-offer brand's serve would then fail on SEVERAL_OFFERS again.
  it("fetchCampaign retries a connect-phase reset instead of dropping the campaign", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    fetchSpy.mockRejectedValueOnce(reset);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ campaign: { id: "c1", offerId: "offer-7" } }),
    });
    const { fetchCampaign } = await import("../../src/lib/campaign-client.js");

    const campaign = await fetchCampaign("c1", "org-1");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(campaign?.offerId).toBe("offer-7");
  });

  // A completed HTTP answer is never retried: the server produced it and may have
  // side-effected. Only a thrown connect-phase rejection is write-safe to repeat.
  it("fetchCampaign does not retry a 500 — that is a real answer, not a lost connection", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    const { fetchCampaign } = await import("../../src/lib/campaign-client.js");

    await expect(fetchCampaign("c1", "org-1")).rejects.toThrow(/500/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
