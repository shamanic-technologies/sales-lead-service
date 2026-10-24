/**
 * The IO half of "when did each lead first reach each state" (rules in `lead-states.ts`, LEAD-STATES-1024).
 *
 * ONE statement gathers the earliest instant of every evidence kind per (org, brand, lead), each at the moment the
 * prospect acted, never a sync or declaration time:
 *   - replies to our outreach the sender classified positive: `lead_timeline_facts` (source `reply`), `occurred_at` =
 *     the reply's own instant on the outreach fact copy;
 *   - personal-channel messages Jev judged interest: `personal_message_judgments` (`waits_interest`), the message's
 *     `occurred_at`;
 *   - the outcome ledger (`conversion_events`, live, attributed to a lead: a person's statement, the CRM, the site tag,
 *     a reply): `positive_reply` (a CRM form after our first email), meetings, sales, stated visits, dated
 *     `received_at` = the fact's own instant (the CRM sync writes the earliest dated CRM event; a person states it);
 *   - measured clicks of our email's link to the brand's site: `lead_timeline_facts` label `website_visit`, source
 *     `outreach`, the click's instant;
 *   - sessions on the brand's site the brand's analytics saw: `crm_facts` type `website_visit` (not withdrawn), the
 *     person = a lead of the org at that brand holding one of the fact's addresses.
 * A lead the org marked NOT A PERSON (or every address staff) is never returned (not-a-person.ts).
 *
 * Walk order is (org, brand, lead) with an opaque keyset cursor. The evidence set is small (thousands of rows
 * fleet-wide): each page re-derives it whole and cuts by the cursor; nothing is held across calls.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { firstReachedStates, LEAD_STATE_EVIDENCE_KINDS, type LeadStateEvidenceKind, type LeadStates, type StateEvidence } from "./lead-states.js";

export interface LeadStatesRow {
  orgId: string;
  brandId: string;
  leadId: string;
  states: LeadStates;
}

export interface LeadStatesQuery {
  /** Only this org's leads. */
  orgId?: string;
  /** Only these leads (every brand and org they hold a state at). */
  leadIds?: readonly string[];
  /** Keys strictly after this position (walk). */
  after?: { orgId: string; brandId: string; leadId: string } | null;
  /** Max (org, brand, lead) keys answered; absent = all (by-lead reads). */
  limit?: number;
}

export class LeadStatesCursorError extends Error {}

export function encodeLeadStatesCursor(k: { orgId: string; brandId: string; leadId: string }): string {
  return Buffer.from(JSON.stringify([k.orgId, k.brandId, k.leadId]), "utf8").toString("base64url");
}

export function decodeLeadStatesCursor(cursor: string): { orgId: string; brandId: string; leadId: string } {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "string" && x.length > 0)) {
      return { orgId: v[0], brandId: v[1], leadId: v[2] };
    }
  } catch {
    // fall through: refused below
  }
  throw new LeadStatesCursorError("cursor is not a position this endpoint issued");
}

/** Each source's lead filter (the column naming the lead in that source). */
function leadFilter(col: SQL, q: LeadStatesQuery): SQL {
  return q.leadIds ? sql`AND ${col} = ANY(${sql.param([...q.leadIds])}::uuid[])` : sql.empty();
}
function orgFilter(col: SQL, q: LeadStatesQuery): SQL {
  return q.orgId ? sql`AND ${col} = ${q.orgId}` : sql.empty();
}

/** The evidence statement (exported for its integration test). */
export function leadStatesEvidenceSql(q: LeadStatesQuery): SQL {
  const after = q.after
    ? sql`WHERE (a.org_id, a.brand_id, a.lead_id::text) > (${q.after.orgId}, ${q.after.brandId}, ${q.after.leadId})`
    : sql.empty();
  const limit = q.limit !== undefined ? sql`LIMIT ${q.limit}` : sql.empty();
  return sql`
    WITH ev AS (
      SELECT t.org_id, t.brand_id, t.lead_id, 'positive_reply'::text AS kind, t.occurred_at AS at
      FROM lead_timeline_facts t
      WHERE t.source = 'reply' AND t.withdrawn_at IS NULL AND t.detail->>'classification' = 'positive'
        ${orgFilter(sql`t.org_id`, q)} ${leadFilter(sql`t.lead_id`, q)}
      UNION ALL
      SELECT j.org_id, j.brand_id, j.lead_id, 'positive_message', j.occurred_at
      FROM personal_message_judgments j
      WHERE j.verdict = 'waits_interest'
        ${orgFilter(sql`j.org_id`, q)} ${leadFilter(sql`j.lead_id`, q)}
      UNION ALL
      SELECT ce.org_id, ce.brand_id, ce.matched_lead_id,
             CASE ce.event
               WHEN 'positive_reply' THEN CASE WHEN ce.source = 'crm' THEN 'form_reply' ELSE 'positive_reply' END
               WHEN 'meeting_booked' THEN 'meeting_booked'
               WHEN 'meeting_attended' THEN 'meeting_attended'
               WHEN 'website_visit' THEN 'stated_visit'
               ELSE 'sale'
             END,
             ce.received_at
      FROM conversion_events ce
      WHERE ce.event IN ('positive_reply', 'meeting_booked', 'meeting_attended', 'sale', 'purchase', 'website_visit')
        AND ce.withdrawn_at IS NULL AND ce.attribution_status = 'attributed' AND ce.matched_lead_id IS NOT NULL
        ${orgFilter(sql`ce.org_id`, q)} ${leadFilter(sql`ce.matched_lead_id`, q)}
      UNION ALL
      SELECT t.org_id, t.brand_id, t.lead_id, 'click', t.occurred_at
      FROM lead_timeline_facts t
      WHERE t.label = 'website_visit' AND t.source = 'outreach' AND t.withdrawn_at IS NULL
        ${orgFilter(sql`t.org_id`, q)} ${leadFilter(sql`t.lead_id`, q)}
      UNION ALL
      SELECT f.org_id, f.brand_id, m.lead_id, 'site_session', f.occurred_at
      FROM crm_facts f
      CROSS JOIN LATERAL unnest(f.emails) AS e(addr)
      JOIN lead_contact_methods m ON m.channel = 'email' AND lower(m.value) = lower(trim(e.addr))
      -- A per-row probe by lead (index), never a semi join: the planner's estimate made it hash every leads_campaigns row.
      JOIN LATERAL (
        SELECT 1 FROM leads_campaigns lc
        WHERE lc.lead_id = m.lead_id AND lc.org_id = f.org_id AND f.brand_id = ANY(lc.brand_ids)
        LIMIT 1
      ) member ON true
      WHERE f.type = 'website_visit'
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
        ${orgFilter(sql`f.org_id`, q)} ${leadFilter(sql`m.lead_id`, q)}
    ),
    agg AS (
      SELECT ev.org_id, ev.brand_id, ev.lead_id, ev.kind, min(ev.at) AS at
      FROM ev
      WHERE NOT EXISTS (
        SELECT 1 FROM not_a_person_marks npm
        WHERE npm.org_id = ev.org_id AND npm.lead_id = ev.lead_id AND npm.withdrawn_at IS NULL)
      GROUP BY 1, 2, 3, 4
    ),
    keys AS (
      SELECT DISTINCT a.org_id, a.brand_id, a.lead_id
      FROM agg a
      ${after}
      ORDER BY a.org_id, a.brand_id, a.lead_id
      ${limit}
    )
    SELECT a.org_id, a.brand_id, a.lead_id::text AS lead_id, a.kind, a.at
    FROM agg a JOIN keys k ON k.org_id = a.org_id AND k.brand_id = a.brand_id AND k.lead_id = a.lead_id
    ORDER BY a.org_id, a.brand_id, a.lead_id
  `;
}

interface RawEvidence {
  org_id: string;
  brand_id: string;
  lead_id: string;
  kind: string;
  at: RawTimestamp;
}

/** Group evidence rows (ordered by key) into one answer per lead x brand. An unknown kind throws (never dropped). */
export function groupLeadStates(rows: readonly RawEvidence[]): LeadStatesRow[] {
  const out: LeadStatesRow[] = [];
  let key = "";
  let current: { orgId: string; brandId: string; leadId: string; evidence: StateEvidence[] } | null = null;
  const flush = () => {
    if (current) out.push({ orgId: current.orgId, brandId: current.brandId, leadId: current.leadId, states: firstReachedStates(current.evidence) });
  };
  for (const r of rows) {
    if (!(LEAD_STATE_EVIDENCE_KINDS as readonly string[]).includes(r.kind)) throw new Error(`lead-states: unknown evidence kind "${r.kind}"`);
    const k = `${r.org_id}|${r.brand_id}|${r.lead_id}`;
    if (k !== key) {
      flush();
      key = k;
      current = { orgId: String(r.org_id), brandId: String(r.brand_id), leadId: String(r.lead_id), evidence: [] };
    }
    current!.evidence.push({ kind: r.kind as LeadStateEvidenceKind, at: r.at === null ? null : toIsoTimestamp(r.at) });
  }
  flush();
  return out;
}

/** One page of lead x brand states (or every one for `leadIds`). Throws on any database error. */
export async function readLeadStates(q: LeadStatesQuery): Promise<{ leads: LeadStatesRow[]; nextCursor: string | null }> {
  const rows = (await db.execute(leadStatesEvidenceSql(q))) as unknown as RawEvidence[];
  const leads = groupLeadStates(rows);
  const last = leads[leads.length - 1];
  const nextCursor = q.limit !== undefined && last && leads.length === q.limit ? encodeLeadStatesCursor(last) : null;
  return { leads, nextCursor };
}
