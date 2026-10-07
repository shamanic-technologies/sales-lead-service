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
 * Two reads, no guess: human-service states the audience's list kind (`channels[].list`), and
 * features-service's sourcing-origins catalogue maps each list kind to its origin slug. Anything
 * that cannot be resolved THROWS: a serve must never silently keep the outreach label.
 */

const ORIGINS_TTL_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 10_000;

export class SourcingOriginUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcingOriginUnresolvedError";
  }
}

interface SourcingOriginEntry {
  slug: string;
  audienceLists: string[];
}

let originsCache: { at: number; byList: Map<string, string> } | null = null;

/** Test hook: forget the cached catalogue. */
export function resetSourcingOriginsCache(): void {
  originsCache = null;
}

async function loadOriginByList(): Promise<Map<string, string>> {
  if (originsCache && Date.now() - originsCache.at < ORIGINS_TTL_MS) return originsCache.byList;

  const url = `${FEATURES_SERVICE_URL}/public/sourcing-origins`;
  const response = await fetchWithRetry(url, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!response.ok) {
    throw new SourcingOriginUnresolvedError(
      `features-service sourcing-origins read failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { origins?: unknown };
  if (!Array.isArray(body.origins)) {
    throw new SourcingOriginUnresolvedError("features-service sourcing-origins answered without an origins list");
  }
  const byList = new Map<string, string>();
  for (const raw of body.origins as SourcingOriginEntry[]) {
    if (!raw || typeof raw.slug !== "string" || !Array.isArray(raw.audienceLists)) {
      throw new SourcingOriginUnresolvedError(`features-service sourcing-origins entry unreadable: ${JSON.stringify(raw)}`);
    }
    for (const list of raw.audienceLists) byList.set(list, raw.slug);
  }
  originsCache = { at: Date.now(), byList: byList };
  return byList;
}

async function fetchAudienceListKind(audienceId: string, orgId: string): Promise<string> {
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
  const body = (await response.json()) as { audience?: { channels?: Array<{ list?: unknown }> } };
  const lists = (body.audience?.channels ?? [])
    .map((c) => c?.list)
    .filter((l): l is string => typeof l === "string" && l.length > 0);
  const distinct = [...new Set(lists)];
  if (distinct.length !== 1) {
    throw new SourcingOriginUnresolvedError(
      `audience=${audienceId} states ${distinct.length === 0 ? "no list kind" : `several list kinds (${distinct.join(",")})`}`,
    );
  }
  return distinct[0];
}

/**
 * The origin feature slug of the audience a serve draws from. Throws SourcingOriginUnresolvedError
 * (with the audience, org and cause in the message) on any failure.
 */
export async function resolveSourcingOriginSlug(params: { audienceId: string; orgId: string }): Promise<string> {
  const [list, byList] = await Promise.all([
    fetchAudienceListKind(params.audienceId, params.orgId),
    loadOriginByList(),
  ]);
  const slug = byList.get(list);
  if (!slug) {
    throw new SourcingOriginUnresolvedError(
      `no sourcing origin in the features-service catalogue for list kind=${list} (audience=${params.audienceId} org=${params.orgId})`,
    );
  }
  return slug;
}
