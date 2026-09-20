/**
 * The lean INDEX of a scoped lead population: one small row per person, enough to count them,
 * search them, bucket them and order them — and nothing else.
 *
 * Every question the customer's Leads page asks about a population it is NOT rendering (how many
 * are in each tab, how many match this search, which fifty come first) needs a pass over the whole
 * matching set. Doing that with the list projection is what makes the page cost 44 MB and 6.6s: it
 * hydrates the full lead graph, resolves an audience, an offer and a standing per row, and
 * serializes all of it, to answer a question that only needs an id, an email and a timestamp.
 *
 * So the index is that narrow read. It runs over exactly the same relation the list runs over —
 * same scope, same dedup, same lifecycle filter (`leadCampaignBaseRelation`) — so a count taken
 * from it and a page taken from the list describe the same population by construction. The search
 * predicate lives HERE and only here: the list paths never search, they hydrate ids the index
 * already chose.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import {
  campaignScopeIds,
  leadCampaignBaseRelation,
  leadCursorTimestampParam,
  leadStatusScope,
  type LeadListCursor,
  type LeadListScope,
} from "./lead-list-query.js";
import { leadSearchPattern } from "./lead-search.js";
import { canonicalizeStepOutcome, type LeadStepOutcomeName } from "./step-statements.js";

/** One person in the scoped population, as narrow as the questions asked of it allow. */
export interface LeadIndexRow {
  /** `leads_campaigns.id` — the identity a list row carries, and what a page is hydrated by. */
  id: string;
  leadId: string;
  campaignId: string;
  brandIds: string[];
  status: string;
  /** The lead's registered email, or null. The key every delivery answer is keyed on. */
  email: string | null;
  servedAt: string | null;
  /** `created_at::text`, full precision — the position a default-ordered cursor is built from. */
  createdAtText: string;
}

interface RawIndexRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  brand_ids: string[];
  status: string;
  email_value: string | null;
  served_at: Date | string | null;
  created_at_cursor: string;
}

/** Every token must match at least one of the four searchable fields. Empty tokens → no predicate. */
function searchPredicate(tokens: readonly string[] | null) {
  if (!tokens || tokens.length === 0) return sql``;
  let predicate = sql``;
  for (const token of tokens) {
    const pattern = leadSearchPattern(token);
    predicate = sql`${predicate} AND (
      l.first_name ILIKE ${pattern}
      OR l.last_name ILIKE ${pattern}
      OR l.name ILIKE ${pattern}
      OR org.current_title ILIKE ${pattern}
      OR org.org_name ILIKE ${pattern}
      OR em.value ILIKE ${pattern}
    )`;
  }
  return predicate;
}

/**
 * One chunk of the scoped (and optionally searched) population: one row per person under brand
 * scope and one row per membership under a single-campaign scope — the same collapse the list
 * applies.
 *
 * Ordered `(created_at, id)` ascending, which is the list's own total order, so an index-driven
 * default-ordered page and a plain keyset page return the same rows in the same order.
 */
function leadIndexChunk(
  scope: LeadListScope,
  tokens: readonly string[] | null,
  after: LeadListCursor | null,
  chunkSize: number,
) {
  return sql<RawIndexRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.brand_ids, lc.status, lc.served_at,
      lc.created_at::text AS created_at_cursor,
      em.value AS email_value
    FROM ${leadCampaignBaseRelation(scope)}
    LEFT JOIN leads l ON l.id = lc.lead_id
    LEFT JOIN LATERAL (
      SELECT lo.title AS current_title, o.name AS org_name
      FROM leads_organizations lo
      LEFT JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.lead_id = lc.lead_id AND lo.current = true
      ORDER BY (CASE WHEN o.logo_url IS NOT NULL OR o.primary_domain IS NOT NULL THEN 1 ELSE 0 END) DESC,
               lo.created_at DESC NULLS LAST,
               lo.organization_id ASC
      LIMIT 1
    ) org ON true
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) em ON true
    WHERE lc.org_id = ${scope.orgId}
      ${scope.brandId ? sql`AND ${scope.brandId} = ANY(lc.brand_ids)` : sql``}
      ${campaignScopeIds(scope) ? sql`AND lc.campaign_id = ANY(${campaignScopeIds(scope)!})` : sql``}
      ${leadStatusScope(scope) ? sql`AND lc.status = ANY(${leadStatusScope(scope)!})` : sql``}
      ${scope.queryOrgId ? sql`AND lc.org_id = ${scope.queryOrgId}` : sql``}
      ${scope.userId ? sql`AND lc.user_id = ${scope.userId}` : sql``}
      ${scope.workflowSlug ? sql`AND lc.workflow_slug = ${scope.workflowSlug}` : sql``}
      ${searchPredicate(tokens)}
      ${after ? sql`AND (lc.created_at, lc.id) > (${leadCursorTimestampParam(after)}::timestamptz, ${after.id}::uuid)` : sql``}
    ORDER BY lc.created_at ASC, lc.id ASC
    LIMIT ${chunkSize}
  `;
}

function mapIndexRow(r: RawIndexRow): LeadIndexRow {
  return {
    id: r.id,
    leadId: r.lead_id,
    campaignId: r.campaign_id,
    brandIds: r.brand_ids,
    status: r.status,
    email: r.email_value,
    servedAt: toIsoTimestamp(r.served_at),
    createdAtText: r.created_at_cursor,
  };
}

/**
 * The same population, one BOUNDED chunk at a time, walked by keyset over `(created_at, id)`.
 *
 * This is the only way a filtered read is allowed to see the population, and the reason is a
 * production outage: the array form held every matching row — with its delivery overlay, its
 * buckets and its outcome set — before a single byte was written, which is about 3.4 KB per person
 * and 160 MB of peak heap on one brand's 16,599-row export. The process died on V8's heap limit
 * with exit code 0, the restart policy brought it straight back, and every other org's Leads page
 * got `ECONNREFUSED` for the seconds it was gone. One customer pressing a button was a
 * platform-wide outage, and nothing anywhere went red.
 *
 * `id` is unique, so `(created_at, id)` is a TOTAL order and the walk visits every row exactly
 * once — no gaps, no repeats — and it holds no connection between chunks (each chunk is its own
 * statement), so a long read cannot pin one of the pool's twenty.
 */
export async function* streamLeadIndex(
  scope: LeadListScope,
  tokens: readonly string[] | null,
  chunkSize: number,
): AsyncGenerator<LeadIndexRow[]> {
  const size = Math.max(1, chunkSize);
  let after: LeadListCursor | null = null;
  while (true) {
    const rows = await leadIndexChunk(scope, tokens, after, size);
    if (rows.length === 0) return;
    const mapped = rows.map(mapIndexRow);
    yield mapped;
    if (rows.length < size) return;
    const last = mapped[mapped.length - 1];
    after = { createdAt: last.createdAtText, id: last.id };
  }
}

/**
 * How many rows the scope matches, without reading any of them.
 *
 * This is what a BOUNDED read answers `total` with when it does not need an index (no search, no
 * bucket, default order): one aggregate over the same relation, so `total` and the page cannot
 * describe different populations.
 */
export async function countLeadListRows(scope: LeadListScope): Promise<number> {
  const rows = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM ${leadCampaignBaseRelation(scope)}
    WHERE lc.org_id = ${scope.orgId}
      ${scope.brandId ? sql`AND ${scope.brandId} = ANY(lc.brand_ids)` : sql``}
      ${campaignScopeIds(scope) ? sql`AND lc.campaign_id = ANY(${campaignScopeIds(scope)!})` : sql``}
      ${leadStatusScope(scope) ? sql`AND lc.status = ANY(${leadStatusScope(scope)!})` : sql``}
      ${scope.queryOrgId ? sql`AND lc.org_id = ${scope.queryOrgId}` : sql``}
      ${scope.userId ? sql`AND lc.user_id = ${scope.userId}` : sql``}
      ${scope.workflowSlug ? sql`AND lc.workflow_slug = ${scope.workflowSlug}` : sql``}
  `;
  return rows[0]?.n ?? 0;
}

/** What one lead holds in the outcome ledger: which steps, and when the latest of them happened. */
export interface LeadOutcomes {
  steps: Set<LeadStepOutcomeName>;
  latestAt: string | null;
}

/**
 * The live, attributed outcomes of a set of leads.
 *
 * Exactly the set the outcome COUNT reads answer for — `attribution_status = 'attributed'`, and a
 * statement its author withdrew is not a live outcome so nothing counts it. Scoped to the brand
 * when the read is, to the org otherwise, because an outcome belongs to the brand whose site (or
 * whose salesperson) observed it.
 *
 * Deliberately NOT suppressed for a measured visit the way `/conversion-counts` is: that
 * suppression exists so a consumer can ADD a hand-stated visit count to a measured click count
 * without double-counting. Here the two are unioned per PERSON (see bucketsForRow), so somebody
 * known both ways is already one row in the bucket and suppressing them would drop a person who
 * genuinely visited.
 */
export async function fetchOutcomesByLead(
  orgId: string,
  brandId: string | undefined,
  leadIds: readonly string[],
): Promise<Map<string, LeadOutcomes>> {
  const byLead = new Map<string, LeadOutcomes>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return byLead;

  const rows = await sql<Array<{ lead_id: string; event: string; latest: Date | string | null }>>`
    SELECT ce.matched_lead_id AS lead_id, ce.event, max(ce.received_at) AS latest
    FROM conversion_events ce
    WHERE ce.org_id = ${orgId}
      AND ce.attribution_status = 'attributed'
      AND ce.withdrawn_at IS NULL
      AND ce.matched_lead_id = ANY(${[...ids]}::uuid[])
      ${brandId ? sql`AND ce.brand_id = ${brandId}` : sql``}
    GROUP BY ce.matched_lead_id, ce.event
  `;

  for (const row of rows) {
    const canonical = canonicalizeStepOutcome(row.event);
    if (!canonical) continue;
    const latest = toIsoTimestamp(row.latest);
    const existing = byLead.get(row.lead_id) ?? { steps: new Set<LeadStepOutcomeName>(), latestAt: null };
    existing.steps.add(canonical);
    if (latest && (existing.latestAt === null || latest > existing.latestAt)) {
      existing.latestAt = latest;
    }
    byLead.set(row.lead_id, existing);
  }
  return byLead;
}
