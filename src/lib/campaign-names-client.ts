/**
 * What a customer calls each campaign (UNIBOX-SIX-TAGS-1017, lead card): a part campaign (one pipe of a sales funnel)
 * is shown as its SALES FUNNEL campaign, the one the customer launched and names; a campaign of no funnel keeps its
 * own name. Read from campaign-service, never inferred. Unreachable = thrown (the card read 500s), never nameless.
 */
import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export interface CampaignDisplay {
  /** The funnel campaign id when the campaign is a unit of one, else the campaign's own id. */
  id: string;
  name: string;
  salesFunnelCampaignId: string | null;
}

async function getJson<T>(path: string, orgId: string): Promise<T> {
  const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}${path}`, {
    method: "GET",
    headers: { "X-API-Key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`[campaign-names-client] campaign-service ${path} failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as T;
}

/** Every campaign of the brand -> how the customer sees it. */
export async function loadCampaignDisplays(orgId: string, brandId: string): Promise<Map<string, CampaignDisplay>> {
  const q = `brandId=${encodeURIComponent(brandId)}`;
  const [funnels, campaigns] = await Promise.all([
    getJson<{ salesFunnelCampaigns?: Array<{ id: string; salesFunnelName: string; units?: Array<{ campaignId: string }> }> }>(`/sales-funnel-campaigns?${q}`, orgId),
    getJson<{ campaigns?: Array<{ id: string; name: string; salesFunnelCampaignId?: string | null }> }>(`/campaigns?${q}`, orgId),
  ]);
  if (!Array.isArray(funnels.salesFunnelCampaigns) || !Array.isArray(campaigns.campaigns)) {
    throw new Error("[campaign-names-client] campaign-service answered without salesFunnelCampaigns / campaigns");
  }
  const out = new Map<string, CampaignDisplay>();
  for (const c of campaigns.campaigns) out.set(c.id, { id: c.id, name: c.name, salesFunnelCampaignId: null });
  for (const f of funnels.salesFunnelCampaigns) {
    const display = { id: f.id, name: f.salesFunnelName, salesFunnelCampaignId: f.id };
    out.set(f.id, display);
    for (const u of f.units ?? []) out.set(u.campaignId, display);
  }
  return out;
}
