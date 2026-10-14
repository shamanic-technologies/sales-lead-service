import { describe, it, expect, vi, afterEach } from "vitest";

// SOURCE CAMPAIGNS (src/lib/source-campaign.ts): which source campaign a serve is filed under,
// read from campaign-service. No per-campaign ceiling is read from billing (owner 2026-10-14: a
// campaign's spend is bounded by its sales funnel caps, enforced by billing at authorize).

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
  HUMAN_SERVICE_URL: "http://human",
  HUMAN_SERVICE_API_KEY: "human-key",
}));

const ORG = "org-1";
const BRAND = "brand-1";
const OFFER = "offer-1";
const OUTREACH = "outreach-1";
const COLD = "sourcing-apollo-cold-filters";
const LINKEDIN = "sourcing-linkedin-engagement-signals";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sources(entries: Array<{ featureSlug: string; campaignId: string; running: boolean }>, extra: Record<string, unknown> = {}) {
  return {
    campaignId: OUTREACH,
    orgId: ORG,
    offerId: OFFER,
    featureSlug: "sales-cold-email-outreach",
    sourced: true,
    servedOrigins: [COLD, LINKEDIN],
    sourceCampaigns: entries.map((e) => ({ ...e, campaignKey: `campaign:${e.featureSlug}|start_to_lead_found`, status: e.running ? "ongoing" : "stopped" })),
    ...extra,
  };
}

function stub(opts: { campaign: unknown; campaignStatus?: number; choice?: unknown; choiceStatus?: number; seen?: Array<{ url: string; headers: Record<string, string> }> }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    opts.seen?.push({ url, headers: init?.headers as Record<string, string> });
    if (url === `http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`) return json(opts.campaign, opts.campaignStatus ?? 200);
    if (url === `http://human/orgs/lead-sourcing/sources?brandId=${BRAND}&offerId=${OFFER}`) return json(opts.choice ?? { chosenOriginSlugs: [] }, opts.choiceStatus ?? 200);
    // billing retired its per-campaign ceiling read (stage 2): it answers 404.
    if (url.startsWith("http://billing/")) return json({ error: "Not found" }, 404);
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function resolve(originSlug: string | null = COLD) {
  const { resolveServeSource } = await import("../../src/lib/source-campaign.js");
  return resolveServeSource({ orgId: ORG, brandId: BRAND, outreachCampaignId: OUTREACH, originSlug, userId: "user-1", runId: "run-1" });
}

describe("resolveServeSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("files the serve under the origin's ON source campaign; billing's retired per-campaign read (404) is never asked", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    stub({
      campaign: sources([
        { featureSlug: COLD, campaignId: "src-cold", running: true },
        { featureSlug: LINKEDIN, campaignId: "src-li", running: false },
      ]),
      seen,
    });
    await expect(resolve()).resolves.toEqual({ kind: "source", campaignId: "src-cold", originSlug: COLD, sourceSlug: COLD, offerId: OFFER });
    expect(seen[0].headers).toMatchObject({ "x-api-key": "campaign-key", "x-org-id": ORG });
    expect(seen.some((x) => x.url.startsWith("http://billing/"))).toBe(false);
  });

  it("an offer whose sources are not campaigns yet keeps today's serve (legacy)", async () => {
    const fetchMock = stub({ campaign: sources([]) });
    await expect(resolve()).resolves.toEqual({ kind: "legacy", why: "offer_not_on_source_campaigns" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a channel that sources nothing (or an offer-less campaign) is legacy", async () => {
    stub({ campaign: sources([], { sourced: false, offerId: null }) });
    await expect(resolve()).resolves.toEqual({ kind: "legacy", why: "channel_not_sourced" });
  });

  it("no origin (nothing bought): legacy without any read", async () => {
    const fetchMock = stub({ campaign: sources([]) });
    await expect(resolve(null)).resolves.toMatchObject({ kind: "legacy" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the origin's source campaign is OFF: refused source_campaign_off", async () => {
    stub({
      campaign: sources([
        { featureSlug: COLD, campaignId: "src-cold", running: true },
        { featureSlug: LINKEDIN, campaignId: "src-li", running: false },
      ]),
    });
    await expect(resolve(LINKEDIN)).resolves.toMatchObject({ kind: "refused", reason: "source_campaign_off", campaignId: "src-li" });
  });

  it("the offer has sources but none for this origin: refused source_campaign_off", async () => {
    stub({ campaign: sources([{ featureSlug: COLD, campaignId: "src-cold", running: true }]) });
    await expect(resolve(LINKEDIN)).resolves.toMatchObject({ kind: "refused", reason: "source_campaign_off", campaignId: null });
  });

  it("LEAD SOURCING (owner 2026-10-11): an origin human-service chose is filed under the Lead Sourcing campaign", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    stub({
      campaign: sources([
        { featureSlug: COLD, campaignId: "src-cold-old", running: false },
        { featureSlug: "lead-sourcing", campaignId: "src-ls", running: true },
      ]),
      choice: { chosenOriginSlugs: [COLD, LINKEDIN] },
      seen,
    });
    await expect(resolve()).resolves.toEqual({ kind: "source", campaignId: "src-ls", originSlug: COLD, sourceSlug: "lead-sourcing", offerId: OFFER });
    const human = seen.find((x) => x.url.startsWith("http://human/"))!;
    expect(human.headers).toMatchObject({ "x-api-key": "human-key", "x-org-id": ORG, "x-user-id": "user-1", "x-run-id": "run-1" });
    expect(seen.some((x) => x.url.startsWith("http://billing/"))).toBe(false);
  });

  it("LEAD SOURCING: an origin human-service did not choose is refused source_campaign_off, nothing bought", async () => {
    stub({ campaign: sources([{ featureSlug: "lead-sourcing", campaignId: "src-ls", running: true }]), choice: { chosenOriginSlugs: [COLD] } });
    await expect(resolve(LINKEDIN)).resolves.toMatchObject({ kind: "refused", reason: "source_campaign_off", campaignId: "src-ls" });
  });

  it("an origin's OWN ON campaign wins over Lead Sourcing (human-service not asked)", async () => {
    const fetchMock = stub({
      campaign: sources([
        { featureSlug: COLD, campaignId: "src-cold", running: true },
        { featureSlug: "lead-sourcing", campaignId: "src-ls", running: true },
      ]),
    });
    await expect(resolve()).resolves.toMatchObject({ kind: "source", campaignId: "src-cold", sourceSlug: COLD });
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("http://human/"))).toBe(false);
  });

  it("LEAD SOURCING: human-service unreadable fails loud (never a serve filed on a guess)", async () => {
    const { SourceCampaignUnresolvedError } = await import("../../src/lib/source-campaign.js");
    stub({ campaign: sources([{ featureSlug: "lead-sourcing", campaignId: "src-ls", running: true }]), choice: { error: "x" }, choiceStatus: 502 });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
    stub({ campaign: sources([{ featureSlug: "lead-sourcing", campaignId: "src-ls", running: true }]), choice: { nope: true } });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
  });

  it("fails loud when campaign-service cannot answer", async () => {
    const { SourceCampaignUnresolvedError } = await import("../../src/lib/source-campaign.js");
    stub({ campaign: { error: "boom" }, campaignStatus: 500 });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
    stub({ campaign: { unexpected: true } });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
  });
});
