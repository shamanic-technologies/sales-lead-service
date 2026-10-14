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
 * origins each outreach channel counts (`originsByChannel`): an origin its channel does not list is
 * a source that does not FEED that pipe, so the serve is REFUSED (owner 2026-10-12, OriginNotFedError:
 * a WhatsApp campaign was handed Apollo people it could not write to). A channel the catalogue names
 * no origins for keeps the outreach label, logged as an error. Anything that cannot be READ throws:
 * a serve must never silently keep the outreach label.
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
  /** features-service `contactMethodsByChannel`: how each one-to-one channel reaches a person. */
  contactMethodsByChannel: Map<string, string[]>;
  byList: Map<string, SourcingOriginName>;
  listsBySlug: Map<string, SourcingOriginName & { lists: string[] }>;
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

/**
 * One origin by its slug, with every audience LIST KIND it counts (features-service's catalogue);
 * null when the catalogue names no such origin. Throws SourcingOriginUnresolvedError when the
 * catalogue cannot be read.
 */
export async function loadOriginBySlug(slug: string): Promise<(SourcingOriginName & { lists: string[] }) | null> {
  return (await loadOriginsCatalogue()).listsBySlug.get(slug) ?? null;
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
  const listsBySlug = new Map<string, SourcingOriginName & { lists: string[] }>();
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
    listsBySlug.set(slug, { slug, name, lists: audienceLists as string[] });
  }
  // LEAD SOURCING (owner 2026-10-11): no list of its own, it picks among the origins its channels take. As a
  // source campaign it counts every list of those origins (its sourcing stats read people found on any of them).
  const ls = (body as { leadSourcing?: unknown }).leadSourcing as { slug?: unknown; name?: unknown; mayUseByChannel?: unknown } | undefined;
  if (ls !== undefined) {
    if (typeof ls?.slug !== "string" || typeof ls.name !== "string" || !ls.mayUseByChannel || typeof ls.mayUseByChannel !== "object") {
      throw new SourcingOriginUnresolvedError("features-service sourcing-origins leadSourcing unreadable (slug, name, mayUseByChannel)");
    }
    const lists = new Set<string>();
    for (const origins of Object.values(ls.mayUseByChannel as Record<string, unknown>)) {
      if (!Array.isArray(origins)) throw new SourcingOriginUnresolvedError("features-service leadSourcing.mayUseByChannel entry unreadable");
      for (const o of origins) for (const l of listsBySlug.get(String(o))?.lists ?? []) lists.add(l);
    }
    listsBySlug.set(ls.slug, { slug: ls.slug, name: ls.name, lists: [...lists].sort() });
  }
  // HOW each one-to-one channel reaches a person (features-service lib/channel-contact-methods.ts, owner 2026-10-12).
  // Absent under an older catalogue: no channel states a method, every serve passes none (today's bytes), logged.
  const contactMethodsByChannel = new Map<string, string[]>();
  const rawMethods = (body as { contactMethodsByChannel?: unknown }).contactMethodsByChannel;
  if (rawMethods === undefined) {
    console.warn("[lead-service] features-service sourcing-origins serves no contactMethodsByChannel: serves pass no reachableBy");
  } else {
    if (!rawMethods || typeof rawMethods !== "object" || Array.isArray(rawMethods)) {
      throw new SourcingOriginUnresolvedError("features-service contactMethodsByChannel unreadable");
    }
    for (const [channel, methods] of Object.entries(rawMethods as Record<string, unknown>)) {
      if (!Array.isArray(methods) || methods.some((m) => typeof m !== "string")) {
        throw new SourcingOriginUnresolvedError(`features-service contactMethodsByChannel entry unreadable for channel=${channel}`);
      }
      contactMethodsByChannel.set(channel, methods as string[]);
    }
  }
  originsCache = { at: Date.now(), byChannel, byList, listsBySlug, contactMethodsByChannel };
  return originsCache;
}

/** The origins a channel is fed by (features-service `originsByChannel`), or null when it names none. */
export async function loadOriginsByChannelSlug(channelSlug: string): Promise<Set<string> | null> {
  return (await loadOriginsByChannel()).get(channelSlug) ?? null;
}

/**
 * The contact method(s) a one-to-one channel needs to write to a person (features-service catalogue), or null when
 * the channel states none. Throws SourcingOriginUnresolvedError when the catalogue cannot be read.
 */
/** Every channel the catalogue states contact methods for (features-service `contactMethodsByChannel`). */
export async function listChannelsWithContactMethods(): Promise<string[]> {
  return [...(await loadOriginsCatalogue()).contactMethodsByChannel.keys()];
}

export async function loadChannelContactMethods(channelSlug: string): Promise<string[] | null> {
  return (await loadOriginsCatalogue()).contactMethodsByChannel.get(channelSlug) ?? null;
}

/**
 * The audience's origin is not one its outreach channel is fed by (features-service `originsByChannel`): the serve
 * must not happen. Owner 2026-10-12: a campaign only draws people from the sources ITS pipe is fed by (a WhatsApp
 * campaign was served Apollo cold-filter people, emails only, and refused every one).
 */
export class OriginNotFedError extends Error {
  constructor(
    readonly originSlug: string,
    readonly channelSlug: string,
    readonly audienceId: string,
  ) {
    super(`audience ${audienceId} serves from ${originSlug}, which does not feed ${channelSlug}`);
    this.name = "OriginNotFedError";
  }
}

/** The audience belongs to another offer than the campaign's: the serve must not happen. */
export class AudienceOfferMismatchError extends Error {
  constructor(
    readonly audienceId: string,
    readonly audienceOfferId: string,
    readonly campaignOfferId: string,
  ) {
    super(`audience ${audienceId} belongs to offer ${audienceOfferId}, the campaign sells offer ${campaignOfferId}`);
    this.name = "AudienceOfferMismatchError";
  }
}

/**
 * The offer an audience belongs to (human-service `GET /orgs/audiences/{id}` `audience.offerId`); null = brand-wide
 * (no offer stated). Throws SourcingOriginUnresolvedError when it cannot be read.
 */
export async function fetchAudienceOfferId(audienceId: string, orgId: string): Promise<string | null> {
  const url = `${HUMAN_SERVICE_URL}/orgs/audiences/${encodeURIComponent(audienceId)}`;
  const response = await fetchWithRetry(url, {
    headers: { "X-API-Key": HUMAN_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SourcingOriginUnresolvedError(
      `human-service audience read failed for audience=${audienceId}: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { audience?: { offerId?: unknown } };
  const offerId = body.audience?.offerId;
  if (offerId === null || offerId === undefined) return null;
  if (typeof offerId !== "string") {
    throw new SourcingOriginUnresolvedError(`human-service audience ${audienceId} answered an unreadable offerId`);
  }
  return offerId;
}

/**
 * human-service's answer; null = the audience serves from no list (no committed provider).
 *
 * `outreachFeatureSlug` = the channel a serve-next will be asked under: the answer is the list THAT serve draws from
 * (the CRM channels serve from the client's CRM whatever the audience's provider, so under them EVERY audience answers
 * `sourcing-crm-contacts`). `null` = no channel: the origin of the audience's OWN list. "Which source does this
 * audience belong to" is always the null form (LEAK-1012: a `sourcing-crm-contacts` unit asked with its own slug saw
 * an Apollo audience as CRM and served Apollo prospects a thank-you-for-signing-up email).
 */
export async function fetchAudienceOriginSlug(audienceId: string, orgId: string, outreachFeatureSlug: string | null): Promise<string | null> {
  const url = `${HUMAN_SERVICE_URL}/orgs/audiences/${encodeURIComponent(audienceId)}/sourcing-origin`;
  const headers: Record<string, string> = { "X-API-Key": HUMAN_SERVICE_API_KEY, "x-org-id": orgId };
  if (outreachFeatureSlug !== null) headers["x-feature-slug"] = outreachFeatureSlug;
  const response = await fetchWithRetry(url, {
    headers,
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
 * (serve-next answers it `audience_not_serveable` and buys nothing), or the channel names no
 * origins in the catalogue (logged as an error). An origin the channel is NOT fed by throws
 * OriginNotFedError: the serve is refused, never made "keeping the label". Throws
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
  if (!listed) {
    console.error(
      `[lead-service] sourcing origin NOT COUNTED by its channel, serve keeps the outreach label: origin=${slug} ` +
        `channel is not a sourcing channel in the features-service catalogue (${where})`,
    );
    return null;
  }
  // The channel IS fed by named origins and this is not one of them: never served (owner 2026-10-12).
  if (!listed.has(slug)) throw new OriginNotFedError(slug, params.outreachFeatureSlug, params.audienceId);
  return slug;
}
