/**
 * Keys (outreach campaigns) with a buffer/next in flight IN THIS PROCESS (SERVE-LOCK-STUCK-1126).
 *
 * A hold ends when the request that took it ends, whatever way it ends: the route releases it in a
 * `finally`, never on the response's `close` event alone. A caller who left while the guard was still
 * awaiting (idempotency lookup, runs-service read) had ALREADY closed the response before a `close`
 * listener could be attached, so that listener never fired and the campaign stayed refused for good
 * (livingvital.ch, 2026-11-25 18:25: 33 refusals in 14 h).
 *
 * Release is per hold (a token), so a late release never frees another request's hold. A hold older than
 * `staleAfterMs` (no serve can run that long: its pull aborts first) is an orphan of a request that never
 * ended, and no longer refuses anyone.
 */
export interface InFlightHolds {
  /** Takes the hold, or answers who holds it. */
  tryHold(key: string): { held: true; release: () => void } | { held: false; heldSinceMs: number };
  size(): number;
}

export function createInFlightHolds(staleAfterMs: number, now: () => number = Date.now): InFlightHolds {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) throw new Error(`in-flight holds need a positive stale window, got ${staleAfterMs}`);
  const holds = new Map<string, { token: symbol; since: number }>();
  return {
    tryHold(key) {
      const current = holds.get(key);
      if (current) {
        const ageMs = now() - current.since;
        if (ageMs <= staleAfterMs) return { held: false, heldSinceMs: current.since };
        console.warn(
          `[lead-service] in-flight hold on ${key} is ${ageMs}ms old (over ${staleAfterMs}ms): an orphan of a request that never ended, taken over`,
        );
      }
      const token = Symbol(key);
      holds.set(key, { token, since: now() });
      return {
        held: true,
        release: () => {
          if (holds.get(key)?.token === token) holds.delete(key);
        },
      };
    },
    size: () => holds.size,
  };
}
