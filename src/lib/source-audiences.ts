import { HUMAN_SERVICE_API_KEY, HUMAN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { LEAD_SOURCING_SLUG, SourceCampaignUnresolvedError, fetchLeadSourcingChoice } from "./source-campaign.js";
import { fetchAudienceOriginSlug, loadOriginBySlug } from "./sourcing-origin.js";

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
 * A SOURCE is not an AUDIENCE (AUDIENCE-SOURCES-1016, owner 2026-10-16: « the SOURCES should be a concept separate from
 * TARGETING »). An audience is WHO ("Employed chiros"); it is found through its own list AND through every source
 * human-service keeps beside it (a buying signal, competitor-post engagement), each listed in the audience's
 * `channels[]` with its `sourceId`, list kind and on/off `status`. So a unit also walks every active audience holding an
 * ON source whose list kind is one its origin counts (features-service catalogue `origins[].audienceLists`, the same map
 * human-service routes by); the serve then goes THROUGH that source because the run asks human-service under the
 * unit's origin slug. An OFF source is never walked (its source campaign is off). A CRM unit is unchanged: no source is
 * a CRM list, so it still only matches an audience whose own list is CRM (LEAK-1012).
 *
 * Order: the audience the caller named first (when it is one of them), then most people left to contact first
 * (`availableToContactCount`, human-service's own figure), then id. This is the ONLY place lead-service orders
 * audiences, and only for a source unit's own run: an outreach serve still serves exactly `x-audience-id`.
 * Anything unreadable throws (nothing is bought).
 */

const CALL_TIMEOUT_MS = 10_000;
const PAGE = 200;

/** One entry of human-service's `channels[]`: the own list has no `sourceId`; a source has one plus its on/off. */
export interface AudienceChannelEntry {
  list: string;
  sourceId: string | null;
  status: string | null;
}

interface ListedAudience {
  id: string;
  availableToContactCount: number | null;
  channels: AudienceChannelEntry[];
}

/** Reads `channels[]` off a human-service audience; anything unreadable throws (never "no sources"). */
export function readAudienceChannels(raw: unknown, where: string): AudienceChannelEntry[] {
  if (!Array.isArray(raw)) throw new SourceCampaignUnresolvedError(`human-service audience without channels (${where})`);
  return raw.map((c: Record<string, unknown>) => {
    if (typeof c?.list !== "string") throw new SourceCampaignUnresolvedError(`human-service audience channel without list (${where})`);
    if (c.sourceId !== undefined && c.sourceId !== null && typeof c.sourceId !== "string") {
      throw new SourceCampaignUnresolvedError(`human-service audience channel with an unreadable sourceId (${where})`);
    }
    const sourceId = typeof c.sourceId === "string" ? c.sourceId : null;
    if (sourceId && typeof c.status !== "string") throw new SourceCampaignUnresolvedError(`human-service audience source ${sourceId} without status (${where})`);
    return { list: c.list, sourceId, status: typeof c.status === "string" ? c.status : null };
  });
}

/**
 * Pure: does the audience find people through one of `lists` by a SOURCE (never its own list, judged apart)?
 * `onOnly` = only a source that is ON (a walk); a find already made counts whatever the source's state now.
 */
export function findsThroughSource(channels: AudienceChannelEntry[], lists: ReadonlySet<string>, opts: { onOnly: boolean }): boolean {
  return channels.some((c) => c.sourceId !== null && lists.has(c.list) && (!opts.onOnly || c.status === "active"));
}

/** Every audience list kind the given origins count (features-service catalogue). */
export async function listsOfOrigins(origins: ReadonlySet<string>): Promise<Set<string>> {
  const lists = new Set<string>();
  for (const slug of origins) for (const l of (await loadOriginBySlug(slug))?.lists ?? []) lists.add(l);
  return lists;
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
      out.push({
        id: a.id,
        availableToContactCount: typeof a.availableToContactCount === "number" ? a.availableToContactCount : null,
        channels: readAudienceChannels(a.channels, `audience=${a.id} ${where}`),
      });
    }
    const total = typeof body.total === "number" ? body.total : 0;
    if (body.audiences.length < PAGE || out.length >= total) return out;
  }
}

/** Pure: the order a source unit's own run walks its audiences in. */
export function orderSourceAudiences(audiences: Array<Pick<ListedAudience, "id" | "availableToContactCount">>, preferredAudienceId: string | null): string[] {
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
  // The catalogue is read only when some audience holds a source at all.
  const lists = audiences.some((a) => a.channels.some((c) => c.sourceId !== null)) ? await listsOfOrigins(chosen) : new Set<string>();
  const ofThisSource = audiences.filter(
    (a, i) => (origins[i] !== null && chosen.has(origins[i] as string)) || findsThroughSource(a.channels, lists, { onOnly: true }),
  );
  if (args.preferredAudienceId && !ofThisSource.some((a) => a.id === args.preferredAudienceId)) {
    console.warn(
      `[lead-service] source unit run named audience ${args.preferredAudienceId}, which is not an active audience of ${args.unitSlug} for brand=${args.brandId} offer=${args.offerId}: looking in its own audiences instead`,
    );
  }
  return { kind: "walk", audienceIds: orderSourceAudiences(ofThisSource, args.preferredAudienceId) };
}
