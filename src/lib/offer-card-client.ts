/**
 * Name, for a set of lead rows, the OFFER each one belongs to — brand-service's proposition level,
 * which sits between the brand and the campaign (Org > Brand > Offer > Campaign).
 *
 * lead-service defines NONE of an offer's semantics and holds no offer column. The resolution is
 * the one offer scope already established next door (offer-campaigns-client.ts), read in the other
 * direction:
 *
 *     a lead's offer = the offer named by the campaign the lead was served under.
 *
 * `leads_campaigns.campaign_id` is that attribution, frozen at serve time, and campaign-service
 * records each campaign's offer (`campaigns.offer_id`). So a row's offer follows from a column the
 * row already carries — never re-derived from its brand, its funnel, or a sibling campaign, and
 * unaffected by the campaign being reconfigured afterwards, which is why the attribution was frozen
 * in the first place. The offer's NAME is brand-service's (`/internal/brands/{brandId}/offers`);
 * nothing is invented or cached here.
 *
 * PER REQUEST, NEVER PER ROW. A brand's leads list reaches tens of thousands of rows and is polled
 * every 30 seconds, so a lookup per row (or even per chunk) would be the whole cost of the feature.
 * Both reads are therefore memoized on this resolver, which the route builds once per request:
 *
 *   - ONE campaign-service `/campaigns` read for the org, whatever the row count. It answers
 *     campaign -> offer for every campaign in the org at once, exactly as the offer FILTER's read
 *     does, so a hundred chunks share one call.
 *   - ONE brand-service offers read per BRAND actually seen, and only for brands whose campaigns
 *     name an offer. A brand-scoped list — what the dashboard reads — is one call; an org-wide
 *     staff read is one per brand it actually returned rows for, not one per row.
 *
 * FAIL-SOFT, with a loud log, like the campaign IDENTITY resolver and unlike the offer FILTER.
 * The distinction is what the failure DOES. The filter decides which rows come back, so failing it
 * open would serve the whole brand's people under one offer's name — wrong data, so it 502s. This
 * decides what one DISPLAY field on a row says; unresolved, the field is absent and the row still
 * carries the `campaignId` the offer is derived from. Degraded, never wrong — and a read that works
 * today must not start failing because a field was added to it.
 *
 * So `offer` is null when the campaign names no offer AND when we could not ask, the second always
 * accompanied by a `console.error`. It is NEVER a guess: no brand, no funnel and no sibling
 * campaign is ever substituted for an offer the campaign did not itself name.
 */
import { messageOf } from "./db-error.js";
import {
  BRAND_SERVICE_URL,
  BRAND_SERVICE_API_KEY,
  CAMPAIGN_SERVICE_URL,
  CAMPAIGN_SERVICE_API_KEY,
} from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * The offer a lead belongs to, as a row states it.
 *
 * `name` is null when campaign-service names an offer that brand-service does not list back — a
 * deleted offer, or a brand we could not reach. The id is still true, so it is stated rather than
 * collapsing the whole card to null, which would say "this lead belongs to no offer".
 */
export interface OfferCard {
  id: string;
  name: string | null;
}

export interface OfferResolveContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

/** What campaign-service says about one campaign, trimmed to what naming an offer needs. */
interface CampaignOffer {
  offerId: string;
  /** The brand whose offer catalogue names it. null when the campaign states no brand. */
  brandId: string | null;
}

function serviceHeaders(apiKey: string, ctx: OfferResolveContext): Record<string, string> {
  const headers: Record<string, string> = {
    "X-API-Key": apiKey,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  return headers;
}

interface RawCampaign {
  id?: string;
  offerId?: string | null;
  brandIds?: string[] | null;
}

/**
 * campaign -> offer for the whole org, in ONE read.
 *
 * No `limit`: campaign-service returns every match when none is named, and a bounded read would
 * silently leave the org's older campaigns — the stopped rows that hold most of a brand's serve
 * history — unable to name their offer.
 */
async function fetchOrgCampaignOffers(
  ctx: OfferResolveContext,
): Promise<Map<string, CampaignOffer>> {
  const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns`, {
    method: "GET",
    headers: serviceHeaders(CAMPAIGN_SERVICE_API_KEY, ctx),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `campaign-service /campaigns failed (${response.status}): ${await response.text().catch(() => "")}`,
    );
  }

  const data = (await response.json()) as { campaigns?: RawCampaign[] };
  if (!Array.isArray(data?.campaigns)) {
    throw new Error("campaign-service /campaigns returned no campaigns array");
  }

  const byCampaignId = new Map<string, CampaignOffer>();
  for (const row of data.campaigns) {
    // A campaign that states no offer belongs to no offer. Strict — never inferred from a sibling.
    if (!row?.id || !row.offerId) continue;
    byCampaignId.set(row.id, { offerId: row.offerId, brandId: row.brandIds?.[0] ?? null });
  }
  return byCampaignId;
}

/** offer -> name for one brand's catalogue. */
async function fetchBrandOfferNames(
  brandId: string,
  ctx: OfferResolveContext,
): Promise<Map<string, string>> {
  const response = await fetchWithRetry(
    `${BRAND_SERVICE_URL}/internal/brands/${brandId}/offers`,
    {
      method: "GET",
      headers: serviceHeaders(BRAND_SERVICE_API_KEY, ctx),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) {
    throw new Error(
      `brand-service /internal/brands/${brandId}/offers failed (${response.status}): ${
        await response.text().catch(() => "")
      }`,
    );
  }

  const data = (await response.json()) as {
    offers?: Array<{ offerId?: string; name?: string }>;
  };
  if (!Array.isArray(data?.offers)) {
    throw new Error(`brand-service offers read for brand ${brandId} returned no offers array`);
  }

  const names = new Map<string, string>();
  for (const offer of data.offers) {
    if (offer?.offerId && typeof offer.name === "string") names.set(offer.offerId, offer.name);
  }
  return names;
}

export interface OfferCardResolver {
  /**
   * The offer card for each of `campaignIds` that names one. A campaign absent from the result
   * names no offer we can state; the caller renders that as `offer: null`.
   *
   * Safe to call once per chunk: the org's campaign -> offer read and each brand's offer catalogue
   * are fetched at most once for the lifetime of this resolver, so a second call over a second
   * chunk costs no network at all.
   */
  resolve(campaignIds: string[]): Promise<Map<string, OfferCard>>;
}

export function createOfferCardResolver(ctx: OfferResolveContext): OfferCardResolver {
  // Memoized PROMISES, not values: two chunks resolving concurrently share the one in-flight read
  // rather than racing into a second. Each failure is absorbed here, so it is logged once per
  // request and every later chunk gets the same (empty) answer instead of retrying the outage.
  let campaignOffers: Promise<Map<string, CampaignOffer>> | null = null;
  const offerNamesByBrand = new Map<string, Promise<Map<string, string>>>();

  function campaignOffersOnce(): Promise<Map<string, CampaignOffer>> {
    if (!campaignOffers) {
      campaignOffers = fetchOrgCampaignOffers(ctx).catch((error: Error) => {
        console.error(
          `[lead-service] offer unresolved for orgId=${ctx.orgId} — campaign-service could not say ` +
            `which offer each campaign sells, so leads carry no offer on this read (their campaignId ` +
            `is unchanged): ${messageOf(error)}`,
        );
        return new Map<string, CampaignOffer>();
      });
    }
    return campaignOffers;
  }

  function offerNamesOnce(brandId: string): Promise<Map<string, string>> {
    let names = offerNamesByBrand.get(brandId);
    if (!names) {
      names = fetchBrandOfferNames(brandId, ctx).catch((error: Error) => {
        console.error(
          `[lead-service] offer names unresolved for brandId=${brandId} orgId=${ctx.orgId} — ` +
            `leads carry their offer id with no name on this read: ${messageOf(error)}`,
        );
        return new Map<string, string>();
      });
      offerNamesByBrand.set(brandId, names);
    }
    return names;
  }

  return {
    async resolve(campaignIds: string[]): Promise<Map<string, OfferCard>> {
      const cards = new Map<string, OfferCard>();
      if (campaignIds.length === 0) return cards;

      const byCampaignId = await campaignOffersOnce();

      // Only the brands this chunk's campaigns actually name — an org-wide read never asks for a
      // brand it returned no rows for.
      const wanted = new Map<string, CampaignOffer>();
      const brandIds = new Set<string>();
      for (const campaignId of new Set(campaignIds)) {
        const offer = byCampaignId.get(campaignId);
        if (!offer) continue;
        wanted.set(campaignId, offer);
        if (offer.brandId) brandIds.add(offer.brandId);
      }
      if (wanted.size === 0) return cards;

      const namesByBrand = new Map<string, Map<string, string>>();
      await Promise.all(
        Array.from(brandIds).map(async (brandId) => {
          namesByBrand.set(brandId, await offerNamesOnce(brandId));
        }),
      );

      for (const [campaignId, offer] of wanted) {
        const name = offer.brandId ? namesByBrand.get(offer.brandId)?.get(offer.offerId) : undefined;
        cards.set(campaignId, { id: offer.offerId, name: name ?? null });
      }
      return cards;
    },
  };
}
