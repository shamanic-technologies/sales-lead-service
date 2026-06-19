import { FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY } from "../config.js";
import type { ServiceContext } from "./people-client.js";

/**
 * Client for features-service persona-stats.
 *
 * The most-relevant audience for a (brand, feature, goal) is the top row of
 * GET /features/{featureSlug}/persona-stats?brandId=&goal=&status=active&limit=1.
 * That row's `customerProfileId` IS the human-service audience id. An empty
 * `personas` array means there is no audience for the brand/goal — returned as
 * null (a clean "no audience", NOT a silent fallback).
 */

function buildHeaders(ctx: ServiceContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": FEATURES_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  if (ctx.goal) headers["x-goal"] = ctx.goal;
  if (ctx.activeGoalId) headers["x-active-goal-id"] = ctx.activeGoalId;
  if (ctx.brandProfileId) headers["x-brand-profile-id"] = ctx.brandProfileId;
  if (ctx.customerPersonaId) headers["x-customer-persona-id"] = ctx.customerPersonaId;
  if (ctx.customerProfileId) headers["x-customer-profile-id"] = ctx.customerProfileId;
  return headers;
}

interface PersonaStatsResponse {
  personas: Array<{ customerProfileId: string }>;
}

/**
 * Fetch the most-relevant audience id for a (brand, feature, goal).
 * Returns the top persona-stats row's customerProfileId, or null when there is
 * no active audience for that brand/goal. Fails loud on any non-2xx.
 */
export async function getTopAudienceId(params: {
  featureSlug: string;
  brandId: string;
  goal: string;
  ctx: ServiceContext;
}): Promise<string | null> {
  const query = new URLSearchParams({
    brandId: params.brandId,
    goal: params.goal,
    status: "active",
    limit: "1",
  }).toString();
  const url = `${FEATURES_SERVICE_URL}/features/${encodeURIComponent(params.featureSlug)}/persona-stats?${query}`;

  const response = await fetch(url, {
    headers: buildHeaders(params.ctx),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[lead-service] features persona-stats failed: ${response.status} ${text}`,
    );
  }

  const data = (await response.json()) as PersonaStatsResponse;
  return data.personas[0]?.customerProfileId ?? null;
}
