import { CAMPAIGN_SERVICE_URL, CAMPAIGN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export interface CampaignDetails {
  id: string;
  name: string;
  targetAudience: string | null;
  targetOutcome: string | null;
  valueForTarget: string | null;
  featureInputs: Record<string, unknown> | null;
  /**
   * The brand-service offer this campaign sells (campaign-service `campaigns.offer_id`).
   * Null = the campaign states no offer (pre-offer campaigns, non-offer channels).
   * Names WHICH offer's per-offer brand reads answer for — a brand selling several
   * offers refuses brand-scoped reads with 409 SEVERAL_OFFERS.
   */
  offerId: string | null;
}

export async function fetchCampaign(
  campaignId: string,
  orgId?: string | null,
  context?: {
    userId?: string | null;
    runId?: string | null;
    campaignId?: string | null;
    brandId?: string | null;
    workflowSlug?: string | null;
    featureSlug?: string | null;
    goal?: string | null;
    activeGoalId?: string | null;
    brandProfileId?: string | null;
    audienceId?: string | null;
  }
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
    if (context?.goal) headers["x-goal"] = context.goal;
    if (context?.activeGoalId) headers["x-active-goal-id"] = context.activeGoalId;
    if (context?.brandProfileId) headers["x-brand-profile-id"] = context.brandProfileId;
    if (context?.audienceId) headers["x-audience-id"] = context.audienceId;

    // Connect-phase retry, not a raw `fetch`: this read sits on the serve path
    // (`pullNext` names the campaign's offer on the goal read from it), so a
    // sibling mid-restart resetting the connection would otherwise drop the
    // offer and send a multi-offer brand's serve back into brand-service's
    // SEVERAL_OFFERS refusal. The retry is write-safe — a connect-phase
    // rejection never reached the server. The 5s budget stays deliberate (a DAG
    // retry must not wait minutes on a hung campaign-service) and bounds the
    // retries with it: the backoff is shared with the request's own deadline,
    // so an exhausted budget degrades to exactly today's behaviour.
    const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns/${campaignId}`, {
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
