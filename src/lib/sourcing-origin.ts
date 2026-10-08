import {
  FEATURES_SERVICE_URL,
  HUMAN_SERVICE_URL,
  HUMAN_SERVICE_API_KEY,
} from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * WHERE A SERVED LEAD COMES FROM: the sourcing origin's feature slug a serve run is labelled with.
 *
 * A cold-email campaign does two things a customer prices separately: SOURCING (finding the person:
 * an Apollo search, a buying signal, LinkedIn engagement, the client's CRM upload) and OUTREACH (the
 * channel that writes to them). The serve run and everything bought under it is sourcing, so it
 * carries the ORIGIN's feature slug, not the outreach slug the workflow run carries. The lead row
 * itself (`leads_campaigns.feature_slug`) keeps the outreach channel it was served for.
 *
 * No guess here: human-service answers which origin a serve-next of the audience draws from
 * (`GET /orgs/audiences/{id}/sourcing-origin`, asked with the outreach slug, because the CRM channel
 * serves from the CRM whatever the audience's provider). features-service's catalogue states which
 * origins each outreach channel counts (`originsByChannel`): an origin its channel does not list would
 * drop that sourcing cost from the channel's spend figures, so that serve keeps the OUTREACH label
 * (where every spend read still counts it) and the mismatch is logged as an error, never silent and
 * never a blocked campaign. Anything that cannot be READ throws: a serve must never silently keep the
 * outreach label.
 */

const ORIGINS_TTL_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 10_000;

export class SourcingOriginUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcingOriginUnresolvedError";
  }
}

/** The customer-facing origin a human-service audience LIST KIND is (features-service names it). */
export interface SourcingOriginName {
  slug: string;
  name: string;
}

let originsCache: {
  at: number;
  byChannel: Map<string, Set<string>>;
  byList: Map<string, SourcingOriginName>;
} | null = null;

/** Test hook: forget the cached catalogue. */
export function resetSourcingOriginsCache(): void {
  originsCache = null;
}

async function loadOriginsByChannel(): Promise<Map<string, Set<string>>> {
  return (await loadOriginsCatalogue()).byChannel;
}

/**
 * Origin (slug + customer name) by human-service audience list kind, read off features-service's
 * catalogue (`origins[].audienceLists`): the name a customer reads for "where this person was found".
 * Never derived from an audience name or a cost name. Throws SourcingOriginUnresolvedError when the
 * catalogue cannot be read.
 */
export async function loadOriginNamesByList(): Promise<Map<string, SourcingOriginName>> {
  return (await loadOriginsCatalogue()).byList;
}

async function loadOriginsCatalogue(): Promise<NonNullable<typeof originsCache>> {
  if (originsCache && Date.now() - originsCache.at < ORIGINS_TTL_MS) return originsCache;

  const url = `${FEATURES_SERVICE_URL}/public/sourcing-origins`;
  const response = await fetchWithRetry(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!response.ok) {
    throw new SourcingOriginUnresolvedError(
      `features-service sourcing-origins read failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { originsByChannel?: unknown; origins?: unknown };
  const raw = body.originsByChannel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SourcingOriginUnresolvedError("features-service sourcing-origins answered without originsByChannel");
  }
  const byChannel = new Map<string, Set<string>>();
  for (const [channel, origins] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(origins) || origins.some((o) => typeof o !== "string")) {
      throw new SourcingOriginUnresolvedError(`features-service originsByChannel entry unreadable for channel=${channel}`);
    }
    byChannel.set(channel, new Set(origins as string[]));
  }
  if (!Array.isArray(body.origins)) {
    throw new SourcingOriginUnresolvedError("features-service sourcing-origins answered without origins");
  }
  const byList = new Map<string, SourcingOriginName>();
  for (const origin of body.origins as Array<Record<string, unknown>>) {
    const { slug, name, audienceLists } = origin ?? {};
    if (typeof slug !== "string" || typeof name !== "string" || !Array.isArray(audienceLists)) {
      throw new SourcingOriginUnresolvedError("features-service sourcing-origins entry unreadable (slug, name, audienceLists)");
    }
    for (const list of audienceLists) {
      if (typeof list !== "string") {
        throw new SourcingOriginUnresolvedError(`features-service sourcing-origins audienceLists unreadable for origin=${slug}`);
      }
      byList.set(list, { slug, name });
    }
  }
  originsCache = { at: Date.now(), byChannel, byList };
  return originsCache;
}

/** human-service's answer; null = the audience serves from no list (no committed provider). */
async function fetchAudienceOriginSlug(audienceId: string, orgId: string, outreachFeatureSlug: string): Promise<string | null> {
  const url = `${HUMAN_SERVICE_URL}/orgs/audiences/${encodeURIComponent(audienceId)}/sourcing-origin`;
  const response = await fetchWithRetry(url, {
    headers: { "X-API-Key": HUMAN_SERVICE_API_KEY, "x-org-id": orgId, "x-feature-slug": outreachFeatureSlug },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  // Same answer serve-next gives the audience (audience_not_serveable): nothing will be bought.
  if (response.status === 422) return null;
  if (!response.ok) {
    throw new SourcingOriginUnresolvedError(
      `human-service sourcing-origin read failed for audience=${audienceId}: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { sourcingFeatureSlug?: unknown };
  if (typeof body.sourcingFeatureSlug !== "string" || body.sourcingFeatureSlug.length === 0) {
    throw new SourcingOriginUnresolvedError(`human-service sourcing-origin answered no sourcingFeatureSlug for audience=${audienceId}`);
  }
  return body.sourcingFeatureSlug;
}

/**
 * The origin feature slug of the audience a serve draws from, checked against the outreach channel
 * the lead is served for. Null = keep the outreach label: the audience serves from no list
 * (serve-next answers it `audience_not_serveable` and buys nothing), or its origin is one the
 * channel's spend reads do not count (logged as an error). Throws
 * SourcingOriginUnresolvedError (audience, org, channel and cause in the message) on any failure.
 */
export async function resolveSourcingOriginSlug(params: {
  audienceId: string;
  orgId: string;
  outreachFeatureSlug: string;
}): Promise<string | null> {
  const [slug, byChannel] = await Promise.all([
    fetchAudienceOriginSlug(params.audienceId, params.orgId, params.outreachFeatureSlug),
    loadOriginsByChannel(),
  ]);
  if (slug === null) return null;
  const where = `audience=${params.audienceId} org=${params.orgId} channel=${params.outreachFeatureSlug}`;
  const listed = byChannel.get(params.outreachFeatureSlug);
  if (!listed || !listed.has(slug)) {
    console.error(
      `[lead-service] sourcing origin NOT COUNTED by its channel, serve keeps the outreach label: origin=${slug} ` +
        `${listed ? "is not one the outreach channel counts" : "channel is not a sourcing channel in the features-service catalogue"} (${where})`,
    );
    return null;
  }
  return slug;
}
