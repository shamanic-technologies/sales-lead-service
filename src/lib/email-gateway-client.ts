import { EMAIL_GATEWAY_SERVICE_URL, EMAIL_GATEWAY_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export interface DeliveryStatusItem {
  email: string;
}

export interface ScopedStatus {
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  replied: boolean;
  replyClassification: "positive" | "negative" | "neutral" | null;
  bounced: boolean;
  unsubscribed: boolean;
  lastDeliveredAt: string | null;
}

export interface GlobalStatus {
  email: {
    bounced: boolean;
    unsubscribed: boolean;
  };
}

export interface ProviderStatus {
  campaign?: ScopedStatus | null;
  brand?: ScopedStatus | null;
  byCampaign?: Record<string, ScopedStatus> | null;
  global?: GlobalStatus;
}

export interface StatusResult {
  email: string;
  broadcast?: ProviderStatus;
  transactional?: ProviderStatus;
}

export interface DeliveryStatusResponse {
  results: StatusResult[];
}

const BATCH_SIZE = 100;

async function checkDeliveryStatusBatch(
  brandId: string,
  campaignId: string | undefined,
  items: DeliveryStatusItem[],
  headers: Record<string, string>,
): Promise<DeliveryStatusResponse> {
  const body: Record<string, unknown> = { brandId, items };
  if (campaignId) body.campaignId = campaignId;

  const response = await fetchWithRetry(`${EMAIL_GATEWAY_SERVICE_URL}/orgs/status`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[email-gateway-client] Status check failed: ${response.status} - ${error}`
    );
  }

  return (await response.json()) as DeliveryStatusResponse;
}

interface ServiceContext {
  orgId?: string;
  userId?: string;
  runId?: string;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  goal?: string;
  activeGoalId?: string;
  brandProfileId?: string;
  customerPersonaId?: string;
  audienceId?: string;
}

function addContextHeaders(headers: Record<string, string>, context?: ServiceContext): void {
  if (context?.orgId) headers["x-org-id"] = context.orgId;
  if (context?.userId) headers["x-user-id"] = context.userId;
  if (context?.runId) headers["x-run-id"] = context.runId;
  if (context?.campaignId) headers["x-campaign-id"] = context.campaignId;
  if (context?.brandId) headers["x-brand-id"] = context.brandId;
  if (context?.workflowSlug) headers["x-workflow-slug"] = context.workflowSlug;
  if (context?.featureSlug) headers["x-feature-slug"] = context.featureSlug;
  if (context?.goal) headers["x-goal"] = context.goal;
  if (context?.activeGoalId) headers["x-active-goal-id"] = context.activeGoalId;
  if (context?.brandProfileId) headers["x-brand-profile-id"] = context.brandProfileId;
  if (context?.customerPersonaId) headers["x-customer-persona-id"] = context.customerPersonaId;
  if (context?.audienceId) headers["x-audience-id"] = context.audienceId;
}

export async function checkDeliveryStatus(
  brandId: string,
  campaignId: string | undefined,
  items: DeliveryStatusItem[],
  context?: ServiceContext,
): Promise<DeliveryStatusResponse> {
  if (items.length === 0) return { results: [] };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY,
  };
  addContextHeaders(headers, context);

  if (items.length <= BATCH_SIZE) {
    return await checkDeliveryStatusBatch(brandId, campaignId, items, headers);
  }

  const batches: DeliveryStatusItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  const batchResults = await Promise.all(
    batches.map((batch) => checkDeliveryStatusBatch(brandId, campaignId, batch, headers))
  );

  const allResults: StatusResult[] = [];
  for (const result of batchResults) {
    allResults.push(...result.results);
  }

  return { results: allResults };
}

/** Stats from email-gateway GET /orgs/stats */
export interface RecipientStats {
  contacted: number;
  sent: number;
  delivered: number;
  opened: number;
  bounced: number;
  clicked: number;
  unsubscribed: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
  repliesAutoReply: number;
  repliesDetail: {
    interested: number;
    meetingBooked: number;
    closed: number;
    notInterested: number;
    wrongPerson: number;
    unsubscribe: number;
    neutral: number;
    autoReply: number;
    outOfOffice: number;
  };
}

export interface EmailGatewayStatsResponse {
  transactional?: { recipientStats: RecipientStats };
  broadcast?: { recipientStats: RecipientStats };
}

export interface EmailGatewayGroupedStatsResponse {
  groups: Array<{
    key: string;
    transactional?: { recipientStats: RecipientStats };
    broadcast?: { recipientStats: RecipientStats };
  }>;
}

export async function fetchEmailGatewayStats(
  params: {
    brandId?: string;
    campaignId?: string;
    workflowSlugs?: string;
    featureSlugs?: string;
    groupBy?: string;
  },
  context?: ServiceContext,
): Promise<EmailGatewayStatsResponse | EmailGatewayGroupedStatsResponse> {
  const queryParams = new URLSearchParams();
  if (params.brandId) queryParams.set("brandId", params.brandId);
  if (params.campaignId) queryParams.set("campaignId", params.campaignId);
  if (params.workflowSlugs) queryParams.set("workflowSlugs", params.workflowSlugs);
  if (params.featureSlugs) queryParams.set("featureSlugs", params.featureSlugs);
  if (params.groupBy) queryParams.set("groupBy", params.groupBy);

  const headers: Record<string, string> = {
    "X-API-Key": EMAIL_GATEWAY_SERVICE_API_KEY,
  };
  addContextHeaders(headers, context);

  const qs = queryParams.toString();
  const url = `${EMAIL_GATEWAY_SERVICE_URL}/orgs/stats${qs ? `?${qs}` : ""}`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `[email-gateway-client] Stats fetch failed: ${response.status} - ${error}`
    );
  }

  return response.json();
}

export interface EmailCheckResult {
  contacted: boolean;
  bounced: boolean;
  unsubscribed: boolean;
}

/**
 * Check if a status result indicates the lead/email has already been contacted
 * via any provider (broadcast or transactional) at any scope (campaign, brand, or global).
 */
export function isContacted(result: StatusResult): boolean {
  return checkEmailStatus(result).contacted;
}

/**
 * Full status check: contacted, bounced, and unsubscribed.
 */
export function checkEmailStatus(result: StatusResult): EmailCheckResult {
  const bc = result.broadcast;
  const tx = result.transactional;

  let contacted = false;
  let bounced = false;
  let unsubscribed = false;

  // Bounce & unsub — global scope (all brands, all orgs)
  if (bc?.global?.email?.bounced || tx?.global?.email?.bounced) bounced = true;
  if (bc?.global?.email?.unsubscribed || tx?.global?.email?.unsubscribed) unsubscribed = true;

  // Contacted — any scope (campaign, brand, global)
  if (
    bc?.campaign?.contacted ||
    bc?.brand?.contacted ||
    tx?.campaign?.contacted ||
    tx?.brand?.contacted
  ) contacted = true;

  // Check byCampaign breakdown (populated in brand-only mode)
  if (!contacted) {
    for (const provider of [bc, tx]) {
      if (provider?.byCampaign) {
        for (const status of Object.values(provider.byCampaign)) {
          if (status.contacted) {
            contacted = true;
            break;
          }
        }
        if (contacted) break;
      }
    }
  }

  return { contacted, bounced, unsubscribed };
}
