import { BRAND_SERVICE_URL, BRAND_SERVICE_API_KEY } from "../config.js";

export interface ExtractedField {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  cached: boolean;
  extractedAt: string;
  expiresAt: string | null;
  sourceUrls: string[] | null;
}

type ServiceContext = { userId?: string; runId?: string; campaignId?: string; brandId?: string; workflowSlug?: string; featureSlug?: string };

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
