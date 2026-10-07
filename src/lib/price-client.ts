/**
 * The CLIENT price of a cost name, as costs-service states it (vendor list price x the platform
 * multiplier). Public route, no identity. Used only to show an ESTIMATE before a client turns a
 * check on; what is actually billed is whatever the run declares.
 */
import { COSTS_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

const cache = new Map<string, { centsPerUnit: number; at: number }>();
const TTL_MS = 10 * 60_000;

export async function priceCentsPerUnit(costName: string): Promise<number> {
  const hit = cache.get(costName);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.centsPerUnit;
  const res = await fetchWithRetry(`${COSTS_SERVICE_URL}/v1/platform-prices/${encodeURIComponent(costName)}`, {
    method: "GET",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`[lead-service] costs-service price ${costName} failed: ${res.status}`);
  const body = (await res.json()) as { pricePerUnitInUsdCents?: unknown };
  const cents = Number(body.pricePerUnitInUsdCents);
  if (body.pricePerUnitInUsdCents === null || !Number.isFinite(cents)) throw new Error(`[lead-service] costs-service has no price for ${costName}`);
  cache.set(costName, { centsPerUnit: cents, at: Date.now() });
  return cents;
}
