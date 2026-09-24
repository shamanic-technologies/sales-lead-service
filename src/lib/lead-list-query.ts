import { sql } from "../db/index.js";

// Shared scope for the two `GET /orgs/leads` code paths (slim `?view=basic` and the
// default full path). Mirrors the headers/query the route reads. `leads_campaigns`
// holds one row per (person × campaign-membership/serve), so a person engaged across
// N campaigns for a brand otherwise appears N times in a brand/org-scoped list.
export interface LeadListScope {
  orgId: string;
  brandId?: string;
  /** The campaign the caller asked for. Kept for logging/telemetry; the FILTER is campaignIds. */
  campaignId?: string;
  /**
   * The OFFER the caller asked for. Kept for logging/telemetry; the FILTER is campaignIds.
   *
   * A lead's offer is the offer named by the campaign it was served under (see
   * offer-campaigns-client.ts), and `leads_campaigns.campaign_id` is that frozen attribution — so
   * offer scope resolves to a set of campaign ids and rides the campaign-id filter below rather
   * than adding a parallel one. It is therefore mutually exclusive with `campaignId`: a campaign
   * already sells exactly one offer, so naming both is contradictory and the route 400s it.
   *
   * Set only when `campaignIds` is NON-EMPTY. An offer that resolves to no campaigns matches
   * nothing, and the route answers it with an empty list before a scope is ever built — never by
   * dropping the filter, which would serve the whole brand under the offer's name.
   */
  offerId?: string;
  /**
   * The ONE sales funnel of `offerId` the caller asked for, canonical. Kept for logging/telemetry;
   * the FILTER is campaignIds, which the route narrows to the offer's campaigns that STATE this
   * funnel (offer-campaigns-client.ts). Only ever set alongside `offerId`.
   */
  funnelKey?: string;
  /**
   * The campaign IDENTITY's members — every stored campaign row the customer reads as the ONE
   * campaign they asked for (see campaign-identity.ts). Resolved by the route from campaign-service;
   * `[campaignId]` when the identity has a single member or could not be resolved. Absent means the
   * read is not campaign-scoped at all.
   *
   * Under an OFFER scope this is instead every campaign in the org that names that offer (see
   * `offerId`). Either way it is the one campaign-id filter both list queries apply.
   */
  campaignIds?: string[];
  queryOrgId?: string;
  userId?: string;
  workflowSlug?: string;
  /**
   * The lifecycle statuses the read answers for. Always populated by the route — absent from a
   * caller's query means DEFAULT_LEAD_LIST_STATUSES, never "no filter". See parseLeadStatusFilter.
   */
  statuses?: readonly string[];
  /**
   * The exact membership rows to return, named by id — the OUTER filter of an index-driven read.
   *
   * A read that searches, buckets or re-orders picks its page from the lean index (lead-index.ts)
   * and then hydrates those ids and nothing else. Applied on the OUTER query only, NEVER inside
   * the dedup subquery: the ids ARE the winners that subquery already picked, so filtering them
   * earlier would change which membership row wins for a person and hand back a different row than
   * the one counted. Row ORDER is restored by the caller from the index, not by this filter.
   */
  rowIds?: readonly string[];
  /**
   * Restrict the read to these PEOPLE (`leads_campaigns.lead_id`). Unlike `rowIds` this is safe
   * INSIDE the dedup subquery: the dedup is per person (`DISTINCT ON (lead_id)`), so narrowing to a
   * set of people never changes which membership row wins for any of them. It is what lets the read
   * model (lead-read-model.ts) recompute a handful of people without re-deduping a whole brand.
   */
  leadIds?: readonly string[];
}

/**
 * How much of the population a read returns, and where it starts.
 *
 * `limit` absent means UNBOUNDED — the whole scoped population, which is what the staff console
 * and features-service want and what every caller got before this existed. A caller that names a
 * limit gets at most that many rows and a `nextCursor` to walk the rest with.
 *
 * The walk is keyset, over the same total order both list queries already use — `(created_at, id)`
 * ascending on the (possibly deduped) membership relation. `id` is unique, so the order is total:
 * no two rows tie, and a walk visits every row exactly once. `offset` is the positional form the
 * gateway's published contract advertises; it is honoured over the same order, but `cursor` is the
 * one that cannot drift under concurrent writes.
 */
export interface LeadListPage {
  /** Max rows to return. null = unbounded (the whole scoped population). */
  limit: number | null;
  /** Keyset start position, exclusive. Mutually exclusive with `offset`. */
  cursor: LeadListCursor | null;
  /** Positional start, over the same order. Mutually exclusive with `cursor`. */
  offset: number | null;
}

/**
 * A position in the `(created_at, id)` order the list queries walk.
 *
 * `createdAt` is TEXT, straight out of Postgres (`lc.created_at::text`) and carried through the
 * cursor verbatim — never a `Date`, and never re-rendered through one. Two reasons, both of which
 * were production failures:
 *
 * 1. PRECISION. `timestamptz` holds MICROseconds; a JS `Date` holds milliseconds. Round-tripping
 *    the position through a `Date` floors it, so the resumed page re-reads every row whose
 *    `created_at` falls in the microseconds that were dropped. A full walk of one 57k-row brand
 *    came back with 57,737 rows for 57,622 people — 115 repeats, no gaps. Text keeps every digit,
 *    so `>` means exactly what the previous page ended at.
 * 2. BIND. postgres.js's Bind calls `Buffer.byteLength()` on a raw `sql` param, which throws
 *    `ERR_INVALID_ARG_TYPE ... Received an instance of Date` before the query is ever sent, so a
 *    `Date` position 500s every resumed page.
 *
 * The queries select the column twice — typed for the row payload, and `::text` for this.
 */
export interface LeadListCursor {
  /** `lc.created_at::text` — full-precision, bindable as-is. */
  createdAt: string;
  id: string;
}

/** The value to BIND for a cursor's timestamp: the text Postgres gave us, unmodified. */
export function leadCursorTimestampParam(cursor: LeadListCursor): string {
  return cursor.createdAt;
}

/** Fail loud on a cursor timestamp that is not a timestamp at all. */
function assertCursorTimestamp(value: string): string {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`[lead-service] invalid cursor created_at timestamp: ${value}`);
  }
  return value;
}

/** The unbounded read: what a caller that names no bound gets, exactly as before. */
export const UNBOUNDED_LEAD_PAGE: LeadListPage = { limit: null, cursor: null, offset: null };

/**
 * Resolve `limit` into a row bound. Absent → null (unbounded). Anything that is not a positive
 * integer is a 400 (throws) — a caller that asks for `limit=abc` or `limit=0` gets told, never a
 * silently-ignored bound, which is the bug this exists to close.
 */
export function parseLeadLimit(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") throw new Error("limit must be a single positive integer");
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`limit must be a positive integer, got: ${raw}`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`limit must be a positive integer, got: ${raw}`);
  }
  return value;
}

/** Resolve `offset` into a positional start. Absent → null. Non-integer / negative → 400. */
export function parseLeadOffset(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") throw new Error("offset must be a single non-negative integer");
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`offset must be a non-negative integer, got: ${raw}`);
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`offset must be a non-negative integer, got: ${raw}`);
  }
  return value;
}

/** Serialize a walk position into the opaque `nextCursor` string a caller hands back. */
export function encodeLeadCursor(cursor: LeadListCursor): string {
  const payload = JSON.stringify({ t: assertCursorTimestamp(cursor.createdAt), i: cursor.id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

/** Parse a caller-supplied `cursor`. Absent → null. Anything unreadable is a 400, never ignored. */
export function decodeLeadCursor(raw: unknown): LeadListCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("cursor must be a single non-empty string returned as nextCursor");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is not a cursor this endpoint issued");
  }
  const value = parsed as { t?: unknown; i?: unknown };
  if (typeof value?.t !== "string" || typeof value?.i !== "string" || value.i === "") {
    throw new Error("cursor is not a cursor this endpoint issued");
  }
  // Kept as TEXT, byte for byte — parsing it into a Date here would drop the microseconds the
  // walk depends on (see LeadListCursor).
  if (Number.isNaN(new Date(value.t).getTime())) {
    throw new Error("cursor is not a cursor this endpoint issued");
  }
  return { createdAt: value.t, id: value.i };
}

/**
 * Resolve the `limit` / `cursor` / `offset` query params into one page descriptor.
 * `cursor` and `offset` both name a start position, so naming both is a 400 rather than a
 * silent pick of one.
 */
export function parseLeadListPage(query: {
  limit?: unknown;
  cursor?: unknown;
  offset?: unknown;
}): LeadListPage {
  const limit = parseLeadLimit(query.limit);
  const cursor = decodeLeadCursor(query.cursor);
  const offset = parseLeadOffset(query.offset);
  if (cursor && offset !== null) {
    throw new Error("cursor and offset both name a start position — pass one, not both");
  }
  return { limit, cursor, offset };
}

/** Every lifecycle state a `leads_campaigns` row can hold. */
export const LEAD_LIFECYCLE_STATUSES = ["buffered", "skipped", "claimed", "served"] as const;
export type LeadLifecycleStatus = (typeof LEAD_LIFECYCLE_STATUSES)[number];

/**
 * What `GET /orgs/leads` answers with when the caller names no status: the population a consumer
 * can act on.
 *
 * `skipped` is excluded. A skipped row was never served, so it never carries delivery evidence —
 * the overlay is only fetched for `status = 'served'` rows and every engagement field on a skipped
 * row is false/null by construction. It is therefore unreachable from the customer dashboard (every
 * tab there buckets on an engagement step) and scores zero in features-service's revenue engine
 * (which keeps only persons with EV > 0 or a delivery milestone). For a large brand it is also ~82%
 * of the rows and of the bytes, on an endpoint the dashboard polls every 30s. A caller that wants
 * it asks for it: `?status=skipped`, or `?status=all` for the whole set.
 */
export const DEFAULT_LEAD_LIST_STATUSES: readonly LeadLifecycleStatus[] = ["buffered", "claimed", "served"];

/**
 * Resolve the `status` query param into the statuses a read answers for.
 *
 * Absent  → DEFAULT_LEAD_LIST_STATUSES. `all` → every lifecycle status. Otherwise a comma-separated
 * list of lifecycle statuses. Fails loud (throws) on anything else: an unknown or empty value is a
 * 400, never a silent fallback to a population the caller did not ask for.
 */
export function parseLeadStatusFilter(raw: unknown): readonly LeadLifecycleStatus[] {
  if (raw === undefined) return DEFAULT_LEAD_LIST_STATUSES;
  if (typeof raw !== "string") {
    throw new Error("status must be a single comma-separated string");
  }
  const trimmed = raw.trim();
  if (trimmed === "all") return LEAD_LIFECYCLE_STATUSES;

  const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`status must name at least one of: ${LEAD_LIFECYCLE_STATUSES.join(", ")}, or "all"`);
  }
  const unknown = parts.filter((p) => !(LEAD_LIFECYCLE_STATUSES as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown status value(s): ${unknown.join(", ")}. Valid: ${LEAD_LIFECYCLE_STATUSES.join(", ")}, or "all"`,
    );
  }
  return Array.from(new Set(parts)) as LeadLifecycleStatus[];
}

/**
 * The statuses a scope filters on, or null when it names every one of them (nothing to filter).
 * Both list queries apply it, and the dedup subquery applies it too so the winning membership row
 * is chosen among the statuses the caller asked for.
 */
export function leadStatusScope(f: LeadListScope): string[] | null {
  const statuses = f.statuses ?? DEFAULT_LEAD_LIST_STATUSES;
  if (statuses.length >= LEAD_LIFECYCLE_STATUSES.length) return null;
  return [...statuses];
}

/** The membership-row ids an index-driven read hydrates, or null when the read is not one. */
export function leadRowIdScope(f: LeadListScope): string[] | null {
  return f.rowIds && f.rowIds.length > 0 ? [...f.rowIds] : null;
}

/** The campaign ids a scope filters on, or null when the read is brand/org-scoped. */
export function campaignScopeIds(f: LeadListScope): string[] | null {
  if (f.campaignIds && f.campaignIds.length > 0) return f.campaignIds;
  return f.campaignId ? [f.campaignId] : null;
}

// Brand/org-scoped reads must be ONE row per PERSON, not one per campaign-membership.
// A campaign scope resolving to a SINGLE stored row is already ~1 row per person, so it stays flat
// — that also guarantees a genuine per-campaign membership row is never silently collapsed.
// A MULTI-member identity is the same shape as brand scope (one person can hold a membership row
// under several of the identity's stopped ancestors), so it collapses the same way: without this a
// campaign-scoped count would exceed the brand-scoped one for the same population.
export function shouldDedupeLeadList(f: LeadListScope): boolean {
  const ids = campaignScopeIds(f);
  return ids === null || ids.length > 1;
}

// Base relation aliased as `lc` for the list queries.
//
// For brand/org scope, collapse `leads_campaigns` to the single winning membership per
// `lead_id` via DISTINCT ON. The winner is the most-advanced lifecycle row (served >
// claimed > buffered > skipped) so the kept row fires the served-only delivery overlay
// whenever the person was served under ANY campaign; ties break on latest served_at,
// latest created_at, then stable id. The delivery overlay is keyed by EMAIL at brand
// scope and is identical across a person's rows, so whichever membership wins carries
// the person's full brand-level engagement (clicked/opened/replied OR-merged inherently).
//
// A campaign scope carrying SEVERAL stored rows (one campaign IDENTITY, its live row plus the
// stopped ancestors it kept switching workflows through) takes the same collapse: the same person
// can hold a membership row under several members, and the delivery overlay for that scope is
// keyed by email across the whole family, so the winning row carries the person's engagement there
// too. A single-row campaign scope stays flat, byte for byte as before.
//
// The DISTINCT ON must be GLOBAL (computed over the whole filtered set), so it lives in
// a subquery; the outer query then keyset-paginates / orders the DEDUPED relation by
// (created_at, id). Scope filters are applied here AND on the outer WHERE — duplicate
// predicates on the deduped relation are a harmless no-op, but they are REQUIRED on the
// outer query for the non-deduped (single-campaign) path.
export function leadCampaignBaseRelation(f: LeadListScope) {
  const campaignIds = campaignScopeIds(f);
  if (!shouldDedupeLeadList(f)) {
    return sql`leads_campaigns lc`;
  }
  return sql`(
    SELECT DISTINCT ON (lc0.lead_id) lc0.*
    FROM leads_campaigns lc0
    WHERE lc0.org_id = ${f.orgId}
      ${f.brandId ? sql`AND ${f.brandId} = ANY(lc0.brand_ids)` : sql``}
      ${campaignIds ? sql`AND lc0.campaign_id = ANY(${campaignIds})` : sql``}
      ${leadStatusScope(f) ? sql`AND lc0.status = ANY(${leadStatusScope(f)!})` : sql``}
      ${f.queryOrgId ? sql`AND lc0.org_id = ${f.queryOrgId}` : sql``}
      ${f.userId ? sql`AND lc0.user_id = ${f.userId}` : sql``}
      ${f.workflowSlug ? sql`AND lc0.workflow_slug = ${f.workflowSlug}` : sql``}
      ${f.leadIds ? sql`AND lc0.lead_id = ANY(${[...f.leadIds]}::uuid[])` : sql``}
    ORDER BY lc0.lead_id,
      CASE lc0.status
        WHEN 'served' THEN 3
        WHEN 'claimed' THEN 2
        WHEN 'buffered' THEN 1
        ELSE 0
      END DESC,
      lc0.served_at DESC NULLS LAST,
      lc0.created_at DESC,
      lc0.id DESC
  ) lc`;
}
