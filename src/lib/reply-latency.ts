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
 *
 * THE SHAPE of the same sample (TTFPR-DISTRIBUTION-1021, staff Research "How long before a first positive reply?"):
 * `percentilesMs` (p10/p25/p50/p75/p90, interpolated like the median: p50 IS `medianMs`) and `distribution`, the
 * people per delay bucket of `REPLY_LATENCY_BUCKETS` (hours for the first day, then days, the tail from 60 days in one
 * last bucket) with the running count, so a reader draws a histogram AND a cumulative curve without recomputing.
 * Every bucket is served (zeros included) and the counts sum to `sampleSize`; an empty sample = every percentile null
 * and `distribution` [] (never a row of zeros).
 */

export const REPLY_LATENCY_MAX_GROUPS = 100;
export const REPLY_LATENCY_MAX_IDS_PER_GROUP = 500;

const H = 3_600_000;
const D = 24 * H;

/** Delay buckets, [fromMs, toMs); the last one is open-ended. Bounds readable in human units. */
export const REPLY_LATENCY_BUCKETS: ReadonlyArray<{ key: string; label: string; fromMs: number; toMs: number | null }> = [
  { key: "lt_1h", label: "Under 1 hour", fromMs: 0, toMs: H },
  { key: "1h_3h", label: "1 to 3 hours", fromMs: H, toMs: 3 * H },
  { key: "3h_6h", label: "3 to 6 hours", fromMs: 3 * H, toMs: 6 * H },
  { key: "6h_12h", label: "6 to 12 hours", fromMs: 6 * H, toMs: 12 * H },
  { key: "12h_1d", label: "12 to 24 hours", fromMs: 12 * H, toMs: D },
  { key: "1d_2d", label: "1 to 2 days", fromMs: D, toMs: 2 * D },
  { key: "2d_3d", label: "2 to 3 days", fromMs: 2 * D, toMs: 3 * D },
  { key: "3d_5d", label: "3 to 5 days", fromMs: 3 * D, toMs: 5 * D },
  { key: "5d_7d", label: "5 to 7 days", fromMs: 5 * D, toMs: 7 * D },
  { key: "7d_10d", label: "7 to 10 days", fromMs: 7 * D, toMs: 10 * D },
  { key: "10d_14d", label: "10 to 14 days", fromMs: 10 * D, toMs: 14 * D },
  { key: "14d_21d", label: "14 to 21 days", fromMs: 14 * D, toMs: 21 * D },
  { key: "21d_30d", label: "21 to 30 days", fromMs: 21 * D, toMs: 30 * D },
  { key: "30d_60d", label: "30 to 60 days", fromMs: 30 * D, toMs: 60 * D },
  { key: "60d_plus", label: "60 days or more", fromMs: 60 * D, toMs: null },
];

/** Thresholds for Postgres `width_bucket` (bucket i+1 starts at thresholds[i]; below the first = bucket 0). */
const BUCKET_THRESHOLDS_SQL = `ARRAY[${REPLY_LATENCY_BUCKETS.slice(1).map((b) => b.fromMs).join(",")}]::float8[]`;

export const REPLY_LATENCY_PERCENTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

export interface ReplyLatencyPercentiles {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface ReplyLatencyBucket {
  key: string;
  label: string;
  fromMs: number;
  /** Exclusive upper bound; null on the last, open-ended bucket. */
  toMs: number | null;
  count: number;
  /** People in this bucket or an earlier one (the cumulative curve). */
  cumulativeCount: number;
}

const NO_PERCENTILES: ReplyLatencyPercentiles = { p10: null, p25: null, p50: null, p75: null, p90: null };

/** Every bucket with its count and running count, from `width_bucket` index -> people. Pure. */
export function buildReplyLatencyDistribution(countsByIndex: ReadonlyMap<number, number>): ReplyLatencyBucket[] {
  let running = 0;
  return REPLY_LATENCY_BUCKETS.map((b, i) => {
    const count = countsByIndex.get(i) ?? 0;
    running += count;
    return { ...b, count, cumulativeCount: running };
  });
}

export interface ReplyLatencyMetric {
  /** People whose first positive reply came after our first message under the group. */
  sampleSize: number;
  /** Median first message -> first positive reply, in ms; null when `sampleSize` is 0. */
  medianMs: number | null;
  /** Average of the same, in ms; null when `sampleSize` is 0. */
  averageMs: number | null;
  /** p10..p90 of the same sample, in ms (p50 = medianMs); every one null when `sampleSize` is 0. */
  percentilesMs: ReplyLatencyPercentiles;
  /** People per delay bucket, summing to `sampleSize`; [] when `sampleSize` is 0. */
  distribution: ReplyLatencyBucket[];
}

export interface ReplyLatencyGroup {
  key: string;
  campaignIds: string[];
  timeToFirstPositiveReply: ReplyLatencyMetric;
}

const EMPTY: ReplyLatencyMetric = { sampleSize: 0, medianMs: null, averageMs: null, percentilesMs: NO_PERCENTILES, distribution: [] };

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
    ,
    hist AS (
      SELECT gkey, width_bucket(ms::float8, ${sql.raw(BUCKET_THRESHOLDS_SQL)}) AS b, count(*)::int AS n
      FROM latency GROUP BY 1, 2
    )
    SELECT l.gkey, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS median_ms,
           avg(ms) AS average_ms,
           to_json(percentile_cont(${sql.raw(`ARRAY[${REPLY_LATENCY_PERCENTILES.join(",")}]::float8[]`)}) WITHIN GROUP (ORDER BY ms::float8)) AS percentiles_ms,
           (SELECT json_agg(json_build_array(h.b, h.n)) FROM hist h WHERE h.gkey = l.gkey) AS hist
    FROM latency l GROUP BY l.gkey
  `)) as unknown as Array<{ gkey: string; n: number; median_ms: Num; average_ms: Num; percentiles_ms: Num[] | string; hist: Array<[number, number]> | string }>;

  const byKey = new Map(rows.map((r) => [r.gkey, r]));
  return normalized.map((g) => {
    const r = byKey.get(g.key);
    if (!r || Number(r.n) === 0) return { ...g, timeToFirstPositiveReply: EMPTY };
    const sampleSize = Number(r.n);
    const pct = (typeof r.percentiles_ms === "string" ? JSON.parse(r.percentiles_ms) : r.percentiles_ms) as Num[];
    const hist = (typeof r.hist === "string" ? JSON.parse(r.hist) : r.hist) as Array<[number, number]>;
    const distribution = buildReplyLatencyDistribution(new Map(hist.map(([b, n]) => [Number(b), Number(n)])));
    if (distribution[distribution.length - 1].cumulativeCount !== sampleSize) {
      throw new Error(`reply-latency: group ${g.key} buckets sum to ${distribution[distribution.length - 1].cumulativeCount}, sample is ${sampleSize}`);
    }
    const [p10, p25, p50, p75, p90] = pct.map(num);
    const metric: ReplyLatencyMetric = {
      sampleSize,
      medianMs: num(r.median_ms),
      averageMs: num(r.average_ms),
      percentilesMs: { p10, p25, p50, p75, p90 },
      distribution,
    };
    return { ...g, timeToFirstPositiveReply: metric };
  });
}
