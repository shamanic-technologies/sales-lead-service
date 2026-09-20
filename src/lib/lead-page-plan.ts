/**
 * The two levers a filtered read pulls on the population: which ORDER it is in, and which rows
 * belong to it at all.
 *
 * The order itself is taken in the database (see lead-plan-store.ts) — a sort is the one part of a
 * filtered read that is unavoidably O(the population), and Postgres is the thing equipped to hold
 * it. What lives here is the vocabulary (`sort`) and the per-ROW predicate, which is what lets the
 * population be walked a chunk at a time: a row is judged on its own evidence, so nothing has to
 * see the whole set to decide.
 */
import type { LeadBucket } from "./lead-buckets.js";
import type { LeadStandingState } from "./lead-standing.js";
import type { EnrichedLeadIndexRow } from "./lead-engagement.js";

export const LEAD_SORT_ORDERS = ["created", "activity"] as const;
export type LeadSortOrder = (typeof LEAD_SORT_ORDERS)[number];

/**
 * Resolve the `sort` query param. Absent → `created`: `(created_at, id)` ascending, the order this
 * endpoint has always answered in and the one every existing caller walks. `activity` is
 * newest-first on the timestamp that proves each lead's most advanced status. Anything else is a
 * 400 (throws) — an ignored sort is a list that silently disagrees with the order it was asked for.
 */
export function parseLeadSort(raw: unknown): LeadSortOrder {
  if (raw === undefined) return "created";
  if (typeof raw !== "string") throw new Error("sort must be a single sort name");
  const trimmed = raw.trim();
  if ((LEAD_SORT_ORDERS as readonly string[]).includes(trimmed)) return trimmed as LeadSortOrder;
  throw new Error(`Unknown sort '${raw}'. Valid: ${LEAD_SORT_ORDERS.join(", ")}`);
}

/**
 * Does this row belong to the read the caller asked for?
 *
 * Two independent lenses, deliberately: an engagement bucket asks what HAPPENED to somebody and is
 * not exclusive, a standing asks where they STAND on this campaign's funnel and is. Naming both
 * narrows to the rows satisfying both, which is what a board with a search and a tab means.
 *
 * SEVERAL standings read as ONE set, not as several reads: a board column can hold two states, and
 * the point of naming them together is that the page, the order, the total and the cursor are the
 * column's, not one of its halves'.
 */
export function leadRowInRead(
  row: EnrichedLeadIndexRow,
  bucket: LeadBucket | null,
  standings: ReadonlySet<string> | null,
): boolean {
  if (bucket !== null && !row.buckets.has(bucket)) return false;
  if (standings !== null && !standings.has(row.standing ?? "unresolved")) return false;
  return true;
}

/** The standings a read names, as the set the predicate tests. Absent stays absent. */
export function standingFilterSet(
  standings: readonly LeadStandingState[] | null,
): ReadonlySet<string> | null {
  return standings === null ? null : new Set<string>(standings);
}
