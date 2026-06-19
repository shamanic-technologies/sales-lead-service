import { BRAND_SERVICE_URL, BRAND_SERVICE_API_KEY } from "../config.js";

export interface ExtractedField {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

type ServiceContext = {
  userId?: string | null;
  runId?: string | null;
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  goal?: string;
  activeGoalId?: string;
  brandProfileId?: string;
  customerPersonaId?: string;
  customerProfileId?: string;
};

function buildHeaders(orgId?: string | null, context?: ServiceContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BRAND_SERVICE_API_KEY,
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
  if (context?.customerPersonaId) headers["x-customer-persona-id"] = context.customerPersonaId;
  if (context?.customerProfileId) headers["x-customer-profile-id"] = context.customerProfileId;
  return headers;
}

export async function extractBrandFields(
  fields: Array<{ key: string; description: string }>,
  orgId?: string | null,
  context?: ServiceContext,
): Promise<ExtractedField[] | null> {
  try {
    const response = await fetch(`${BRAND_SERVICE_URL}/orgs/brands/extract-fields`, {
      method: "POST",
      headers: buildHeaders(orgId, context),
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const msg = `[brand-client] extract-fields failed: ${response.status}`;
      if (response.status >= 500) {
        throw new Error(msg);
      }
      console.warn(msg);
      return null;
    }

    const data = (await response.json()) as {
      brands: Array<{ brandId: string; domain: string; name: string }>;
      fields: Record<string, {
        value: string | string[] | Record<string, unknown> | null;
        byBrand: Record<string, {
          value: string | string[] | Record<string, unknown> | null;
          cached: boolean;
          extractedAt: string;
          expiresAt: string | null;
          sourceUrls: string[] | null;
        }>;
      }>;
    };

    // Transform new response shape back to ExtractedField[] for consumers
    return Object.entries(data.fields).map(([key, field]) => {
      const firstBrand = Object.values(field.byBrand)[0];
      return {
        key,
        value: field.value,
        cached: firstBrand?.cached ?? false,
        extractedAt: firstBrand?.extractedAt ?? new Date().toISOString(),
        expiresAt: firstBrand?.expiresAt ?? null,
        sourceUrls: firstBrand?.sourceUrls ?? null,
      };
    });
  } catch (error) {
    console.error("[brand-client] Error extracting brand fields:", error);
    throw error;
  }
}

export type CurrentGoal = "signup" | "meetingBooked" | "purchase";

/**
 * Fetch the brand's canonical current goal from brand-service.
 * The brand owns its goal (brands.currentGoal); lead-service reads it here
 * instead of taking it as an x-goal header. Fails loud on any non-2xx — a
 * brand with no goal set returns 404, and that is a config error (a brand in a
 * lead-finding workflow must have a goal), not an empty/exhausted result.
 */
export async function getCurrentGoal(
  brandId: string,
  orgId?: string | null,
  context?: ServiceContext,
): Promise<CurrentGoal> {
  const response = await fetch(`${BRAND_SERVICE_URL}/internal/brands/${brandId}/runtime-context`, {
    headers: buildHeaders(orgId, context),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `[brand-client] runtime-context failed for brand ${brandId}: ${response.status} ${text}`,
    );
  }
  const data = (await response.json()) as { currentGoal: CurrentGoal };
  return data.currentGoal;
}

export async function fetchExtractedFields(
  brandId: string,
  orgId?: string | null,
  context?: ServiceContext,
): Promise<ExtractedField[] | null> {
  try {
    const response = await fetch(`${BRAND_SERVICE_URL}/internal/brands/${brandId}/extracted-fields`, {
      headers: buildHeaders(orgId, context),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      const msg = `[brand-client] fetch extracted-fields failed for brand ${brandId}: ${response.status}`;
      if (response.status >= 500) {
        throw new Error(msg);
      }
      console.warn(msg);
      return null;
    }

    const data = (await response.json()) as { brandId: string; fields: ExtractedField[] };
    return data.fields;
  } catch (error) {
    console.error("[brand-client] Error fetching extracted fields:", error);
    throw error;
  }
}
