import { HUMAN_SERVICE_API_KEY, HUMAN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { LEAD_SOURCING_SLUG, SourceCampaignUnresolvedError, fetchLeadSourcingChoice } from "./source-campaign.js";
import { fetchAudienceOriginSlug } from "./sourcing-origin.js";

/**
 * WHICH AUDIENCES A SOURCE UNIT'S OWN RUN LOOKS IN (LEADS-ONLY-FUNNEL-CAMPAIGN, 2026-10-12).
 *
 * A source unit run by campaign-service on its own may name no audience (`x-audience-id` absent: features-service's
 * projection lists none for the `start_to_lead_found` leg). The audiences it may find in are then the brand's ACTIVE
 * audiences of the unit's offer (human-service `GET /orgs/audiences?brandId&offerId&status=active`) whose OWN list is
 * THAT origin (`GET /orgs/audiences/{id}/sourcing-origin` asked WITHOUT a channel: the audience's own list). For Lead
 * Sourcing: an origin human-service CHOSE for the brand (`/orgs/lead-sourcing/sources`). Never guessed from names.
 *
 * A source unit only ever serves audiences of its own origin, every origin alike (LEAK-1012, owner 2026-10-12): asked
 * WITH the unit's slug, human-service answers `sourcing-crm-contacts` for EVERY audience under the CRM channel, so a
 * CRM-contacts unit walked an Apollo audience ("Small teams 11-50") and served 60 Apollo prospects into a
 * thank-you-for-signing-up sequence. Never ask this question with the channel header again.
 *
 * WHO among those audiences' people the run finds is its pipe's LEAD STRATEGY (owner 2026-10-14, LEAK-1012): the
 * workflow the play runs states it on buffer/next (`reachableBy`), handed to human-service on every serve of the walk.
 * A campaign's `audienceIds` is never read here: a per-funnel audience pick was rejected (reverted 2026-10-13).
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

export type SourceAudiences = { kind: "walk"; audienceIds: string[] };

export async function resolveSourceAudiences(args: {
  orgId: string;
  brandId: string;
  offerId: string;
  /** The source unit's channel: an origin slug or `lead-sourcing`. */
  unitSlug: string;
  preferredAudienceId: string | null;
  userId?: string | null;
  runId?: string | null;
}): Promise<SourceAudiences> {
  const [audiences, chosen] = await Promise.all([
    listActiveAudiences(args),
    args.unitSlug === LEAD_SOURCING_SLUG
      ? fetchLeadSourcingChoice({ orgId: args.orgId, brandId: args.brandId, offerId: args.offerId, userId: args.userId, runId: args.runId })
      : Promise.resolve(new Set([args.unitSlug])),
  ]);
  if (chosen.size === 0 || audiences.length === 0) return { kind: "walk", audienceIds: [] };
  // The audience's OWN list origin (no channel header): never the label a CRM-channel serve would give it.
  const origins = await Promise.all(audiences.map((a) => fetchAudienceOriginSlug(a.id, args.orgId, null)));
  const ofThisSource = audiences.filter((_, i) => origins[i] !== null && chosen.has(origins[i] as string));
  if (args.preferredAudienceId && !ofThisSource.some((a) => a.id === args.preferredAudienceId)) {
    console.warn(
      `[lead-service] source unit run named audience ${args.preferredAudienceId}, which is not an active audience of ${args.unitSlug} for brand=${args.brandId} offer=${args.offerId}: looking in its own audiences instead`,
    );
  }
  return { kind: "walk", audienceIds: orderSourceAudiences(ofThisSource, args.preferredAudienceId) };
}
