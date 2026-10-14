import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { readBuyingSignal, type BuyingSignal } from "./buying-signal.js";
import type { ReachMethod } from "./people-client.js";
import { reachClauses, type RelationshipScope } from "./reach-sql.js";
import type { EmailPolicy } from "./email-policy.js";
import { fetchAudienceOfferId, fetchAudienceOriginSlug, loadOriginsByChannelSlug } from "./sourcing-origin.js";

/**
 * PEOPLE A CHANNEL COULD NOT REACH, HANDED TO A PIPE THAT CAN (owner 2026-10-12).
 *
 * A sender refusing a person for a reason about its CHANNEL (WhatsApp: no phone known, not on WhatsApp) says nothing
 * about the person. They were served (paid for, suppressed brand-wide upstream), so no fresh serve will ever offer
 * them again: without this, the refusal burns them for every pipe of the brand.
 *
 *   release — `POST /orgs/campaigns/{campaignId}/leads/channel-refusals {email, code}`: the refusing campaign's row
 *             records the refusal (`send_refused_*`, no end: it leaves THAT campaign's retry pool for good) and is
 *             released (`channel_released_*`).
 *   take    — before buying anyone new, a campaign of the same org and brand whose channel CAN reach the person (its
 *             contact methods), whose campaign does not hold them yet, takes the oldest released person, ONCE
 *             (`released_taken_*`, conditional claim), and files them under itself as `served`.
 *
 * Same rules as a fresh serve: the person's audience must belong to the campaign's offer (or to none) and its origin
 * must feed the taking channel (features-service `originsByChannel`; a channel naming no origins takes any).
 * No vendor call, nothing billed: the person was paid for once.
 */

export const RELEASED_POOL_STATUS_REASON = "released_from_channel" as const;

/** How many released rows one pull looks at (each costs two human-service reads). */
const RELEASED_CANDIDATE_BATCH = 10;

export interface ReleaseResult {
  leadId: string;
  rowId: string;
  alreadyReleased: boolean;
}

/** Record a channel refusal on the refusing campaign's row(s) for this email, and release the person. */
export async function releaseForChannel(params: {
  orgId: string;
  campaignId: string;
  email: string;
  code: string;
}): Promise<ReleaseResult[]> {
  const rows = (await db.execute(sql`
    WITH target AS (
      SELECT lc.id, lc.channel_released_at IS NOT NULL AS already
        FROM leads_campaigns lc
       WHERE lc.org_id = ${params.orgId}
         AND lc.campaign_id = ${params.campaignId}
         AND lc.lead_id IN (
           SELECT cm.lead_id FROM lead_contact_methods cm
            WHERE cm.channel = 'email' AND lower(cm.value) = lower(${params.email})
         )
    )
    UPDATE leads_campaigns lc
       SET send_refused_at = COALESCE(lc.send_refused_at, now()),
           send_refusal_code = ${params.code},
           send_refused_until = NULL,
           channel_released_at = COALESCE(lc.channel_released_at, now()),
           channel_released_code = COALESCE(lc.channel_released_code, ${params.code}),
           updated_at = now()
      FROM target
     WHERE lc.id = target.id
    RETURNING lc.id, lc.lead_id, target.already
  `)) as unknown as Array<{ id: string; lead_id: string; already: boolean }>;
  return rows.map((r) => ({ rowId: r.id, leadId: r.lead_id, alreadyReleased: r.already }));
}

export interface ReleasedLead {
  releasedRowId: string;
  releasedFromCampaignId: string;
  leadId: string;
  email: string;
  audienceId: string | null;
  buyingSignal: BuyingSignal | null;
  personId: string | null;
  goal: string | null;
}

interface RawReleasedRow {
  id: string;
  campaign_id: string;
  lead_id: string;
  audience_id: string | null;
}

/** True when the released person's audience may be served by this campaign (offer + origin). */
async function audienceFitsCampaign(args: {
  audienceId: string | null;
  orgId: string;
  offerId: string | null;
  channelSlug: string;
}): Promise<boolean> {
  // An audience-less row cannot prove its source: never handed on.
  if (!args.audienceId) return false;
  if (args.offerId) {
    const audienceOffer = await fetchAudienceOfferId(args.audienceId, args.orgId);
    if (audienceOffer !== null && audienceOffer !== args.offerId) return false;
  }
  const fedBy = await loadOriginsByChannelSlug(args.channelSlug);
  if (!fedBy) return true;
  // The audience's OWN list origin: asked under a CRM channel, human-service names EVERY audience CRM (LEAK-1012).
  const origin = await fetchAudienceOriginSlug(args.audienceId, args.orgId, null);
  return origin !== null && fedBy.has(origin);
}

/**
 * Take the oldest person another campaign of the brand released and this campaign can reach, filed under this
 * campaign as `served`. Null when nobody fits.
 */
export async function claimReleasedLead(params: {
  orgId: string;
  campaignId: string;
  brandIds: string[];
  /** The outreach channel the lead is served for (feature_slug of the new row; decides the origins it takes). */
  featureSlug: string;
  reachableBy: ReachMethod[];
  /** The taking campaign's email policy (src/lib/email-policy.ts): absent = valid only. */
  acceptedEmails?: EmailPolicy | null;
  /** The pipe's relationship policy (src/lib/relationship-tags.ts, RELATIONSHIP-TAGS-1014): absent = nothing asked. */
  relationships?: RelationshipScope | null;
  offerId: string | null;
  runId: string | null;
  parentRunId: string | null;
  userId: string | null;
  workflowSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
}): Promise<ReleasedLead | null> {
  if (params.brandIds.length === 0) return null;
  const brands = sql.join(params.brandIds.map((b) => sql`${b}`), sql`, `);
  const reach = reachClauses(sql`s.lead_id`, params.reachableBy, params.acceptedEmails, params.relationships);
  const candidates = (await db.execute(sql`
    SELECT s.id, s.campaign_id, s.lead_id, s.audience_id
      FROM leads_campaigns s
     WHERE s.org_id = ${params.orgId}
       AND s.channel_released_at IS NOT NULL
       AND s.released_taken_at IS NULL
       AND s.campaign_id <> ${params.campaignId}
       AND s.brand_ids && ARRAY[${brands}]::text[]
       AND NOT EXISTS (
         SELECT 1 FROM leads_campaigns o WHERE o.lead_id = s.lead_id AND o.campaign_id = ${params.campaignId}
       )
       ${reach}
     ORDER BY s.channel_released_at ASC, s.id ASC
     LIMIT ${RELEASED_CANDIDATE_BATCH}
  `)) as unknown as RawReleasedRow[];

  for (const c of candidates) {
    const fits = await audienceFitsCampaign({
      audienceId: c.audience_id,
      orgId: params.orgId,
      offerId: params.offerId,
      channelSlug: params.featureSlug,
    });
    if (!fits) continue;
    const taken = await db.transaction(async (tx) => {
      const claimed = (await tx.execute(sql`
        UPDATE leads_campaigns
           SET released_taken_at = now(), released_to_campaign_id = ${params.campaignId}, updated_at = now()
         WHERE id = ${c.id} AND released_taken_at IS NULL
        RETURNING id, campaign_id, lead_id, audience_id, buying_signal, person_id, goal
      `)) as unknown as Array<{
        id: string;
        campaign_id: string;
        lead_id: string;
        audience_id: string | null;
        buying_signal: unknown;
        person_id: string | null;
        goal: string | null;
      }>;
      const row = claimed[0];
      if (!row) return null;
      const [email] = (await tx.execute(sql`
        SELECT cm.value FROM lead_contact_methods cm
         WHERE cm.lead_id = ${row.lead_id} AND cm.channel = 'email'
         ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
         LIMIT 1
      `)) as unknown as Array<{ value: string }>;
      if (!email) throw new Error(`[lead-service] released lead ${row.lead_id} carries no email (row ${row.id})`);
      const goal = params.goal ?? row.goal;
      const inserted = (await tx.execute(sql`
        INSERT INTO leads_campaigns (
          lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at,
          parent_run_id, run_id, push_run_id, user_id, workflow_slug, feature_slug, goal, active_goal_id,
          brand_profile_id, audience_id, buying_signal, person_id
        ) VALUES (
          ${row.lead_id}, ${params.campaignId}, ${params.orgId}, ARRAY[${brands}]::text[], 'served', ${RELEASED_POOL_STATUS_REASON},
          ${`Released by campaign ${row.campaign_id} (row ${row.id}, its channel could not reach them), email=${email.value}, leadId=${row.lead_id}, campaign=${params.campaignId}`},
          now(), ${params.parentRunId}, ${params.runId}, ${params.runId}, ${params.userId}, ${params.workflowSlug}, ${params.featureSlug},
          ${goal}, ${params.activeGoalId}, ${params.brandProfileId}, ${row.audience_id},
          ${row.buying_signal === null || row.buying_signal === undefined ? null : JSON.stringify(row.buying_signal)}::jsonb, ${row.person_id}
        )
        ON CONFLICT (lead_id, campaign_id) DO NOTHING
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      // Raced in by another path: give the release back, the next candidate is tried.
      if (inserted.length === 0) throw new ReleasedRaceError();
      return {
        releasedRowId: row.id,
        releasedFromCampaignId: row.campaign_id,
        leadId: row.lead_id,
        email: email.value,
        audienceId: row.audience_id,
        buyingSignal: readBuyingSignal(row.buying_signal),
        personId: row.person_id,
        goal,
      } satisfies ReleasedLead;
    }).catch((err) => {
      if (err instanceof ReleasedRaceError) return null;
      throw err;
    });
    if (taken) return taken;
  }
  return null;
}

class ReleasedRaceError extends Error {}
