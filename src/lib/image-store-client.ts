/**
 * Keeps an image a probe produced (a provider CDN link that may expire) at a durable public URL,
 * through cloudflare-service `POST /upload` (it meters its own storage on a child run).
 */
import { CLOUDFLARE_SERVICE_API_KEY, CLOUDFLARE_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { identityHeaders, type SpendIdentity } from "./treg-client.js";

export async function storeImage(sourceUrl: string, filename: string, id: SpendIdentity): Promise<string> {
  const res = await fetchWithRetry(`${CLOUDFLARE_SERVICE_URL}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": CLOUDFLARE_SERVICE_API_KEY, ...identityHeaders(id) },
    body: JSON.stringify({ sourceUrl, folder: "lead-qualification", filename }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`[lead-service] cloudflare-service upload failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("[lead-service] cloudflare-service upload answered without a url");
  return body.url;
}
