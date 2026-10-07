/**
 * The treg catalogue, read from its public JSON (no token, no spend): an endpoint's price and
 * inputs, and a search by what an endpoint DOES. The price shown to a client is read here live,
 * never from a number written in our code.
 */
import { TREG_BASE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { TregCatalogEntry } from "./qualification-probes.js";

const TTL_MS = 60 * 60_000;
const entries = new Map<string, { entry: TregCatalogEntry; at: number }>();

export class TregEndpointUnknownError extends Error {
  constructor(public readonly endpointId: string) {
    super(`treg has no catalogue endpoint ${endpointId}`);
    this.name = "TregEndpointUnknownError";
  }
}

export async function getCatalogEntry(endpointId: string): Promise<TregCatalogEntry> {
  const hit = entries.get(endpointId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.entry;
  const res = await fetchWithRetry(`${TREG_BASE_URL}/catalog/endpoints/${encodeURIComponent(endpointId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) throw new TregEndpointUnknownError(endpointId);
  if (!res.ok) throw new Error(`[lead-service] treg catalogue ${endpointId} failed: ${res.status}`);
  const body = (await res.json()) as { endpoint?: TregCatalogEntry } & Partial<TregCatalogEntry>;
  const entry = (body.endpoint ?? body) as TregCatalogEntry;
  if (!entry?.id) throw new Error(`[lead-service] treg catalogue ${endpointId} answered without an endpoint`);
  entries.set(endpointId, { entry, at: Date.now() });
  return entry;
}

export async function searchCatalog(query: string, limit = 25): Promise<TregCatalogEntry[]> {
  const qs = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await fetchWithRetry(`${TREG_BASE_URL}/catalog/search?${qs.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`[lead-service] treg catalogue search failed: ${res.status}`);
  const body = (await res.json()) as { results?: TregCatalogEntry[] };
  const results = body.results ?? [];
  for (const e of results) entries.set(e.id, { entry: e, at: Date.now() });
  return results;
}
