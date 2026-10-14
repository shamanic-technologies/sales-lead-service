import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { readBuyingSignal, type BuyingSignal } from "./buying-signal.js";
import type { ReachMethod } from "./people-client.js";
import { reachClauses, type RelationshipScope } from "./reach-sql.js";
import type { EmailPolicy } from "./email-policy.js";

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
 *
 * STILL FITS (STILL-FITS-1012, 2026-10-12): a find can sit in the stock for hours, and a person can stop fitting the
 * audience meanwhile (the "signed up, never answered" CRM pool: their WhatsApp thread merged in later, 32-54 messages
 * with the owner, and they were still messaged). Before handing a row, the audience's OWNER (human-service) is asked,
 * inside the claim's transaction, whether the person still fits it NOW. Its verdict is never re-graded here, for every
 * audience kind alike. No longer fits = the row is SET ASIDE (`source_set_aside_at` + the owner's reason, verbatim),
 * never handed again, and the next row is tried. The owner unreachable or unreadable = the serve fails (the claim rolls
 * back, nothing handed, nothing set aside): never "fits" by default.
 *
 * NOT THIS SOURCE'S (LEAK-1012 part 2): the same question first asks whether the find belongs to the source holding it
 * at all (its funnel's targeted audiences, its origin, its offer: src/lib/source-stock-belongs.ts). A find made before
 * those rules held is set aside the same way, with that reason.
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

/** human-service's verdict on one found person, at handover (src/lib/audience-fit-client.ts). */
export type AudienceFitVerdict = { fits: true } | { fits: false; reason: string };

export type AskAudienceFit = (question: {
  /** The source unit holding the find: a find outside its funnel's audiences, origin or offer is not its own. */
  sourceCampaignId: string;
  audienceId: string;
  email: string;
  personId: string | null;
}) => Promise<AudienceFitVerdict>;

export interface SetAsideLead {
  sourceRowId: string;
  sourceCampaignId: string;
  leadId: string;
  email: string;
  audienceId: string;
  reason: string;
}

export interface StockClaim {
  /** The lead handed to the outreach campaign; null = nothing in the stock still fits. */
  lead: StockedLead | null;
  /** Rows this claim found no longer fitting their audience, set aside on the way. */
  setAside: SetAsideLead[];
}

type ClaimStep = { kind: "empty" } | { kind: "set_aside"; row: SetAsideLead } | { kind: "handed"; lead: StockedLead };

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
  /** The outreach pipe's contact methods (src/lib/channel-reach.ts): a found lead missing one stays in the stock. */
  reachableBy?: readonly ReachMethod[] | null;
  /** The outreach pipe's email policy (src/lib/email-policy.ts): a find whose address it refuses stays in the stock. */
  acceptedEmails?: EmailPolicy | null;
  /** The pipe's relationship policy (src/lib/relationship-tags.ts, RELATIONSHIP-TAGS-1014): absent = nothing asked. */
  relationships?: RelationshipScope | null;
  /** Asks the audience's owner whether a found person still fits it (never answered here). */
  askFit: AskAudienceFit;
}): Promise<StockClaim> {
  const setAside: SetAsideLead[] = [];
  if (params.sourceCampaignIds.length === 0) return { lead: null, setAside };
  // Each set-aside row leaves the stock for good, so this ends: handed, or the stock holds nobody who still fits.
  for (;;) {
    const step = await claimOne(params);
    if (step.kind === "empty") return { lead: null, setAside };
    if (step.kind === "handed") return { lead: step.lead, setAside };
    setAside.push(step.row);
    console.warn(
      `[lead-service] source stock set aside: no longer fits audience=${step.row.audienceId} sourceCampaign=${step.row.sourceCampaignId} row=${step.row.sourceRowId} email=${step.row.email} reason="${step.row.reason}"`,
    );
  }
}

async function claimOne(params: Parameters<typeof claimStockedLead>[0]): Promise<ClaimStep> {
  const sourceIds = sql.join(params.sourceCampaignIds.map((id) => sql`${id}`), sql`, `);
  return db.transaction(async (tx): Promise<ClaimStep> => {
    const candidates = (await tx.execute(sql`
      SELECT s.id, s.campaign_id, s.lead_id, s.audience_id, s.buying_signal, s.person_id, s.goal
        FROM leads_campaigns s
       WHERE s.org_id = ${params.orgId}
         AND s.campaign_id IN (${sourceIds})
         AND s.status_reason = ${SOURCE_FOUND_STATUS_REASON}
         AND s.status = 'served'
         AND s.source_handed_at IS NULL
         AND s.source_set_aside_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM leads_campaigns o WHERE o.lead_id = s.lead_id AND o.campaign_id = ${params.outreachCampaignId}
         )
         ${reachClauses(sql`s.lead_id`, params.reachableBy, params.acceptedEmails, params.relationships)}
       ORDER BY COALESCE(s.served_at, s.created_at) ASC, s.id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    `)) as unknown as Array<{
      id: string;
      campaign_id: string;
      lead_id: string;
      audience_id: string | null;
      buying_signal: unknown;
      person_id: string | null;
      goal: string | null;
    }>;
    const row = candidates[0];
    if (!row) return { kind: "empty" };

    const [email] = (await tx.execute(sql`
      SELECT cm.value FROM lead_contact_methods cm
       WHERE cm.lead_id = ${row.lead_id} AND cm.channel = 'email'
       ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
       LIMIT 1
    `)) as unknown as Array<{ value: string }>;
    if (!email) throw new Error(`[source-stock] found lead ${row.lead_id} (row ${row.id}) has no registered email`);
    if (!row.audience_id) {
      // Every find is recorded under the audience that found it (src/lib/buffer.ts): without one, nobody can say it fits.
      throw new Error(`[source-stock] found row ${row.id} (source campaign ${row.campaign_id}) carries no audience`);
    }

    const verdict = await params.askFit({ sourceCampaignId: row.campaign_id, audienceId: row.audience_id, email: email.value, personId: row.person_id });
    if (!verdict.fits) {
      await tx.execute(sql`
        UPDATE leads_campaigns
           SET source_set_aside_at = now(), source_set_aside_reason = ${verdict.reason}, updated_at = now()
         WHERE id = ${row.id}
      `);
      return {
        kind: "set_aside",
        row: {
          sourceRowId: row.id,
          sourceCampaignId: row.campaign_id,
          leadId: row.lead_id,
          email: email.value,
          audienceId: row.audience_id,
          reason: verdict.reason,
        },
      };
    }

    await tx.execute(sql`
      UPDATE leads_campaigns
         SET source_handed_at = now(), source_handed_to_campaign_id = ${params.outreachCampaignId}, updated_at = now()
       WHERE id = ${row.id}
    `);
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
      kind: "handed",
      lead: {
        sourceRowId: row.id,
        sourceCampaignId: row.campaign_id,
        leadId: row.lead_id,
        email: email.value,
        audienceId: row.audience_id,
        buyingSignal: readBuyingSignal(row.buying_signal),
        personId: row.person_id,
        goal,
      },
    };
  });
}
