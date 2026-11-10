import { POOL_MAX } from "../db/pool-size.js";

/**
 * A server-side cursor HOLDS one pool connection for the whole walk, and the walks fetch more between chunks (the
 * delivery overlay, standings, audiences) on OTHER connections of the same pool. With as many walks in flight as the
 * pool has connections, every connection is a held cursor waiting for a second one: nothing moves until the callers
 * leave (DASH-SPEED-1110-LEAD-R3 measured it: 10 parallel live compact walks on a 6-connection pool, 10 min in
 * `ClientRead`). So a cursor walk first takes a SLOT (waiting holds no connection), at most half the pool at once: the
 * other half is always there for their between-chunk reads and every other request.
 *
 * Never open a cursor walk inside another one's loop (a full set of outer walks would wait on themselves):
 * `tests/unit/cursor-slots.test.ts` lists every `.cursor(` of `src` and fails on one not behind a slot.
 */
export const CURSOR_SLOTS = Math.max(1, Math.floor(POOL_MAX / 2));

let inUse = 0;
const waiting: Array<() => void> = [];

/** Test seam: slots in use and callers waiting. */
export function cursorSlotState(): { inUse: number; waiting: number; slots: number } {
  return { inUse, waiting: waiting.length, slots: CURSOR_SLOTS };
}

async function acquire(): Promise<void> {
  if (inUse < CURSOR_SLOTS) {
    inUse++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // the slot passes straight to the next walk
  else inUse--;
}

/**
 * Walk `open()`'s chunks while holding a cursor slot: taken before the cursor opens, given back when the walk ends,
 * fails, or its consumer stops early (the cursor is closed first).
 */
export async function* withCursorSlot<T>(open: () => AsyncIterable<T>): AsyncGenerator<T> {
  await acquire();
  try {
    yield* open();
  } finally {
    release();
  }
}
