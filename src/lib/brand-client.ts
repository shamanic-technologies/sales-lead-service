import { BRAND_SERVICE_URL, BRAND_SERVICE_API_KEY } from "../config.js";
import { fetchCampaign } from "./campaign-client.js";

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
  audienceId?: string;
  offerId?: string;
};

/**
 * Per-brand configuration (the goal a brand optimizes for, its sales economics,
 * its funnels, its confirmed fields) is the data of an (org, brand) PAIR, not of
 * the brand id alone: a brand row is a shared global identity, so several orgs
 * can claim the same domain and legitimately optimize for different things.
 * Every brand-service read below therefore names the org whose configuration it
 * wants. A missing org is a caller bug, not a case to guess through — brand
 * routes here are only reachable from org-scoped, `requireOrgId` handlers.
 */
function buildHeaders(orgId: string, context?: ServiceContext): Record<string, string> {
  if (!orgId) {
    throw new Error(
      "[brand-client] orgId is required: per-brand configuration is owned by an (org, brand) pair and brand-service cannot resolve it for a brand claimed by several orgs",
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BRAND_SERVICE_API_KEY,
    "x-org-id": orgId,
  };
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
  return headers;
}

export async function extractBrandFields(
  fields: Array<{ key: string; description: string }>,
  orgId: string,
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
 * Fetch the brand's canonical current goal from brand-service, for the org that
 * owns this configuration.
 *
 * The (org, brand) pair owns the goal (brands.currentGoal); lead-service reads
 * it here instead of taking it as an x-goal header. `orgId` is required and
 * always sent: brand-service refuses to guess for a brand claimed by several
 * orgs, so an org-less read fails there rather than returning another org's
 * goal. Fails loud on any non-2xx — a brand with no goal set returns 404, and
 * that is a config error (a brand in a lead-finding workflow must have a goal),
 * not an empty/exhausted result.
 */
export async function getCurrentGoal(
  brandId: string,
  orgId: string,
  context?: ServiceContext,
): Promise<CurrentGoal> {
  try {
    return await fetchCurrentGoal(brandId, orgId, context);
  } catch (error) {
    // A brand selling SEVERAL offers refuses every brand-scoped read with 409
    // SEVERAL_OFFERS: each offer carries its own value proposition and economics, so
    // brand-service will not pick between them. The DAG knows the campaign this run
    // serves, and a campaign sells exactly ONE offer — so name the CAMPAIGN's offer
    // and the read answers. Only a campaign that states no offer leaves the refusal
    // standing (fail loud, never a guessed offer).
    if (!isSeveralOffersRefusal(error) || !context?.campaignId) throw error;
    const campaign = await fetchCampaign(context.campaignId, orgId, context);
    const offerId = campaign?.offerId;
    if (!offerId) {
      throw new Error(
        `[brand-client] brand ${brandId} sells several offers and campaign ${context.campaignId} states none — ` +
          "the goal read has no single answer; name the offer the campaign sells",
      );
    }
    return await fetchCurrentGoal(brandId, orgId, context, offerId);
  }
}

function isSeveralOffersRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("409") && message.includes("SEVERAL_OFFERS");
}

async function fetchCurrentGoal(
  brandId: string,
  orgId: string,
  context?: ServiceContext,
  offerId?: string,
): Promise<CurrentGoal> {
  const url = new URL(`${BRAND_SERVICE_URL}/internal/brands/${brandId}/runtime-context`);
  if (offerId) url.searchParams.set("offerId", offerId);
  const response = await fetch(url, {
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
  orgId: string,
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
