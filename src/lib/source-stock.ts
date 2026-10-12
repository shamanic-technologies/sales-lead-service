import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { readBuyingSignal, type BuyingSignal } from "./buying-signal.js";

/**
 * THE STOCK A SOURCE FOUND ON ITS OWN, HANDED TO THE PIPE AFTER IT (LEADS-ONLY-FUNNEL-CAMPAIGN, 2026-10-12).
 *
 * A source unit's own run stores each lead it finds as a `leads_campaigns` row under the SOURCE campaign, marked
 * `status_reason = 'source_found'` (src/lib/buffer.ts). An outreach campaign fed by such sources (src/lib/source-mode.ts)
 * takes the OLDEST found lead nobody worked yet, in ONE transaction:
 *   1. claim the source row (`source_handed_at`, `source_handed_to_campaign_id`; `FOR UPDATE SKIP LOCKED`, so two
 *      outreach runs can never take the same person);
 *   2. file the person under the outreach campaign (`leads_campaigns` row `served`, same audience, buying signal and
 *      person as the find), which is what the sender works and what every delivery read keys on.
 * One person contacted once: a lead the outreach campaign already holds is skipped; a handed row is never handed again.
 * The source row keeps `served` (its fact: found) and stays the source's on the dashboard.
 */

export const SOURCE_FOUND_STATUS_REASON = "source_found" as const;

export interface StockedLead {
  sourceRowId: string;
  sourceCampaignId: string;
  leadId: string;
  email: string;
  audienceId: string | null;
  buyingSignal: BuyingSignal | null;
  personId: string | null;
  goal: string | null;
}

export async function claimStockedLead(params: {
  orgId: string;
  /** The running sources that find on their own, feeding this outreach campaign. */
  sourceCampaignIds: string[];
  outreachCampaignId: string;
  brandIds: string[];
  /** The outreach channel the lead is served for (the outreach row's feature_slug). */
  featureSlug: string;
  runId: string | null;
  parentRunId: string | null;
  userId: string | null;
  workflowSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
}): Promise<StockedLead | null> {
  if (params.sourceCampaignIds.length === 0) return null;
  const sourceIds = sql.join(params.sourceCampaignIds.map((id) => sql`${id}`), sql`, `);
  return db.transaction(async (tx) => {
    const claimed = (await tx.execute(sql`
      UPDATE leads_campaigns lc
         SET source_handed_at = now(), source_handed_to_campaign_id = ${params.outreachCampaignId}, updated_at = now()
       WHERE lc.id = (
         SELECT s.id FROM leads_campaigns s
          WHERE s.org_id = ${params.orgId}
            AND s.campaign_id IN (${sourceIds})
            AND s.status_reason = ${SOURCE_FOUND_STATUS_REASON}
            AND s.status = 'served'
            AND s.source_handed_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM leads_campaigns o WHERE o.lead_id = s.lead_id AND o.campaign_id = ${params.outreachCampaignId}
            )
            AND EXISTS (SELECT 1 FROM lead_contact_methods cm WHERE cm.lead_id = s.lead_id AND cm.channel = 'email')
          ORDER BY COALESCE(s.served_at, s.created_at) ASC, s.id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING lc.id, lc.campaign_id, lc.lead_id, lc.audience_id, lc.buying_signal, lc.person_id, lc.goal
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
    const goal = params.goal ?? row.goal;
    const brandIds = sql.join(params.brandIds.map((b) => sql`${b}`), sql`, `);
    await tx.execute(sql`
      INSERT INTO leads_campaigns (
        lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at,
        parent_run_id, run_id, push_run_id, user_id, workflow_slug, feature_slug, goal, active_goal_id,
        brand_profile_id, audience_id, buying_signal, person_id
      ) VALUES (
        ${row.lead_id}, ${params.outreachCampaignId}, ${params.orgId}, ARRAY[${brandIds}]::text[], 'served', 'served',
        ${`Served from the stock of source campaign ${row.campaign_id} (row ${row.id}), email=${email.value}, leadId=${row.lead_id}, campaign=${params.outreachCampaignId}`},
        now(), ${params.parentRunId}, ${params.runId}, ${params.runId}, ${params.userId}, ${params.workflowSlug}, ${params.featureSlug},
        ${goal}, ${params.activeGoalId}, ${params.brandProfileId}, ${row.audience_id},
        ${row.buying_signal === null || row.buying_signal === undefined ? null : JSON.stringify(row.buying_signal)}::jsonb, ${row.person_id}
      )
      ON CONFLICT (lead_id, campaign_id) DO NOTHING
    `);
    return {
      sourceRowId: row.id,
      sourceCampaignId: row.campaign_id,
      leadId: row.lead_id,
      email: email.value,
      audienceId: row.audience_id,
      buyingSignal: readBuyingSignal(row.buying_signal),
      personId: row.person_id,
      goal,
    };
  });
}
