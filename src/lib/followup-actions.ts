/**
 * Which people a campaign's worker actually acted on through the follow-up queue.
 *
 * Campaign-service mints one campaign per (offer, leg, channel). A leg performed by the
 * platform itself (ai-meeting-booking answers a prospect who already replied positively and books
 * the meeting) serves no lead of its own: its runs CLAIM people held by the PREDECESSOR leg's
 * campaign through `claim-next`, answer them, and record `acted` on that predecessor row. So the
 * AI campaign owns zero lifecycle rows, and nothing recorded which of the predecessor's people the
 * AI touched — the claim lease is overwritten on every claim and released on every statement.
 * A consumer pricing the AI leg (cost per meeting, ROI) therefore had nothing to divide by but
 * "every lead of the offer that reached the step", which is not attributable.
 *
 * `followup_actions` (migration 0045) is that record: one append-only row per claim that handed
 * somebody out and per `acted` statement, written in the SAME statement as the claim / the write,
 * carrying the campaign the worker was DISPATCHED for (x-campaign-id) apart from the campaign that
 * HOLDS the row. It is a record of the act itself — nothing here infers attribution from timing.
 *
 * Two facts, deliberately kept apart on the read:
 *  - claimed: the queue handed this person to that campaign's worker. The worker may then have
 *    answered, escalated to a human (the question was one it could not answer), or stood down
 *    because a person had taken the thread over.
 *  - acted: that worker answered them — the reply was sent and the follow-up recorded.
 * Which of the two means "crossed the leg" is the consumer's call; both are served.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";

export type FollowupAction = "claimed" | "acted";

/**
 * The INSERT arm of a data-modifying CTE, reading the lifecycle row(s) the statement just
 * claimed / updated out of `from` (which must return `id, org_id, brand_ids, lead_id, campaign_id`).
 *
 * Bound values are primitives only (an ISO string for the instant) — a raw `sql` template hands
 * params straight to postgres.js Bind, which cannot serialize a `Date`.
 */
export function followupActionInsert(
  action: FollowupAction,
  actingCampaignId: string | null,
  runId: string | null,
  nowIso: string,
  from: SQL = sql`claimed`,
): SQL {
  return sql`
    INSERT INTO followup_actions
      (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id,
       acting_campaign_id, run_id, action, occurred_at, source)
    SELECT org_id, brand_ids, id, lead_id, campaign_id,
           ${actingCampaignId}, ${runId}, ${action}, ${nowIso}, 'live'
    FROM ${from}
    RETURNING id
  `;
}

/** One person one acting campaign acted on, with both facts and their dates. */
export interface FollowupActedLead {
  actingCampaignId: string;
  leadId: string;
  /** The lead's canonical email (earliest registered), null when none is registered. */
  email: string | null;
  /** The lifecycle rows (and so the holding campaigns) the actions landed on. */
  leadCampaignIds: string[];
  heldByCampaignIds: string[];
  claimCount: number;
  firstClaimedAt: string | null;
  lastClaimedAt: string | null;
  actedCount: number;
  firstActedAt: string | null;
  lastActedAt: string | null;
}

export interface FollowupActingCampaignSummary {
  campaignId: string;
  /** Distinct people the queue handed to this campaign's worker. */
  leadsClaimed: number;
  /** Distinct people this campaign's worker answered. */
  leadsActed: number;
  claims: number;
  acts: number;
}

interface RawRow {
  acting_campaign_id: string;
  lead_id: string;
  email: string | null;
  lead_campaign_ids: string[];
  held_by_campaign_ids: string[];
  claim_count: number | string;
  first_claimed_at: Date | string | null;
  last_claimed_at: Date | string | null;
  acted_count: number | string;
  first_acted_at: Date | string | null;
  last_acted_at: Date | string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`[followup-actions] unparseable timestamp: ${String(value)}`);
  return new Date(ms).toISOString();
}

/**
 * Every person the named campaigns' workers claimed or answered, for one brand.
 *
 * One row per (acting campaign, person): a person claimed ten times by one campaign is one person
 * who crossed that campaign's leg ten times, and a consumer counting people must not count ten.
 */
export async function readFollowupActions(params: {
  brandId: string;
  campaignIds: string[];
}): Promise<{ leads: FollowupActedLead[]; campaigns: FollowupActingCampaignSummary[] }> {
  const rows = (await db.execute(sql`
    SELECT
      fa.acting_campaign_id,
      fa.lead_id,
      canonical.email,
      array_agg(DISTINCT fa.lead_campaign_id::text) AS lead_campaign_ids,
      array_agg(DISTINCT fa.held_by_campaign_id) AS held_by_campaign_ids,
      count(*) FILTER (WHERE fa.action = 'claimed') AS claim_count,
      min(fa.occurred_at) FILTER (WHERE fa.action = 'claimed') AS first_claimed_at,
      max(fa.occurred_at) FILTER (WHERE fa.action = 'claimed') AS last_claimed_at,
      count(*) FILTER (WHERE fa.action = 'acted') AS acted_count,
      min(fa.occurred_at) FILTER (WHERE fa.action = 'acted') AS first_acted_at,
      max(fa.occurred_at) FILTER (WHERE fa.action = 'acted') AS last_acted_at
    FROM followup_actions fa
    LEFT JOIN LATERAL (
      SELECT lower(cm.value) AS email
      FROM lead_contact_methods cm
      WHERE cm.lead_id = fa.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) canonical ON true
    WHERE fa.brand_ids @> ${sql.param([params.brandId])}::text[]
      AND fa.acting_campaign_id = ANY(${sql.param(params.campaignIds)}::text[])
    GROUP BY fa.acting_campaign_id, fa.lead_id, canonical.email
    ORDER BY fa.acting_campaign_id, min(fa.occurred_at), fa.lead_id
  `)) as unknown as RawRow[];

  const leads: FollowupActedLead[] = rows.map((r) => ({
    actingCampaignId: r.acting_campaign_id,
    leadId: r.lead_id,
    email: r.email,
    leadCampaignIds: r.lead_campaign_ids,
    heldByCampaignIds: r.held_by_campaign_ids,
    claimCount: Number(r.claim_count),
    firstClaimedAt: toIso(r.first_claimed_at),
    lastClaimedAt: toIso(r.last_claimed_at),
    actedCount: Number(r.acted_count),
    firstActedAt: toIso(r.first_acted_at),
    lastActedAt: toIso(r.last_acted_at),
  }));

  // Every campaign asked about is answered, including one that acted on nobody: an absent key would
  // be indistinguishable from a campaign this read never looked at.
  const campaigns: FollowupActingCampaignSummary[] = params.campaignIds.map((campaignId) => {
    const mine = leads.filter((l) => l.actingCampaignId === campaignId);
    return {
      campaignId,
      leadsClaimed: mine.filter((l) => l.claimCount > 0).length,
      leadsActed: mine.filter((l) => l.actedCount > 0).length,
      claims: mine.reduce((n, l) => n + l.claimCount, 0),
      acts: mine.reduce((n, l) => n + l.actedCount, 0),
    };
  });

  return { leads, campaigns };
}
