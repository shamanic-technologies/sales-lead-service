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
});
