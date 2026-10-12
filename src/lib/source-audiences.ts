import { HUMAN_SERVICE_API_KEY, HUMAN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { LEAD_SOURCING_SLUG, SourceCampaignUnresolvedError, fetchLeadSourcingChoice } from "./source-campaign.js";
import { fetchAudienceOriginSlug } from "./sourcing-origin.js";

/**
 * WHICH AUDIENCES A SOURCE UNIT'S OWN RUN LOOKS IN (LEADS-ONLY-FUNNEL-CAMPAIGN, 2026-10-12).
 *
 * A source unit run by campaign-service on its own may name no audience (`x-audience-id` absent: features-service's
 * projection lists none for the `start_to_lead_found` leg). The audiences it may find in are then the brand's ACTIVE
 * audiences of the unit's offer (human-service `GET /orgs/audiences?brandId&offerId&status=active`) whose list
 * human-service serves under the unit's channel from THAT origin (`GET /orgs/audiences/{id}/sourcing-origin`, asked
 * with the unit's slug as `x-feature-slug`, the same header serve-next gets). For Lead Sourcing: an origin human-service
 * CHOSE for the brand (`/orgs/lead-sourcing/sources`). Never guessed from names.
 *
 * TARGETING (CRM-SEGMENT-SOURCING, owner 2026-10-12): when the unit's campaign states `audienceIds` (campaign-service,
 * the same HARD subset the outreach audience bandit honours), the run looks ONLY in those of them that pass the rules
 * above (active, of its brand and offer, served under its channel). None passing = `targets_unavailable`: it finds
 * nobody and says why, never a fallback to the other audiences (for `sourcing-crm-contacts` every audience serves from
 * the brand's whole CRM, so a fallback would hand out everyone the customer scoped out). No targets = unchanged.
 *
 * Order: the audience the caller named first (when it is one of them), then most people left to contact first
 * (`availableToContactCount`, human-service's own figure), then id. This is the ONLY place lead-service orders
 * audiences, and only for a source unit's own run: an outreach serve still serves exactly `x-audience-id`.
 * Anything unreadable throws (nothing is bought).
 */

const CALL_TIMEOUT_MS = 10_000;
const PAGE = 200;

interface ListedAudience {
  id: string;
  availableToContactCount: number | null;
}

async function listActiveAudiences(args: { orgId: string; brandId: string; offerId: string; userId?: string | null; runId?: string | null }): Promise<ListedAudience[]> {
  const out: ListedAudience[] = [];
  const headers: Record<string, string> = { "x-api-key": HUMAN_SERVICE_API_KEY, "x-org-id": args.orgId };
  if (args.userId) headers["x-user-id"] = args.userId;
  if (args.runId) headers["x-run-id"] = args.runId;
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({ brandId: args.brandId, offerId: args.offerId, status: "active", limit: String(PAGE), offset: String(offset) });
    const where = `brand=${args.brandId} offer=${args.offerId} org=${args.orgId}`;
    const response = await fetchWithRetry(`${HUMAN_SERVICE_URL}/orgs/audiences?${query}`, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!response.ok) {
      throw new SourceCampaignUnresolvedError(`human-service audience list failed (${where}): ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as { audiences?: unknown; total?: unknown };
    if (!Array.isArray(body.audiences)) throw new SourceCampaignUnresolvedError(`human-service audience list unreadable (${where})`);
    for (const a of body.audiences as Array<Record<string, unknown>>) {
      if (typeof a?.id !== "string") throw new SourceCampaignUnresolvedError(`human-service audience list entry without id (${where})`);
      out.push({ id: a.id, availableToContactCount: typeof a.availableToContactCount === "number" ? a.availableToContactCount : null });
    }
    const total = typeof body.total === "number" ? body.total : 0;
    if (body.audiences.length < PAGE || out.length >= total) return out;
  }
}

/** Pure: the order a source unit's own run walks its audiences in. */
export function orderSourceAudiences(audiences: ListedAudience[], preferredAudienceId: string | null): string[] {
  const sorted = [...audiences].sort((a, b) => {
    if (preferredAudienceId && a.id === preferredAudienceId) return -1;
    if (preferredAudienceId && b.id === preferredAudienceId) return 1;
    // Unknown pool (null) after every known one: it may be large, it may be empty.
    const ca = a.availableToContactCount ?? -1;
    const cb = b.availableToContactCount ?? -1;
    if (ca !== cb) return cb - ca;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.map((a) => a.id);
}

export type SourceAudiences =
  | { kind: "walk"; audienceIds: string[] }
  /** The campaign targets audiences and none of them can be walked under this unit: nobody is looked for. */
  | { kind: "targets_unavailable"; detail: string };

export async function resolveSourceAudiences(args: {
  orgId: string;
  brandId: string;
  offerId: string;
  /** The source unit's channel: an origin slug or `lead-sourcing`. */
  unitSlug: string;
  preferredAudienceId: string | null;
  /** The unit campaign's targeted audiences (`SourceUnit.audienceIds`); null = none stated. */
  targetAudienceIds: string[] | null;
  userId?: string | null;
  runId?: string | null;
}): Promise<SourceAudiences> {
  const targets = args.targetAudienceIds && args.targetAudienceIds.length > 0 ? new Set(args.targetAudienceIds) : null;
  const where = `unit=${args.unitSlug} brand=${args.brandId} offer=${args.offerId}`;
  const [listed, chosen] = await Promise.all([
    listActiveAudiences(args),
    args.unitSlug === LEAD_SOURCING_SLUG
      ? fetchLeadSourcingChoice({ orgId: args.orgId, brandId: args.brandId, offerId: args.offerId, userId: args.userId, runId: args.runId })
      : Promise.resolve(new Set([args.unitSlug])),
  ]);
  const audiences = targets ? listed.filter((a) => targets.has(a.id)) : listed;
  if (targets) {
    const inactive = [...targets].filter((id) => !audiences.some((a) => a.id === id));
    if (inactive.length > 0) console.warn(`[lead-service] source unit run (${where}) targets audiences that are not active audiences of its offer: ${inactive.join(",")}`);
  }
  if (chosen.size === 0 || audiences.length === 0) {
    return targets
      ? { kind: "targets_unavailable", detail: `targeted audiences ${[...targets].join(",")} are not active audiences of this offer (${where})` }
      : { kind: "walk", audienceIds: [] };
  }
  const origins = await Promise.all(audiences.map((a) => fetchAudienceOriginSlug(a.id, args.orgId, args.unitSlug)));
  const ofThisSource = audiences.filter((_, i) => origins[i] !== null && chosen.has(origins[i] as string));
  if (args.preferredAudienceId && !ofThisSource.some((a) => a.id === args.preferredAudienceId)) {
    console.warn(
      `[lead-service] source unit run named audience ${args.preferredAudienceId}, which is not an active audience of ${args.unitSlug} for brand=${args.brandId} offer=${args.offerId}: looking in its own audiences instead`,
    );
  }
  if (targets) {
    const offChannel = audiences.filter((a) => !ofThisSource.includes(a)).map((a) => a.id);
    if (ofThisSource.length === 0) {
      return { kind: "targets_unavailable", detail: `targeted audiences ${[...targets].join(",")}: none is served under this unit's channel (${where})` };
    }
    if (offChannel.length > 0) console.warn(`[lead-service] source unit run (${where}) targets audiences not served under its channel, skipped: ${offChannel.join(",")}`);
  }
  return { kind: "walk", audienceIds: orderSourceAudiences(ofThisSource, args.preferredAudienceId) };
}
