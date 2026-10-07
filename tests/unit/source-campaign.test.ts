import { describe, it, expect, vi, afterEach } from "vitest";

// SOURCE CAMPAIGNS (src/lib/source-campaign.ts): which source campaign a serve is filed under,
// read from campaign-service, within the source campaign's own budget read from billing.

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
  BILLING_SERVICE_URL: "http://billing",
  BILLING_SERVICE_API_KEY: "billing-key",
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

function stub(opts: { campaign: unknown; campaignStatus?: number; budget?: unknown; budgetStatus?: number; seen?: Array<{ url: string; headers: Record<string, string> }> }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    opts.seen?.push({ url, headers: init?.headers as Record<string, string> });
    if (url === `http://campaign/internal/campaigns/${OUTREACH}/source-campaigns`) return json(opts.campaign, opts.campaignStatus ?? 200);
    if (url.startsWith(`http://billing/internal/brands/${BRAND}/campaign-budget?`)) {
      return json(opts.budget ?? { dailyBudgetCents: null, today: null }, opts.budgetStatus ?? 200);
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function resolve(originSlug: string | null = COLD) {
  const { resolveServeSource } = await import("../../src/lib/source-campaign.js");
  return resolveServeSource({ orgId: ORG, brandId: BRAND, outreachCampaignId: OUTREACH, originSlug });
}

describe("resolveServeSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("files the serve under the origin's ON source campaign, asking billing for THAT campaign's budget", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    stub({
      campaign: sources([
        { featureSlug: COLD, campaignId: "src-cold", running: true },
        { featureSlug: LINKEDIN, campaignId: "src-li", running: false },
      ]),
      budget: { dailyBudgetCents: "4200", today: { spentCents: "1000.5" } },
      seen,
    });
    await expect(resolve()).resolves.toEqual({ kind: "source", campaignId: "src-cold", originSlug: COLD, offerId: OFFER });
    expect(seen[0].headers).toMatchObject({ "x-api-key": "campaign-key", "x-org-id": ORG });
    const budgetUrl = new URL(seen[1].url);
    expect(Object.fromEntries(budgetUrl.searchParams)).toEqual({
      offerId: OFFER,
      legKey: "start_to_lead_found",
      featureSlug: COLD,
      campaignIds: "src-cold",
    });
    expect(seen[1].headers).toMatchObject({ "x-api-key": "billing-key", "x-org-id": ORG });
  });

  it("an offer whose sources are not campaigns yet keeps today's serve (legacy), billing never asked", async () => {
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

  it("the source campaign spent its daily budget today: refused source_budget_reached", async () => {
    stub({
      campaign: sources([{ featureSlug: COLD, campaignId: "src-cold", running: true }]),
      budget: { dailyBudgetCents: "4200", today: { spentCents: "4200" } },
    });
    await expect(resolve()).resolves.toMatchObject({ kind: "refused", reason: "source_budget_reached", campaignId: "src-cold" });
  });

  it("no ceiling stated for the source campaign: nothing caps it here (the outreach gate paces, as today)", async () => {
    stub({
      campaign: sources([{ featureSlug: COLD, campaignId: "src-cold", running: true }]),
      budget: { dailyBudgetCents: null, today: { spentCents: "999999" } },
    });
    await expect(resolve()).resolves.toMatchObject({ kind: "source", campaignId: "src-cold" });
  });

  it("fails loud when campaign-service or billing cannot answer", async () => {
    const { SourceCampaignUnresolvedError } = await import("../../src/lib/source-campaign.js");
    stub({ campaign: { error: "boom" }, campaignStatus: 500 });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
    stub({ campaign: { unexpected: true } });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
    stub({ campaign: sources([{ featureSlug: COLD, campaignId: "src-cold", running: true }]), budget: { error: "x" }, budgetStatus: 502 });
    await expect(resolve()).rejects.toBeInstanceOf(SourceCampaignUnresolvedError);
  });
});
