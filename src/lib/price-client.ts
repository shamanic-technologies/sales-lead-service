/**
 * The CLIENT price of a cost name FOR ONE ORG, as costs-service states it. costs-service carries
 * several price lists (PRICE-X1-1029: orgs created from 2026-10-29T14:00Z pay the standard list,
 * older orgs keep the grandfathered one) and picks the org's list from `x-org-id`; this service
 * never computes, multiplies or guesses a price. Used only to show an ESTIMATE before a client
 * turns a check on; what is actually billed is whatever the run declares (runs-service).
 *
 * The cache is keyed on (org, cost name): two orgs on two lists must never share an entry.
 * A refusal (401 on a wrong key, 502, no price) throws, so the estimate fails rather than show a
 * price that is not the org's.
 */
import { COSTS_SERVICE_API_KEY, COSTS_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

const cache = new Map<string, { centsPerUnit: number; at: number }>();
const TTL_MS = 10 * 60_000;

export async function priceCentsPerUnit(costName: string, orgId: string): Promise<number> {
  if (!orgId) throw new Error(`[lead-service] costs-service price ${costName}: an org is required (each org has its own price list)`);
  const key = `${orgId}::${costName}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.centsPerUnit;
  const res = await fetchWithRetry(`${COSTS_SERVICE_URL}/v1/platform-prices/${encodeURIComponent(costName)}`, {
    method: "GET",
    headers: { "x-api-key": COSTS_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[lead-service] costs-service price ${costName} for org ${orgId} failed: ${res.status}`);
  const body = (await res.json()) as { pricePerUnitInUsdCents?: unknown };
  const cents = Number(body.pricePerUnitInUsdCents);
  if (body.pricePerUnitInUsdCents === null || body.pricePerUnitInUsdCents === undefined || !Number.isFinite(cents)) {
    throw new Error(`[lead-service] costs-service has no price for ${costName} (org ${orgId})`);
  }
  cache.set(key, { centsPerUnit: cents, at: Date.now() });
  return cents;
}

/** Test-only: forget every cached price. */
export function clearPriceCache(): void {
  cache.clear();
}
