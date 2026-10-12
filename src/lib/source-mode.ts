import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import {
  LEAD_SOURCING_SLUG,
  SOURCE_LEG_KEY,
  SourceCampaignUnresolvedError,
  fetchCampaignSources,
  type CampaignSourceCampaigns,
} from "./source-campaign.js";

/**
 * EVERY PIPE IS INDEPENDENT OF THE OTHERS (owner 2026-10-12, LEADS-ONLY-FUNNEL-CAMPAIGN): a sourcing pipe FINDS leads
 * in its OWN runs, inside its funnel campaign's caps, never waiting for a later pipe to ask; each later pipe works what
 * the pipe before it produced. Same rule for every origin and every funnel: no per-channel branch.
 *
 * `POST /orgs/buffer/next` is ONE door with three modes, decided here from campaign-service's facts:
 *
 *   own_run — `x-campaign-id` IS a source unit (leg `start_to_lead_found`): its own run, dispatched by campaign-service.
 *             It finds a lead from its origin's audiences of the brand and offer and STORES it under the source
 *             campaign (`leads_campaigns.status_reason = 'source_found'`), contacting nobody (src/lib/buffer.ts).
 *   stock   — an outreach campaign fed by at least one RUNNING source that `runsOnItsOwn` (campaign-service, additive):
 *             it serves a lead those sources already found and nobody worked yet (src/lib/source-stock.ts); it never
 *             finds on demand from such a source. Empty stock = `source_stock_empty` (never exhaustion).
 *   today   — anything else, including `runsOnItsOwn` ABSENT or false: today's serve, byte-identical (the sources read
 *             is handed on to resolveServeSource, so nothing is read twice).
 *
 * The source-unit check reads campaign-service only for a channel shaped like a source (a `sourcing-*` origin or
 * Lead Sourcing); the leg on the campaign row is what decides, never the slug alone. Anything unreadable throws
 * (the serve setup answers 500 before anything is bought).
 */

const CALL_TIMEOUT_MS = 10_000;

export interface SourceUnit {
  id: string;
  /** The source's channel: a sourcing origin slug or `lead-sourcing`. */
  featureSlug: string;
  offerId: string;
  brandId: string;
  status: string;
}

export type SourceMode =
  | { kind: "own_run"; unit: SourceUnit }
  | { kind: "stock"; sourceCampaignIds: string[]; read: CampaignSourceCampaigns }
  | { kind: "today"; read: CampaignSourceCampaigns | null };

/** A channel a source campaign can carry: a sourcing origin, or Lead Sourcing (features-service's catalogue). */
export function isSourceChannelSlug(slug: string): boolean {
  return slug.startsWith("sourcing-") || slug === LEAD_SOURCING_SLUG;
}

/** The campaign row, when it is a lead SOURCE (leg `start_to_lead_found`); null otherwise. Throws when unreadable. */
export async function fetchSourceUnit(campaignId: string, orgId: string): Promise<SourceUnit | null> {
  const where = `campaign=${campaignId} org=${orgId}`;
  const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns/${encodeURIComponent(campaignId)}`, {
    headers: { "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SourceCampaignUnresolvedError(`campaign-service campaign read failed (${where}): ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { campaign?: Record<string, unknown> };
  const c = body.campaign;
  if (!c || typeof c !== "object") throw new SourceCampaignUnresolvedError(`campaign-service campaign answer unreadable (${where})`);
  if (c.legKey !== SOURCE_LEG_KEY) return null;
  const brandIds = Array.isArray(c.brandIds) ? (c.brandIds as unknown[]) : [];
  const brandId = typeof c.brandId === "string" ? c.brandId : typeof brandIds[0] === "string" ? (brandIds[0] as string) : null;
  if (typeof c.featureSlug !== "string" || typeof c.offerId !== "string" || !brandId || typeof c.status !== "string") {
    throw new SourceCampaignUnresolvedError(
      `source unit ${campaignId} states no channel, offer, brand or status (feature=${String(c.featureSlug)} offer=${String(c.offerId)} brand=${String(brandId)} status=${String(c.status)})`,
    );
  }
  return { id: campaignId, featureSlug: c.featureSlug, offerId: c.offerId, brandId, status: c.status };
}

export async function decideSourceMode(params: { orgId: string; campaignId: string; featureSlug: string }): Promise<SourceMode> {
  if (isSourceChannelSlug(params.featureSlug)) {
    const unit = await fetchSourceUnit(params.campaignId, params.orgId);
    if (unit) return { kind: "own_run", unit };
  }
  const read = await fetchCampaignSources(params.campaignId, params.orgId);
  const ownRun = read.sourced ? read.sourceCampaigns.filter((s) => s.running && s.runsOnItsOwn).map((s) => s.campaignId) : [];
  if (ownRun.length > 0) return { kind: "stock", sourceCampaignIds: [...new Set(ownRun)].sort(), read };
  return { kind: "today", read };
}
