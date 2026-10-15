import { sql, type SQL } from "drizzle-orm";

/**
 * Tactic "Fresh contacts only" (FRESH-CONTACTS-1015, owner 2026-10-15): a workflow's serve may ask that nobody the
 * brand EMAILED inside a window is handed out. The window is the tactic's name (one fixed value today; another
 * duration would be another tactic). It is the WORKFLOW's choice, never a rule of the sender or of a pipe: a serve that
 * does not ask gets no such skip (a client naming the person, a re-engagement play).
 *
 * "Who did this brand email, when" is instantly-service's fact (the performer). It is read off the bronze copy of what
 * instantly-service announces (`outreach_facts`, src/lib/outreach-fact-feed.ts): its `email_sent` facts are exactly
 * the evidence its own send-time window reads (real, non-inferred `email_sent` events of a campaign naming the brand).
 * Never derived from serves, queues or leads_campaigns dates.
 *
 * A person skipped is never consumed here: the pools filter them in SQL (they stay where they are), and a person a
 * FRESH serve bought anyway stays filed under the asking campaign (its paid pool, or the source's stock) for a later
 * serve once the window lapses or for a pipe that does not ask.
 */
export const RECENTLY_EMAILED_WINDOWS = ["3_months"] as const;
export type RecentlyEmailedWindow = (typeof RECENTLY_EMAILED_WINDOWS)[number];

const WINDOW_INTERVAL: Record<RecentlyEmailedWindow, string> = { "3_months": "3 months" };

/** The window the serve asked for and the brand(s) the serve is made for. */
export interface RecentlyEmailedScope {
  window: RecentlyEmailedWindow;
  brandIds: readonly string[];
}

/**
 * `EXISTS (...)`: one of the lead's registered emails received an email of one of the brands inside the window. The
 * latest fact of a subject decides (a correction or withdrawal supersedes the send). Calendar months, evaluated by
 * Postgres, like the sender's own window.
 */
export function emailedWithin(leadId: SQL, scope: RecentlyEmailedScope): SQL {
  const interval = sql.raw(`interval '${WINDOW_INTERVAL[scope.window]}'`);
  return sql`EXISTS (
    SELECT 1 FROM lead_contact_methods cm_re
    JOIN outreach_facts f_re ON f_re.lead_email = lower(cm_re.value) AND f_re.type = 'email_sent'
    WHERE cm_re.lead_id = ${leadId} AND cm_re.channel = 'email'
      AND f_re.brand_ids && ${sql.param([...scope.brandIds])}::text[]
      AND f_re.occurred_at > now() - ${interval}
      AND NOT EXISTS (SELECT 1 FROM outreach_facts w_re WHERE w_re.subject_key = f_re.subject_key AND w_re.seq > f_re.seq))`;
}

/** Pool fragment: `AND NOT EXISTS (...)`. Nothing asked (or no brand) = empty, bytes unchanged. */
export function recentlyEmailedClause(leadId: SQL, scope: RecentlyEmailedScope | null | undefined): SQL {
  if (!scope || scope.brandIds.length === 0) return sql``;
  return sql`AND NOT ${emailedWithin(leadId, scope)}`;
}
