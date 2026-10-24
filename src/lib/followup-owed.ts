/**
 * "Is anyone owed a follow-up on these held campaigns NOW, and if not, when is the earliest moment?"
 * (WA-REACTIVE-LOOP-1016). A READ: it never claims, leases, hands over or writes anything.
 *
 * Why: campaign-service ran every REACTIVE campaign on a cadence just to let its workflow call
 * claim-next, ~19,000 runs in 3 days claiming nobody, and each empty run held the campaign's one-run
 * lock while a real occurrence waited. With this answer it dispatches a responder only when someone
 * is owed (or at the earliest due moment), and keeps its occurrence path for everything else.
 *
 * It agrees with the claim (`loadFollowupCandidates` + `claimFollowup`) on everything this service can
 * read cheaply in SQL, with the SAME predicates (`handedClaimableSql`, `ownedByActingSql`): due date
 * set and reached, no live lease (a leased row becomes owed again when its lease expires, the moment
 * it may be re-claimed), not booked, a person reachable by email or phone, the pre-responder backlog
 * cut from the STORED `followup_responders` start (no campaign-service call; a held campaign no
 * responder has drained yet has no cut, the first claim hands that backlog over). Claim-time-only
 * gates (opt-out lookup at email-gateway, the relationship policy) are NOT evaluated: an owed answer
 * may then claim nobody, and the caller asks again later. Never the reverse: a person the claim would
 * hand out is always read owed.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  FOLLOWUP_BOOKED_OUTCOMES,
  FOLLOWUP_CLAIM_LEASE_MS,
  handedClaimableSql,
  notJournalistSql,
  openOccurrenceSql,
  ownedByActingSql,
} from "./followup-queue.js";

export interface FollowupOwedQuery {
  /** The ACTING campaign (the responder that would claim, the claim's x-campaign-id). */
  campaignId: string;
  /** The held campaigns it claims on (claim-next path id + alsoCampaignIds). Default: [campaignId]. */
  heldCampaignIds: string[];
}

export interface FollowupOwedHeld {
  campaignId: string;
  owedNow: boolean;
  /** Earliest moment strictly after `asOf` at which someone on this held campaign becomes owed; null = nobody scheduled. */
  nextOwedAt: string | null;
}

export interface FollowupOwedAnswer {
  campaignId: string;
  heldCampaignIds: string[];
  owedNow: boolean;
  /** The held campaigns with someone owed now, in the order asked. */
  owedCampaignIds: string[];
  nextOwedAt: string | null;
  held: FollowupOwedHeld[];
}

interface RawOwedRow {
  campaign_id: string;
  owed_now: boolean;
  next_owed_at: Date | string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export async function readFollowupOwed(params: {
  orgId: string;
  query: FollowupOwedQuery;
  nowMs: number;
}): Promise<FollowupOwedAnswer> {
  const { orgId, query, nowMs } = params;
  const held = [...new Set(query.heldCampaignIds.length > 0 ? query.heldCampaignIds : [query.campaignId])];
  const acting = query.campaignId;
  const now = new Date(nowMs).toISOString();
  const leaseCutoff = new Date(nowMs - FOLLOWUP_CLAIM_LEASE_MS).toISOString();

  // owed_at = when the claim would take the row: its due date, or the end of a live lease if later.
  const rows = (await db.execute(sql`
    WITH owed AS (
      SELECT
        lc.campaign_id,
        GREATEST(
          lc.followup_due_at,
          CASE WHEN lc.followup_claimed_at IS NOT NULL AND lc.followup_claimed_at >= ${leaseCutoff}::timestamptz
               THEN lc.followup_claimed_at + (${FOLLOWUP_CLAIM_LEASE_MS} * interval '1 millisecond')
               ELSE lc.followup_due_at END
        ) AS owed_at
      FROM leads_campaigns lc
      LEFT JOIN followup_responders fr ON fr.held_campaign_id = lc.campaign_id
      WHERE lc.org_id = ${orgId}
        AND lc.campaign_id = ANY(${sql.param(held)}::text[])
        AND lc.followup_due_at IS NOT NULL
        AND ${handedClaimableSql(acting)}
        AND ${ownedByActingSql(acting)}
        AND ${notJournalistSql()}
        AND NOT (
          fr.first_responder_started_at IS NOT NULL
          AND COALESCE(lc.followup_count, 0) = 0
          AND lc.followup_due_at < fr.first_responder_started_at
        )
        AND cardinality(lc.brand_ids) > 0
        AND EXISTS (
          SELECT 1 FROM lead_contact_methods cm
          WHERE cm.lead_id = lc.lead_id AND cm.channel IN ('email', 'phone')
        )
        -- A row a trigger occurrence named (open grant) is owed whatever the booked stop says: a claim
        -- stating a policy takes it (OCCURRENCE-POLICY-ADMITS-1019, a client check-in CLIENT-CHECKIN-LEAD-1024),
        -- and owed may claim nobody, never the reverse.
        AND (${openOccurrenceSql()} OR NOT EXISTS (
          SELECT 1
          FROM conversion_events ce
          WHERE ce.withdrawn_at IS NULL
            AND ce.event = ANY(${sql.param(FOLLOWUP_BOOKED_OUTCOMES as unknown as string[])}::text[])
            AND (ce.lead_campaign_id = lc.id OR ce.matched_lead_id = lc.lead_id)
        ))
    )
    SELECT
      campaign_id,
      bool_or(owed_at <= ${now}::timestamptz) AS owed_now,
      min(owed_at) FILTER (WHERE owed_at > ${now}::timestamptz) AS next_owed_at
    FROM owed
    GROUP BY campaign_id
  `)) as unknown as RawOwedRow[];

  const byCampaign = new Map(rows.map((r) => [r.campaign_id, r]));
  const perHeld: FollowupOwedHeld[] = held.map((id) => {
    const row = byCampaign.get(id);
    return { campaignId: id, owedNow: Boolean(row?.owed_now), nextOwedAt: row ? toIso(row.next_owed_at) : null };
  });
  const nexts = perHeld.map((h) => h.nextOwedAt).filter((v): v is string => v !== null).sort();
  const owedCampaignIds = perHeld.filter((h) => h.owedNow).map((h) => h.campaignId);
  return {
    campaignId: acting,
    heldCampaignIds: held,
    owedNow: owedCampaignIds.length > 0,
    owedCampaignIds,
    nextOwedAt: nexts[0] ?? null,
    held: perHeld,
  };
}
