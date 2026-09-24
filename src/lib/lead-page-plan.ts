/**
 * The ORDER a filtered read is in. The order itself is taken in the database over the scope's read
 * model (see lead-read-model.ts); what lives here is the vocabulary a caller names it by.
 */

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
