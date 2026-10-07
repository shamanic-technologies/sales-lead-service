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
import { FOLLOWUP_BOOKED_OUTCOMES, FOLLOWUP_CLAIM_LEASE_MS } from "./followup-queue.js";

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

/** The `source` of a ledger row recorded through the by-email door (an act outside the queue). */
export const ACTED_BY_EMAIL_SOURCE = "acted_by_email";

/**
 * Record that an acting campaign acted on one person WITHOUT going through the queue.
 *
 * AI Instant Call (leg conversation_to_booking_call) is the case: instantly-service rings the
 * brand's rep the moment a reply is qualified as a sales interest, under the AI Instant Call
 * campaign, and never claims anybody here. So the ledger never heard of that campaign and its
 * conversation counts read zero while it was placing calls. This writes the same `acted` row a
 * queue worker's statement writes, on the lifecycle row of the campaign that HOLDS the person.
 *
 * Idempotent per act: `source_ref` is `run:<the act's run id>` (one ring = one root run), so a
 * retried request writes nothing new. The row is located with `org_id` in the predicate: a foreign
 * row records nothing.
 */
export async function recordActedByEmail(params: {
  orgId: string;
  leadCampaignId: string;
  actingCampaignId: string;
  runId: string;
  nowIso: string;
}): Promise<"recorded" | "already_recorded" | "row_gone"> {
  const sourceRef = `run:${params.runId}`;
  const rows = (await db.execute(sql`
    WITH target AS (
      SELECT id, org_id, brand_ids, lead_id, campaign_id
      FROM leads_campaigns
      WHERE id = ${params.leadCampaignId}::uuid AND org_id = ${params.orgId}
    ),
    ins AS (
      INSERT INTO followup_actions
        (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id,
         acting_campaign_id, run_id, action, occurred_at, source, source_ref)
      SELECT org_id, brand_ids, id, lead_id, campaign_id,
             ${params.actingCampaignId}, ${params.runId}, 'acted', ${params.nowIso}::timestamptz,
             ${ACTED_BY_EMAIL_SOURCE}, ${sourceRef}
      FROM target
      ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
      RETURNING id
    )
    SELECT (SELECT count(*) FROM target) AS targets, (SELECT count(*) FROM ins) AS inserted
  `)) as unknown as Array<{ targets: number | string; inserted: number | string }>;
  if (Number(rows[0].inserted) > 0) return "recorded";
  if (Number(rows[0].targets) === 0) return "row_gone";
  return "already_recorded";
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

/**
 * What one acting campaign did with the people handed to it, in PEOPLE, since inception.
 *
 * A partition per person — `handed = ongoing + meetingsBooked + dropped` — decided in this order:
 *  - meetingsBooked: a live booked outcome (meeting_booked / meeting_attended / sale, the same set
 *    that stops the queue) is on record for that person at the brand, on a row the campaign was
 *    handed or by matched lead.
 *  - ongoing: not booked, and a row the campaign was handed still owes an action (a due date is
 *    set) or is being answered right now (a live claim lease).
 *  - dropped: neither — the schedule was stopped (the responder could not answer, a person took it
 *    over, they declined, no reply owed) or the row no longer exists.
 * Read off the ledger and the queue columns as they stand; nothing is inferred from timing.
 */
export interface ConversationCounts {
  handed: number;
  ongoing: number;
  meetingsBooked: number;
  dropped: number;
}

export async function readConversationCounts(params: {
  orgId: string;
  campaignId: string;
  nowMs: number;
}): Promise<ConversationCounts> {
  const leaseCutoffIso = new Date(params.nowMs - FOLLOWUP_CLAIM_LEASE_MS).toISOString();
  const rows = (await db.execute(sql`
    WITH handed AS (
      SELECT DISTINCT fa.lead_id
      FROM followup_actions fa
      WHERE fa.org_id = ${params.orgId} AND fa.acting_campaign_id = ${params.campaignId}
    ),
    per_person AS (
      SELECT
        h.lead_id,
        EXISTS (
          SELECT 1
          FROM followup_actions fa
          JOIN conversion_events ce
            ON ce.org_id = fa.org_id
           AND ce.brand_id = ANY(fa.brand_ids)
           AND (ce.lead_campaign_id = fa.lead_campaign_id OR ce.matched_lead_id = fa.lead_id)
          WHERE fa.org_id = ${params.orgId}
            AND fa.acting_campaign_id = ${params.campaignId}
            AND fa.lead_id = h.lead_id
            AND ce.withdrawn_at IS NULL
            AND ce.event = ANY(${sql.param(FOLLOWUP_BOOKED_OUTCOMES as unknown as string[])}::text[])
        ) AS booked,
        EXISTS (
          SELECT 1
          FROM followup_actions fa
          JOIN leads_campaigns lc ON lc.id = fa.lead_campaign_id
          WHERE fa.org_id = ${params.orgId}
            AND fa.acting_campaign_id = ${params.campaignId}
            AND fa.lead_id = h.lead_id
            AND (lc.followup_due_at IS NOT NULL OR lc.followup_claimed_at > ${leaseCutoffIso}::timestamptz)
        ) AS owed
      FROM handed h
    )
    SELECT
      count(*) AS handed,
      count(*) FILTER (WHERE booked) AS meetings_booked,
      count(*) FILTER (WHERE NOT booked AND owed) AS ongoing,
      count(*) FILTER (WHERE NOT booked AND NOT owed) AS dropped
    FROM per_person
  `)) as unknown as Array<Record<"handed" | "meetings_booked" | "ongoing" | "dropped", number | string>>;

  const r = rows[0];
  const counts: ConversationCounts = {
    handed: Number(r.handed),
    ongoing: Number(r.ongoing),
    meetingsBooked: Number(r.meetings_booked),
    dropped: Number(r.dropped),
  };
  if (counts.handed !== counts.ongoing + counts.meetingsBooked + counts.dropped) {
    throw new Error(`[followup-actions] conversation counts are not a partition: ${JSON.stringify(counts)}`);
  }
  return counts;
}
