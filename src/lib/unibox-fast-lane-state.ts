/**
 * What the Unibox fast lane (unibox-fast-lane.ts, UNIBOX-REPLY-LAG-1031) and the full relationship sweep tell each other,
 * in process (both run on the background thread). Kept apart so the sweep does not import the fast lane.
 *
 * The full sweep reads a whole brand, then writes it minutes later; a person the fast lane refreshed in between would be
 * written back as the sweep read them (their new message missing) until the next round, an hour later on the biggest
 * brands. So every human the fast lane refreshed while a round of their brand ran is refreshed again once it ends.
 */
const RECHECK_MEMORY_MS = 3 * 60 * 60_000;

const scopeKey = (s: { orgId: string; brandId: string }) => `${s.orgId}|${s.brandId}`;

/** scope -> human -> when the fast lane last refreshed them (ms). */
const refreshed = new Map<string, Map<string, number>>();
/** scope -> humans to refresh again (a sweep round of their brand overlapped the fast lane's write). */
const recheck = new Map<string, Set<string>>();

export function noteFastLaneRefreshed(scope: { orgId: string; brandId: string }, humans: Iterable<string>, at = Date.now()): void {
  const k = scopeKey(scope);
  const m = refreshed.get(k) ?? new Map<string, number>();
  for (const h of humans) m.set(h, at);
  refreshed.set(k, m);
}

/** A sweep round of `scope` that started at `startedAt` just ended: whoever the fast lane wrote since is re-applied. */
export function noteScopeSwept(scope: { orgId: string; brandId: string }, startedAt: number, now = Date.now()): void {
  const k = scopeKey(scope);
  const m = refreshed.get(k);
  if (!m) return;
  for (const [h, at] of m) {
    if (at < now - RECHECK_MEMORY_MS) m.delete(h);
    else if (at >= startedAt) recheck.set(k, (recheck.get(k) ?? new Set()).add(h));
  }
  if (m.size === 0) refreshed.delete(k);
}

/** Take (and clear) the humans to refresh again, per scope. */
export function takeRechecks(): Array<{ orgId: string; brandId: string; humans: string[] }> {
  const out = [...recheck.entries()].map(([k, hs]) => {
    const [orgId, brandId] = k.split("|");
    return { orgId, brandId, humans: [...hs] };
  });
  recheck.clear();
  return out;
}

export interface SweepRound {
  startedAt: number;
  endedAt: number;
  scopes: number;
}

let lastRound: SweepRound | null = null;

/** A full sweep round over every brand ended (reported beside the lag check, so a slow round is visible). */
export function noteSweepRound(startedAt: number, endedAt: number, scopes: number): void {
  lastRound = { startedAt, endedAt, scopes };
}

export function lastSweepRound(): SweepRound | null {
  return lastRound;
}

/** Tests only. */
export function resetFastLaneState(): void {
  refreshed.clear();
  recheck.clear();
  lastRound = null;
}
