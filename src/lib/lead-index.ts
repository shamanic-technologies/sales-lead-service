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
 * from it and a page taken from the list describe the same population by construction.
 *
 * It is not read per request any more: it is what the read model (lead-read-model.ts) is BUILT
 * from, and the model is what a count, a search or a filtered page reads. The list paths never
 * search; they hydrate ids the model already chose.
 */
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import {
  campaignScopeIds,
  leadCampaignBaseRelation,
  leadStatusScope,
  type LeadListScope,
} from "./lead-list-query.js";
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
  /**
   * The four things a person is searched by — name, job title, company, address — joined with a
   * newline. A search token never contains whitespace (see lead-search.ts) and `_` is escaped, so a
   * token can only match INSIDE one field, never across two: `search_text ILIKE %token%` means
   * exactly "some field contains the token", the predicate this read has always applied per field.
   */
  searchText: string;
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
  search_text: string | null;
}

/**
 * The scoped population as ONE statement: one row per person under brand scope and one row per
 * membership under a single-campaign scope — the same collapse the list applies — ordered
 * `(created_at, id)` ascending, which is the list's own total order.
 *
 * One statement, streamed through a server-side cursor, rather than a statement per chunk: every
 * chunk statement re-ran the brand's whole-population dedup just to cut the next thousand rows
 * off it, which is what made the walk cost 4.8s on a 17,910-person brand. `scope.leadIds` narrows
 * it to a handful of people for an incremental recompute (see lead-read-model.ts).
 */
function leadIndexStatement(scope: LeadListScope) {
  return sql<RawIndexRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.brand_ids, lc.status, lc.served_at,
      lc.created_at::text AS created_at_cursor,
      em.value AS email_value,
      concat_ws(E'\n', l.first_name, l.last_name, l.name, org.current_title, org.org_name, em.value)
        AS search_text
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
      ${scope.leadIds ? sql`AND lc.lead_id = ANY(${[...scope.leadIds]}::uuid[])` : sql``}
    ORDER BY lc.created_at ASC, lc.id ASC
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
    searchText: r.search_text ?? "",
  };
}

/**
 * The same population, one BOUNDED chunk at a time.
 *
 * This process never holds the population: a filtered read used to, at about 3.4 KB per person,
 * and 160 MB of peak heap on one brand's export killed the process on V8's heap limit (exit code
 * 0, restart policy, every other org's Leads page down for the seconds it was gone). The chunk is
 * the only thing alive at a time; the cursor holds one connection for the walk.
 */
export async function* streamLeadIndex(
  scope: LeadListScope,
  chunkSize: number,
): AsyncGenerator<LeadIndexRow[]> {
  const size = Math.max(1, chunkSize);
  for await (const rows of leadIndexStatement(scope).cursor(size)) {
    if (rows.length === 0) continue;
    yield rows.map(mapIndexRow);
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
  /**
   * A positive reply the LEDGER holds for this lead — today only what their own CRM evidences (a
   * form their prospect submitted after our first email). Not a step outcome, so it is carried
   * beside `steps`, and the bucket reads it beside the delivery layer's own positive reply.
   */
  positiveReply?: boolean;
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
    const positiveReply = row.event === CRM_POSITIVE_REPLY_STEP;
    if (!canonical && !positiveReply) continue;
    const latest = toIsoTimestamp(row.latest);
    const existing: LeadOutcomes = byLead.get(row.lead_id) ?? {
      steps: new Set<LeadStepOutcomeName>(),
      latestAt: null,
    };
    if (canonical) existing.steps.add(canonical);
    if (positiveReply) existing.positiveReply = true;
    if (latest && (existing.latestAt === null || latest > existing.latestAt)) {
      existing.latestAt = latest;
    }
    byLead.set(row.lead_id, existing);
  }
  return byLead;
}
