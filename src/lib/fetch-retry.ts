/**
 * Connect-phase retry for outbound HTTP calls to Neon-backed sibling services.
 *
 * Siblings sit behind Neon scale-to-zero (DIS-153/155/157): idle compute
 * suspends, and the FIRST request after a suspend can land mid-wake — the
 * sibling resets / drops the TCP connection, so `fetch` rejects with
 * `TypeError: fetch failed` whose `cause` carries the transient code:
 * `ECONNRESET` / `UND_ERR_SOCKET` ("other side closed", observed against
 * email-gateway), `ETIMEDOUT` (Node-20 happy-eyeballs 250ms attempt window),
 * or `ECONNREFUSED`.
 *
 * lead-service `GET /orgs/leads` composes its delivery-status check with a
 * fail-loud `Promise.all` → a single transient reset on the email-gateway call
 * 500s the whole request for the end user. Retrying connect-phase rejections
 * absorbs the transient drop instead.
 *
 * We retry ONLY a thrown (connect-phase) failure, never a completed HTTP
 * response: an HTTP 5xx is a real answer the server already produced and may
 * have side-effected on. A connect-phase rejection means the request never
 * reached the server, so the retry is write-safe.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const BACKOFF_MS = [250, 500, 1000];

/**
 * A transient network error from `fetch` is wrapped in `cause` (and for
 * happy-eyeballs, an `AggregateError` with per-address sub-errors under
 * `.errors`). Walk both chains, guarding against cycles.
 */
function isTransient(err: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    const cause = (cur as { cause?: unknown }).cause;
    if (cause !== undefined) stack.push(cause);
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors)) stack.push(...errors);
  }
  return false;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with a connect-phase retry on transient network rejections.
 * Drop-in replacement for `fetch(input, init)` — same signature, same return.
 * A non-transient rejection (or exhausted retries) propagates unchanged.
 */
export async function fetchWithRetry(input: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt >= BACKOFF_MS.length || !isTransient(err)) throw err;
      await delay(BACKOFF_MS[attempt]);
    }
  }
}
