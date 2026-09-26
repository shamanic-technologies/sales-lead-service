/**
 * Resolve the campaigns that sell one OFFER — brand-service's proposition level, which sits
 * between the brand and the campaign (Org > Brand > Offer > Campaign).
 *
 * lead-service defines NONE of an offer's semantics. It holds no offer column and never will:
 * what a lead's offer IS follows from what this service already froze on its own rows. A lead is
 * served under a CAMPAIGN, and `leads_campaigns.campaign_id` records which one, permanently. A
 * campaign names its offer (campaign-service, `campaigns.offer_id`). So:
 *
 *     a lead's offer = the offer named by the campaign the lead was served under.
 *
 * That is the same shape the campaign narrowing already has — resolve a set of campaign ids from
 * campaign-service, then filter the frozen `campaign_id` on it — so offer scope reuses the
 * campaign-id filter rather than adding a second, parallel one. It also survives a campaign being
 * reconfigured later: the membership row keeps pointing at the campaign it was actually served
 * under, whatever that campaign is switched to afterwards, which is exactly why the attribution
 * was frozen in the first place.
 *
 * FAIL LOUD, unlike the campaign IDENTITY read next door. That one is fail-soft because its
 * failure mode is a NARROWER answer (the single stored campaign row) — degraded, never wrong.
 * This one's failure mode is the opposite: with no campaign ids to filter on, the read would fall
 * back to the whole BRAND, which is the precise bug offer scope exists to fix — one brand's two
 * offers showing the same people. So an unreachable campaign-service is an error the caller is
 * told about, never a silently widened list.
 *
 * An offer that resolves to ZERO campaigns is NOT a failure: it is a real, correct answer for an
 * offer nothing has been run for yet, and it returns an empty list rather than the brand's.
 *
 * The read is ORG-scoped, and the offer id is NOT validated against brand-service. Nothing in this
 * service validates a caller-supplied entity id against its owning service (`brandId` and
 * `campaignId` are both taken as given and used as filters), and an offer no campaign names is
 * indistinguishable from an offer with no campaigns yet — both are honestly empty.
 */
import { CAMPAIGN_SERVICE_URL, CAMPAIGN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export interface OfferCampaignContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

/** A campaign row as campaign-service serves it, trimmed to what an offer scope needs. */
export interface OfferCampaignRow {
  id: string;
  /** The offer the campaign sells. NULL is a real state — a campaign that names none. */
  offerId?: string | null;
}

/**
 * campaign-service could not answer, so which campaigns sell this offer is UNKNOWN. The route
 * turns this into a 502: the alternative is returning the brand's leads under an offer's name.
 */
export class OfferCampaignsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferCampaignsUnavailableError";
  }
}

/**
 * Every campaign id in the org that names `offerId`, ascending.
 *
 * Membership is strict equality on the offer the campaign itself states — never inferred from a
 * sibling campaign or a brand. A campaign that states no offer belongs to no offer.
 * (Checked against production 2026-08-19: no campaign identity is split across offer-carrying and
 * offer-less rows, so this does not under-count relative to a campaign-scoped read of the same
 * population.)
 */
export async function resolveOfferCampaignIds(
  offerId: string,
  ctx: OfferCampaignContext,
): Promise<string[]> {
  const headers: Record<string, string> = {
    "X-API-Key": CAMPAIGN_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  let response: Response;
  try {
    // No `limit`: campaign-service returns every match when none is named, and a bounded read
    // would silently drop the offer's older campaigns — the stopped rows that hold most of a
    // brand's serve history.
    response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OfferCampaignsUnavailableError(
      `campaign-service is unreachable, so the campaigns selling offer ${offerId} are unknown: ${
        (error as Error).message
      }`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new OfferCampaignsUnavailableError(
      `campaign-service /campaigns failed (${response.status}), so the campaigns selling offer ${offerId} are unknown: ${body}`,
    );
  }

  let data: { campaigns?: OfferCampaignRow[] };
  try {
    data = (await response.json()) as { campaigns?: OfferCampaignRow[] };
  } catch (error) {
    throw new OfferCampaignsUnavailableError(
      `campaign-service /campaigns returned an unreadable body, so the campaigns selling offer ${offerId} are unknown: ${
        (error as Error).message
      }`,
    );
  }

  if (!Array.isArray(data?.campaigns)) {
    throw new OfferCampaignsUnavailableError(
      `campaign-service /campaigns returned no campaigns array, so the campaigns selling offer ${offerId} are unknown`,
    );
  }

  const ids = new Set<string>();
  for (const row of data.campaigns) {
    if (!row?.id || row.offerId !== offerId) continue;
    ids.add(row.id);
  }
  return Array.from(ids).sort();
}
