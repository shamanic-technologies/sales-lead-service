import { LEAD_SOURCING_SLUG, SourceCampaignUnresolvedError, fetchLeadSourcingChoice } from "./source-campaign.js";
import { fetchSourceUnit, type SourceUnit } from "./source-mode.js";
import { fetchAudienceOfferId, fetchAudienceOriginSlug } from "./sourcing-origin.js";

/**
 * DOES A FIND BELONG TO THE SOURCE THAT HOLDS IT? (LEAK-1012 part 2, 2026-10-13)
 *
 * A source unit's own run may only find in the audiences of its own origin and offer
 * (src/lib/source-audiences.ts). Finds made before that rule held (Apollo prospects under a CRM-contacts unit, the email
 * funnel's CRM people under the WhatsApp funnel's unit) still sat in the stock, waiting to be handed. So the SAME rules
 * are asked again of every stocked find, at handover (src/lib/source-stock.ts) and on demand over a whole stock
 * (src/lib/source-stock-recheck.ts):
 *   1. the audience belongs to the unit's OFFER (human-service `audience.offerId`);
 *   2. its OWN list is the unit's origin (asked with no channel: LEAK-1012), or one Lead Sourcing chose for the brand.
 * WHO among those people a source finds is its pipe's LEAD STRATEGY, stated by the workflow it runs (`reachableBy` on
 * buffer/next, owner 2026-10-14), never a per-campaign audience pick: the campaign `audienceIds` rule once here is gone.
 * A find that fails one is not this source's: it is set aside with the reason, never handed. Whether the audience is
 * still ACTIVE is deliberately not asked: a paused audience is the customer pausing, not a find made in error.
 * Anything unreadable throws (nothing is handed, nothing set aside).
 */

export type SourceBelongsVerdict = { belongs: true } | { belongs: false; reason: string };

export interface AudienceFacts {
  id: string;
  /** null = brand-wide (states no offer). */
  offerId: string | null;
  /** The origin of the audience's OWN list; null = it serves from no list. */
  originSlug: string | null;
}

/** Pure: the two rules, offer first, then origin. */
export function judgeAudienceForSource(
  unit: Pick<SourceUnit, "id" | "featureSlug" | "offerId">,
  chosenOrigins: ReadonlySet<string>,
  audience: AudienceFacts,
): SourceBelongsVerdict {
  if (audience.offerId !== unit.offerId) {
    return {
      belongs: false,
      reason: `Found in audience ${audience.id}, which belongs to ${audience.offerId ? `offer ${audience.offerId}` : "no offer"}; source ${unit.id} finds for offer ${unit.offerId}`,
    };
  }
  if (audience.originSlug === null || !chosenOrigins.has(audience.originSlug)) {
    return {
      belongs: false,
      reason: `Found in audience ${audience.id}, whose own list is ${audience.originSlug ?? "none"}; source ${unit.id} (${unit.featureSlug}) finds from ${[...chosenOrigins].sort().join(", ") || "no origin"}`,
    };
  }
  return { belongs: true };
}

export type SourceAudienceJudge = (sourceCampaignId: string, audienceId: string) => Promise<SourceBelongsVerdict>;

/** A judge that reads each unit and audience once (campaign-service, human-service). */
export function createSourceAudienceJudge(ctx: { orgId: string; userId?: string | null; runId?: string | null }): SourceAudienceJudge {
  const units = new Map<string, Promise<{ unit: SourceUnit; chosen: Set<string> }>>();
  const audiences = new Map<string, Promise<AudienceFacts>>();

  const unitOf = (sourceCampaignId: string) => {
    let p = units.get(sourceCampaignId);
    if (!p) {
      p = (async () => {
        const unit = await fetchSourceUnit(sourceCampaignId, ctx.orgId);
        if (!unit) throw new SourceCampaignUnresolvedError(`campaign ${sourceCampaignId} is not a source unit (org=${ctx.orgId})`);
        const chosen =
          unit.featureSlug === LEAD_SOURCING_SLUG
            ? await fetchLeadSourcingChoice({ orgId: ctx.orgId, brandId: unit.brandId, offerId: unit.offerId, userId: ctx.userId, runId: ctx.runId })
            : new Set([unit.featureSlug]);
        return { unit, chosen };
      })();
      units.set(sourceCampaignId, p);
    }
    return p;
  };

  const audienceOf = (audienceId: string) => {
    let p = audiences.get(audienceId);
    if (!p) {
      p = (async () => {
        const [offerId, originSlug] = await Promise.all([
          fetchAudienceOfferId(audienceId, ctx.orgId),
          fetchAudienceOriginSlug(audienceId, ctx.orgId, null),
        ]);
        return { id: audienceId, offerId, originSlug };
      })();
      audiences.set(audienceId, p);
    }
    return p;
  };

  return async (sourceCampaignId, audienceId) => {
    const [{ unit, chosen }, audience] = await Promise.all([unitOf(sourceCampaignId), audienceOf(audienceId)]);
    return judgeAudienceForSource(unit, chosen, audience);
  };
}
