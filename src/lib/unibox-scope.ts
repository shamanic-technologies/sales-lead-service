/**
 * The Unibox narrowed to one OFFER of the brand and/or one CAMPAIGN (DEALS-LIFECYCLE-1021, owner 2026-10-21: the
 * customer's Deals board is opened per brand with an offer selected, optionally one campaign). A person belongs to the
 * scope when they are a lead (`leads_campaigns` row, any status) on any campaign id the scope resolves to; the row,
 * its six tags and its Lifecycle are the brand's, unchanged (see `filterSql`).
 *
 * Every campaign id is read from campaign-service (org-scoped `GET /campaigns`), never inferred:
 *   - offer: every campaign row naming that offer (`offerId`, as `offer-campaigns-client.ts`).
 *   - campaign: the campaign, the pipes it groups (`campaign-names-client.ts`, the one reader of how campaign-service
 *     groups pipes), and every stored row of each one's IDENTITY (`campaign-identity.ts`: one campaign = several rows).
 *   - both: the campaign's ids that sell the offer (a campaign of another offer = nobody).
 * FAIL LOUD: campaign-service unreadable = `UniboxScopeUnavailableError` (the route answers 502), never the whole
 * brand under an offer's name, never an empty board read as "nobody".
 */
import { fetchOrgCampaignRows, type CampaignIdentityContext } from "./campaign-identity-client.js";
import { buildCampaignFamilies, type CampaignIdentityRow } from "./campaign-identity.js";
import { loadCampaignDisplays } from "./campaign-names-client.js";

export class UniboxScopeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniboxScopeUnavailableError";
  }
}

/** Pure: the campaign ids of the scope over the org's campaign rows. */
export function uniboxScopeCampaignIds(
  rows: readonly CampaignIdentityRow[],
  scope: { offerId?: string; campaignId?: string },
  /** The pipe campaign ids the named campaign groups (none = a campaign of no group). */
  pipesOfCampaign: readonly string[] = [],
): string[] {
  let ids: Set<string> | null = null;
  if (scope.campaignId) {
    const c = scope.campaignId;
    const families = buildCampaignFamilies([...rows]);
    const seeds = new Set<string>([c]);
    for (const id of pipesOfCampaign) seeds.add(id);
    ids = new Set<string>();
    for (const seed of seeds) for (const id of families.familyOf(seed)) ids.add(id);
  }
  if (scope.offerId) {
    const o = scope.offerId;
    const ofOffer = new Set(rows.filter((r) => r?.id && r.offerId === o).map((r) => r.id));
    ids = ids === null ? ofOffer : new Set([...ids].filter((id) => ofOffer.has(id)));
  }
  return ids === null ? [] : [...ids].sort();
}

/** The campaign ids the scope reads; undefined = no offer/campaign named (the brand's whole Unibox). */
export async function resolveUniboxScope(
  ctx: CampaignIdentityContext,
  scope: { offerId?: string; campaignId?: string },
): Promise<string[] | undefined> {
  if (!scope.offerId && !scope.campaignId) return undefined;
  let rows: CampaignIdentityRow[];
  const pipes: string[] = [];
  try {
    const campaignId = scope.campaignId;
    const [orgRows, displays] = await Promise.all([
      fetchOrgCampaignRows(ctx),
      campaignId && ctx.brandId ? loadCampaignDisplays(ctx.orgId, ctx.brandId) : Promise.resolve(null),
    ]);
    rows = orgRows;
    if (displays && campaignId) for (const [id, d] of displays) if (d.id === campaignId && id !== campaignId) pipes.push(id);
  } catch (error) {
    throw new UniboxScopeUnavailableError(
      `campaign-service unreadable, so the campaigns of offer=${scope.offerId ?? "-"} campaign=${scope.campaignId ?? "-"} are unknown: ${(error as Error).message}`,
    );
  }
  return uniboxScopeCampaignIds(rows, scope, pipes);
}
