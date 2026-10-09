/**
 * Resolve the campaign IDENTITY a campaign id belongs to — the family of stored campaign rows a
 * customer reads as ONE campaign (see campaign-identity.ts).
 *
 * campaign-service OWNS that identity and stores all four of its parts on every row since its
 * migration 0044, so nothing is re-derived here. The read is ORG-scoped, never brand-scoped: the
 * brand filter matches on the legacy `brand_ids` array, and a member that carries the brand only in
 * the `brand_id` column would drop out of the answer — a PARTIAL family, which is the one outcome
 * worse than not widening at all. Grouping keys on the brand anyway, so an org-wide read can never
 * pull a neighbouring brand's campaigns into the family.
 *
 * FAIL-SOFT, with a loud log. The family decides how a campaign-scoped read is TOTALLED, not what
 * any row says: with campaign-service unreachable the scope falls back to the single requested
 * campaign id, which is exactly the behaviour this read had before. That degrades the grouping (the
 * customer sees one stored row again for as long as the outage lasts) and never fabricates a
 * figure — the opposite of what the fail-loud rule targets. It is never widened to the brand.
 */
import { CAMPAIGN_SERVICE_URL, CAMPAIGN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { buildCampaignFamilies, type CampaignIdentityRow } from "./campaign-identity.js";
import { noteLegacyOutboundLegKey } from "./leg-identity.js";

export interface CampaignIdentityContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

export async function fetchOrgCampaignFamilies(ctx: CampaignIdentityContext) {
  const headers: Record<string, string> = {
    "X-API-Key": CAMPAIGN_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[campaign-identity-client] campaign-service /campaigns failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as { campaigns?: CampaignIdentityRow[] };
  if (!Array.isArray(data.campaigns)) {
    throw new Error("[campaign-identity-client] campaign-service /campaigns returned no campaigns array");
  }

  for (const row of data.campaigns) noteLegacyOutboundLegKey(row?.featureSlug, row?.legKey, "campaign-service GET /campaigns");
  return buildCampaignFamilies(data.campaigns);
}

/**
 * Every campaign id a campaign-scoped read must total, ascending. Always contains `campaignId`
 * itself, and is `[campaignId]` alone whenever the identity cannot be resolved — never a partial
 * family, never the brand.
 */
export async function resolveCampaignFamily(
  campaignId: string,
  ctx: CampaignIdentityContext,
): Promise<string[]> {
  try {
    const families = await fetchOrgCampaignFamilies(ctx);
    const family = families.familyOf(campaignId);
    if (!families.byCampaignId.has(campaignId)) {
      console.warn(
        `[lead-service] campaign identity unresolved for campaignId=${campaignId} orgId=${ctx.orgId} ` +
          `(campaign-service does not know it, or it states no brand/acquisition channel) — ` +
          `campaign-scoped read stays on the single stored row.`,
      );
    }
    return family;
  } catch (error) {
    console.error(
      `[lead-service] campaign identity unavailable for campaignId=${campaignId} orgId=${ctx.orgId} — ` +
        `campaign-scoped read falls back to the single stored row (its totals will be smaller than ` +
        `the identity's): ${(error as Error).message}`,
    );
    return [campaignId];
  }
}
