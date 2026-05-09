import { CAMPAIGN_SERVICE_URL, CAMPAIGN_SERVICE_API_KEY } from "../config.js";

export interface CampaignDetails {
  id: string;
  name: string;
  targetAudience: string | null;
  targetOutcome: string | null;
  valueForTarget: string | null;
  featureInputs: Record<string, unknown> | null;
}

export async function fetchCampaign(
  campaignId: string,
  orgId?: string | null,
  context?: { userId?: string; runId?: string; campaignId?: string; brandId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<CampaignDetails | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": CAMPAIGN_SERVICE_API_KEY,
    };
    if (orgId) headers["x-org-id"] = orgId;
    if (context?.userId) headers["x-user-id"] = context.userId;
    if (context?.runId) headers["x-run-id"] = context.runId;
    if (context?.campaignId) headers["x-campaign-id"] = context.campaignId;
    if (context?.brandId) headers["x-brand-id"] = context.brandId;
    if (context?.workflowSlug) headers["x-workflow-slug"] = context.workflowSlug;
    if (context?.featureSlug) headers["x-feature-slug"] = context.featureSlug;

    const response = await fetch(`${CAMPAIGN_SERVICE_URL}/campaigns/${campaignId}`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      const msg = `[campaign-client] Failed to fetch campaign ${campaignId}: ${response.status}`;
      if (response.status >= 500) {
        throw new Error(msg);
      }
      console.warn(msg);
      return null;
    }

    const data = (await response.json()) as { campaign: CampaignDetails };
    return data.campaign;
  } catch (error) {
    console.error("[campaign-client] Error fetching campaign:", error);
    throw error;
  }
}
