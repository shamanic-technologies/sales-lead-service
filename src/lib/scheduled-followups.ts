import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";

/**
 * WHAT A CAMPAIGN HAS SCHEDULED, ON EVERY CHANNEL (NEXT-STEPS-ALL-CHANNELS-1019): the people a campaign's writer will
 * follow up, and when. A follow-up writer (email reply in the last thread, WhatsApp, LinkedIn...) mostly STATES a date
 * for the next touch here rather than queueing a message in a sender, so a sender's queue alone reads "nothing queued"
 * while dozens of people are scheduled for Monday 09:00 their time.
 *
 * Two facts, both this service's own:
 *   - `lead_followup_dates` rows whose date was last stated by one of the campaigns (`stated_by_campaign_id`), still
 *     standing: a stop (`stopped`) and a "not owed, asked again in 30 days" (`stop_recheck`) are NOT a scheduled
 *     follow-up; any other basis is (a later send of ours moved it, the serve handed them, the verdict said "not yet");
 *   - the reactive follow-up queue rows of the campaigns (`leads_campaigns.followup_due_at`).
 * One person counts once, at their EARLIEST time. `due` = the time passed (they go out on the follow-up pipe's next
 * pass), `upcoming` = still ahead. Days are UTC dates; each time is already the writer's pick in the person's own
 * local working hours.
 */

export const SCHEDULED_BY_DAY_HORIZON_DAYS = 31;

export interface ScheduledFollowups {
  asOf: string;
  /** People with a follow-up scheduled by these campaigns (due + upcoming). */
  leads: number;
  /** Their time passed: they go out on the follow-up pipe's next pass. */
  due: number;
  /** Their time is still ahead. */
  upcoming: number;
  /** The earliest time still ahead (ISO); null when nothing is ahead. */
  nextAt: string | null;
  /** The longest-waiting due time (ISO); null when nothing is due. */
  oldestDueAt: string | null;
  /** Upcoming people per UTC day over the next `SCHEDULED_BY_DAY_HORIZON_DAYS` days, earliest first. */
  byDay: Array<{ date: string; leads: number; firstAt: string }>;
  /** Upcoming people scheduled beyond that horizon. */
  laterThanHorizon: number;
}

type Ts = Date | string | null;

export async function loadScheduledFollowups(orgId: string, campaignIds: readonly string[]): Promise<ScheduledFollowups> {
  const ids = sql.param([...new Set(campaignIds)]);
  const horizon = sql.raw(`interval '${SCHEDULED_BY_DAY_HORIZON_DAYS} days'`);
  const rows = (await db.execute(sql`
    WITH dated AS (
      SELECT d.lead_id, d.next_followup_at AS at FROM lead_followup_dates d
      WHERE d.org_id = ${orgId} AND d.stated_by_campaign_id = ANY(${ids}::text[])
        AND d.next_followup_at IS NOT NULL AND d.basis NOT IN ('stopped', 'stop_recheck')
      UNION ALL
      SELECT lc.lead_id, lc.followup_due_at AS at FROM leads_campaigns lc
      WHERE lc.org_id = ${orgId} AND lc.campaign_id = ANY(${ids}::text[]) AND lc.followup_due_at IS NOT NULL
    ),
    per_lead AS (SELECT lead_id, min(at) AS at FROM dated GROUP BY lead_id),
    clock AS (SELECT now() AS now)
    SELECT 'total' AS kind, NULL::text AS day, count(*)::int AS n,
      count(*) FILTER (WHERE at <= clock.now)::int AS due,
      min(at) FILTER (WHERE at > clock.now) AS next_at,
      min(at) FILTER (WHERE at <= clock.now) AS oldest_due_at,
      count(*) FILTER (WHERE at > clock.now + ${horizon})::int AS later,
      (SELECT now FROM clock) AS as_of
    FROM per_lead, clock
    UNION ALL
    SELECT 'day', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), count(*)::int, 0, min(at), NULL, 0, NULL
    FROM per_lead, clock WHERE at > clock.now AND at <= clock.now + ${horizon}
    GROUP BY 2
    ORDER BY 1 DESC, 2 ASC
  `)) as unknown as Array<{ kind: string; day: string | null; n: number; due: number; next_at: Ts; oldest_due_at: Ts; later: number; as_of: Ts }>;
  const total = rows.find((r) => r.kind === "total");
  if (!total) throw new Error("scheduled-followups: the total row is missing");
  const iso = (v: Ts): string | null => (v === null || v === undefined ? null : toIsoTimestamp(v));
  const leads = Number(total.n);
  const due = Number(total.due);
  return {
    asOf: iso(total.as_of)!,
    leads,
    due,
    upcoming: leads - due,
    nextAt: iso(total.next_at),
    oldestDueAt: iso(total.oldest_due_at),
    byDay: rows.filter((r) => r.kind === "day").map((r) => ({ date: r.day!, leads: Number(r.n), firstAt: iso(r.next_at)! })),
    laterThanHorizon: Number(total.later),
  };
}
