import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";

/**
 * HOW LONG BEFORE A POSITIVE REPLY, ON EVERY CHANNEL (REPLY-LATENCY-ALL-CHANNELS-1019): per GROUP of campaign ids, the
 * time from a person's FIRST message we sent under those campaigns to that person's FIRST POSITIVE reply after it.
 * features-service's next-steps tells a client "expect a positive reply about N days after the first message", on the
 * campaign's own pipe campaigns or on every org's campaigns of the same pipes (a group is just a list of ids, so the
 * read is fleet-wide: internal auth, no org filter).
 *
 * A person = one lead at one (org, brand) of the send. Since inception, never a window.
 *
 * FIRST MESSAGE SENT under the group (earliest of, any channel, each recorded against the campaign that sent it):
 *   - an email of ours on the timeline (`lead_timeline_facts` `initial_email` / `followup`, live, dated): the outreach
 *     fact copy, whatever the transport (the provider's sequences and our own SMTP sends, AI follow-up writer included);
 *   - a send of a channel that does not write by email (`leads_campaigns.channel_sent_at`: WhatsApp...);
 *   - an answer our follow-up worker sent (`followup_actions` `acted`, under the ACTING campaign).
 *   A message the copy cannot tie to a campaign (crm `message_out` facts carry none) counts for no group.
 *
 * FIRST POSITIVE REPLY after it, same (org, brand, lead): the one positive-reply definition meeting attribution reads
 * (meeting-attribution.ts `readPositiveReplies`): a reply whose own verdict is `classification: positive` on the
 * timeline, or the positive reply the brand's CRM evidences (`conversion_events` `positive_reply`, `source = 'crm'`,
 * attributed). Any campaign, any channel: the question is when THIS person answered positively after we first wrote.
 * Strictly after the first send; a positive reply only before it does not count.
 *
 * A person with no positive reply (yet) is NOT in the sample: no censoring, no default, no zero. `sampleSize` 0 =
 * `averageMs`/`medianMs` null. A failed read throws (the route answers 500), never an empty answer.
 */

export const REPLY_LATENCY_MAX_GROUPS = 100;
export const REPLY_LATENCY_MAX_IDS_PER_GROUP = 500;

export interface ReplyLatencyMetric {
  /** People whose first positive reply came after our first message under the group. */
  sampleSize: number;
  /** Median first message -> first positive reply, in ms; null when `sampleSize` is 0. */
  medianMs: number | null;
  /** Average of the same, in ms; null when `sampleSize` is 0. */
  averageMs: number | null;
}

export interface ReplyLatencyGroup {
  key: string;
  campaignIds: string[];
  timeToFirstPositiveReply: ReplyLatencyMetric;
}

const EMPTY: ReplyLatencyMetric = { sampleSize: 0, medianMs: null, averageMs: null };

type Num = number | string | null;
const num = (v: Num): number | null => (v === null || v === undefined ? null : Math.round(Number(v)));

export async function loadReplyLatencyByGroups(groups: ReadonlyArray<{ key: string; campaignIds: readonly string[] }>): Promise<ReplyLatencyGroup[]> {
  const keys: string[] = [];
  const ids: string[] = [];
  const normalized = groups.map((g) => ({ key: g.key, campaignIds: [...new Set(g.campaignIds)] }));
  for (const g of normalized) for (const id of g.campaignIds) {
    keys.push(g.key);
    ids.push(id);
  }
  if (keys.length === 0) return normalized.map((g) => ({ ...g, timeToFirstPositiveReply: EMPTY }));

  const rows = (await db.execute(sql`
    WITH grp AS MATERIALIZED (
      SELECT * FROM unnest(${sql.param(keys)}::text[], ${sql.param(ids)}::text[]) AS g(gkey, campaign_id)
    ),
    positive AS MATERIALIZED (
      SELECT f.org_id, f.brand_id, f.lead_id, f.occurred_at AS at
      FROM lead_timeline_facts f
      WHERE f.source = 'reply' AND f.detail->>'classification' = 'positive'
        AND f.withdrawn_at IS NULL AND f.occurred_at IS NOT NULL
      UNION ALL
      SELECT ce.org_id, ce.brand_id, ce.matched_lead_id, ce.received_at
      FROM conversion_events ce
      WHERE ce.event = ${CRM_POSITIVE_REPLY_STEP} AND ce.source = 'crm' AND ce.attribution_status = 'attributed'
        AND ce.withdrawn_at IS NULL AND ce.matched_lead_id IS NOT NULL AND ce.received_at IS NOT NULL
    ),
    repliers AS MATERIALIZED (SELECT DISTINCT lead_id FROM positive),
    sends AS (
      SELECT grp.gkey, f.org_id, f.brand_id, f.lead_id, f.occurred_at AS at
      FROM grp JOIN lead_timeline_facts f ON f.campaign_id = grp.campaign_id
      WHERE f.label IN ('initial_email', 'followup') AND f.withdrawn_at IS NULL AND f.occurred_at IS NOT NULL
        AND f.lead_id IN (SELECT lead_id FROM repliers)
      UNION ALL
      SELECT grp.gkey, lc.org_id, b.brand_id, lc.lead_id, lc.channel_sent_at
      FROM grp JOIN leads_campaigns lc ON lc.campaign_id = grp.campaign_id
      CROSS JOIN LATERAL unnest(lc.brand_ids) AS b(brand_id)
      WHERE lc.channel_sent_at IS NOT NULL AND lc.lead_id IN (SELECT lead_id FROM repliers)
      UNION ALL
      SELECT grp.gkey, fa.org_id, b.brand_id, fa.lead_id, fa.occurred_at
      FROM grp JOIN followup_actions fa ON fa.acting_campaign_id = grp.campaign_id AND fa.action = 'acted'
      CROSS JOIN LATERAL unnest(fa.brand_ids) AS b(brand_id)
      WHERE fa.lead_id IN (SELECT lead_id FROM repliers)
    ),
    first_send AS (
      SELECT gkey, org_id, brand_id, lead_id, min(at) AS at FROM sends GROUP BY gkey, org_id, brand_id, lead_id
    ),
    latency AS (
      SELECT s.gkey, extract(epoch FROM (min(p.at) - s.at)) * 1000 AS ms
      FROM first_send s
      JOIN positive p ON p.org_id = s.org_id AND p.brand_id = s.brand_id AND p.lead_id = s.lead_id AND p.at > s.at
      GROUP BY s.gkey, s.org_id, s.brand_id, s.lead_id, s.at
    )
    SELECT gkey, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median_ms,
           avg(ms) AS average_ms
    FROM latency GROUP BY gkey
  `)) as unknown as Array<{ gkey: string; n: number; median_ms: Num; average_ms: Num }>;

  const byKey = new Map(rows.map((r) => [r.gkey, r]));
  return normalized.map((g) => {
    const r = byKey.get(g.key);
    const metric: ReplyLatencyMetric =
      r && Number(r.n) > 0 ? { sampleSize: Number(r.n), medianMs: num(r.median_ms), averageMs: num(r.average_ms) } : EMPTY;
    return { ...g, timeToFirstPositiveReply: metric };
  });
}
