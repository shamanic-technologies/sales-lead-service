import { CHAT_SERVICE_URL, CHAT_SERVICE_API_KEY } from "../config.js";

export interface ChatCompleteParams {
  message: string;
  systemPrompt: string;
  provider: "google" | "anthropic";
  model: "flash" | "flash-lite" | "pro" | "sonnet" | "haiku" | "opus";
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
}

export interface ChatCompleteResult {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export interface ChatTrackingHeaders {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  campaignId?: string | null;
  brandId?: string | null;
  workflowSlug?: string | null;
  featureSlug?: string | null;
  goal?: string | null;
  activeGoalId?: string | null;
  brandProfileId?: string | null;
  customerPersonaId?: string | null;
  customerProfileId?: string | null;
}

export async function chatComplete(
  params: ChatCompleteParams,
  tracking: ChatTrackingHeaders,
): Promise<ChatCompleteResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": CHAT_SERVICE_API_KEY,
    "x-org-id": tracking.orgId,
  };
  if (tracking.userId) headers["x-user-id"] = tracking.userId;
  if (tracking.runId) headers["x-run-id"] = tracking.runId;
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.brandId) headers["x-brand-id"] = tracking.brandId;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.goal) headers["x-goal"] = tracking.goal;
  if (tracking.activeGoalId) headers["x-active-goal-id"] = tracking.activeGoalId;
  if (tracking.brandProfileId) headers["x-brand-profile-id"] = tracking.brandProfileId;
  if (tracking.customerPersonaId) headers["x-customer-persona-id"] = tracking.customerPersonaId;
  if (tracking.customerProfileId) headers["x-customer-profile-id"] = tracking.customerProfileId;

  const body: Record<string, unknown> = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
  };
  if (params.responseFormat) body.responseFormat = params.responseFormat;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.maxTokens !== undefined) body.maxTokens = params.maxTokens;
  if (params.thinkingBudget !== undefined) body.thinkingBudget = params.thinkingBudget;

  const response = await fetch(`${CHAT_SERVICE_URL}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[lead-service] chat-service POST /complete failed: ${response.status} ${text}`);
  }

  return (await response.json()) as ChatCompleteResult;
}
