import { sql } from "drizzle-orm";
import type { RecentlyEmailedScope } from "./recently-emailed-sql.js";
import { db } from "../db/index.js";
import { readBuyingSignal, type BuyingSignal } from "./buying-signal.js";
import type { ReachMethod } from "./people-client.js";
import { reachClauses, type RelationshipScope } from "./reach-sql.js";
import { journalistScopeOf } from "./brand-journalists.js";
import type { PoolEmailPolicy } from "./email-policy.js";
import { contactOf, dueReachClauses, markDueServe, openDueServeOfSourceRow, openDueServeSql, postponeDue } from "./lead-followup-date.js";
import type { ProspectFollowupVerdict } from "./prospect-followup.js";

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
  /** null only for a "Lead follow-up due" find known by phone alone (LEAD-FOLLOWUP-DATE-1016). */
  email: string | null;
  /** The person's phone, stated for a "Lead follow-up due" find only. */
  phone?: string | null;
  audienceId: string | null;
  buyingSignal: BuyingSignal | null;
  personId: string | null;
  goal: string | null;
}

/** human-service's verdict on one found person, at handover (src/lib/audience-fit-client.ts). */
export type AudienceFitVerdict = { fits: true } | { fits: false; reason: string };

/**
 * A contacted pure prospect at handover: owed (hand), stopped (set aside for good), or NOT YET (`release`: the find
 * and its handout are removed, so the source can find the person again once owed; never consumed on a not-yet).
 */
export type StillOwedVerdict = AudienceFitVerdict | { fits: false; reason: string; release: true };

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
  /** null = a contacted pure prospect (no audience). */
  audienceId: string | null;
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
  /** The outreach pipe's email policy (src/lib/email-policy.ts): `as_found` when it states none; a find it refuses stays. */
  acceptedEmails?: PoolEmailPolicy | null;
  /** The pipe's relationship policy (src/lib/relationship-tags.ts, RELATIONSHIP-TAGS-1014): absent = nothing asked. */
  relationships?: RelationshipScope | null;
  /** Tactic "Fresh contacts only" (src/lib/recently-emailed.ts): absent = nothing asked. */
  recentlyEmailed?: RecentlyEmailedScope | null;
  /** Asks the audience's owner whether a found person still fits it (never answered here). */
  askFit: AskAudienceFit;
  /**
   * A find with NO audience is a contacted pure prospect (NEVER-NO-FOLLOWUP-1014, src/lib/prospect-followup.ts): is the
   * person still owed a prospect follow-up NOW? null = the row is not such a find (a bug: it throws).
   */
  askStillOwed?: (sourceRowId: string) => Promise<StillOwedVerdict | null>;
  /**
   * A "Lead follow-up due" find (LEAD-FOLLOWUP-DATE-1016, src/lib/lead-followup-date.ts): is the person still owed a
   * follow-up by the brand NOW? Its finds are handed REPEATEDLY (one round per date that passes) and reach the pipe on
   * ANY of its contact methods (a multichannel follow-up writes on whichever the person holds).
   */
  askDueOwed?: (q: { orgId: string; brandId: string; leadId: string }) => Promise<ProspectFollowupVerdict>;
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
         AND (
           (NOT ${openDueServeSql(sql`s.id`)}
             AND NOT EXISTS (
               SELECT 1 FROM leads_campaigns o WHERE o.lead_id = s.lead_id AND o.campaign_id = ${params.outreachCampaignId}
             )
             ${reachClauses(sql`s.lead_id`, params.reachableBy, params.acceptedEmails, params.relationships, params.recentlyEmailed, journalistScopeOf(params.orgId, params.brandIds))})
           OR (${params.askDueOwed ? sql`TRUE` : sql`FALSE`} AND ${openDueServeSql(sql`s.id`)}
             ${dueReachClauses(sql`s.lead_id`, params.reachableBy, params.acceptedEmails, params.relationships, params.recentlyEmailed, journalistScopeOf(params.orgId, params.brandIds))})
         )
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

    const due = params.askDueOwed ? await openDueServeOfSourceRow(tx, row.id) : null;
    if (due) return handDueFind(tx, params, row, due);

    const [email] = (await tx.execute(sql`
      SELECT cm.value FROM lead_contact_methods cm
       WHERE cm.lead_id = ${row.lead_id} AND cm.channel = 'email'
       ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
       LIMIT 1
    `)) as unknown as Array<{ value: string }>;
    if (!email) throw new Error(`[source-stock] found lead ${row.lead_id} (row ${row.id}) has no registered email`);
    // Every audience find is recorded under the audience that found it (src/lib/buffer.ts); the one find with none is a
    // contacted pure prospect, re-asked whether still owed. Anything else: nobody can say it fits.
    const owed = row.audience_id ? null : ((await params.askStillOwed?.(row.id)) ?? null);
    if (!row.audience_id && !owed) {
      throw new Error(`[source-stock] found row ${row.id} (source campaign ${row.campaign_id}) carries no audience`);
    }

    const verdict: StillOwedVerdict =
      owed ?? (await params.askFit({ sourceCampaignId: row.campaign_id, audienceId: row.audience_id as string, email: email.value, personId: row.person_id }));
    if (!verdict.fits && "release" in verdict) {
      await tx.execute(sql`DELETE FROM prospect_followup_handouts WHERE lead_campaign_id = ${row.id}::uuid`);
      await tx.execute(sql`DELETE FROM leads_campaigns WHERE id = ${row.id}`);
      return {
        kind: "set_aside",
        row: { sourceRowId: row.id, sourceCampaignId: row.campaign_id, leadId: row.lead_id, email: email.value, audienceId: null, reason: verdict.reason },
      };
    }
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Hand a "Lead follow-up due" find to the follow-up pipe, inside the claim's transaction. Still owed = the outreach row
 * is filed (or RE-SERVED for this round: a person followed up before holds a row there already) and the run now holding
 * it recorded; not owed now = the find is set aside and the person's date moved to when to ask again.
 */
async function handDueFind(
  tx: Tx,
  params: Parameters<typeof claimStockedLead>[0],
  row: { id: string; campaign_id: string; lead_id: string; audience_id: string | null; buying_signal: unknown; person_id: string | null; goal: string | null },
  due: { id: string; orgId: string; brandId: string; leadId: string },
): Promise<ClaimStep> {
  const contact = await contactOf(tx, row.lead_id);
  if (!contact.email && !contact.phone) throw new Error(`[source-stock] due find ${row.id} (lead ${row.lead_id}) carries neither an email nor a phone`);
  const verdict = await params.askDueOwed!({ orgId: due.orgId, brandId: due.brandId, leadId: due.leadId });
  if (!verdict.owed) {
    const reason = `${verdict.kind === "not_yet" ? "not yet owed" : "no longer owed"} a follow-up: ${verdict.reasons.join(", ")}`;
    await tx.execute(sql`
      UPDATE leads_campaigns SET source_set_aside_at = now(), source_set_aside_reason = ${reason}, updated_at = now() WHERE id = ${row.id}
    `);
    await markDueServe(tx, due.id, { setAsideReason: reason });
    await postponeDue(tx, due, verdict);
    return {
      kind: "set_aside",
      row: { sourceRowId: row.id, sourceCampaignId: row.campaign_id, leadId: row.lead_id, email: contact.email ?? contact.phone!, audienceId: null, reason },
    };
  }
  await tx.execute(sql`
    UPDATE leads_campaigns SET source_handed_at = now(), source_handed_to_campaign_id = ${params.outreachCampaignId}, updated_at = now()
    WHERE id = ${row.id}
  `);
  const goal = params.goal ?? row.goal;
  const brandIds = sql.join(params.brandIds.map((b) => sql`${b}`), sql`, `);
  const [filed] = (await tx.execute(sql`
    INSERT INTO leads_campaigns (
      lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at,
      parent_run_id, run_id, push_run_id, user_id, workflow_slug, feature_slug, goal, active_goal_id, brand_profile_id
    ) VALUES (
      ${row.lead_id}, ${params.outreachCampaignId}, ${params.orgId}, ARRAY[${brandIds}]::text[], 'served', 'served',
      ${`Lead follow-up due, from the stock of source campaign ${row.campaign_id} (row ${row.id}), ${contact.email ? `email=${contact.email}` : `phone=${contact.phone}`}, leadId=${row.lead_id}, campaign=${params.outreachCampaignId}`},
      now(), ${params.parentRunId}, ${params.runId}, ${params.runId}, ${params.userId}, ${params.workflowSlug}, ${params.featureSlug},
      ${goal}, ${params.activeGoalId}, ${params.brandProfileId}
    )
    ON CONFLICT (lead_id, campaign_id) DO UPDATE SET
      status = 'served', status_details = EXCLUDED.status_details, served_at = now(),
      parent_run_id = EXCLUDED.parent_run_id, run_id = EXCLUDED.run_id, push_run_id = EXCLUDED.push_run_id,
      user_id = EXCLUDED.user_id, workflow_slug = EXCLUDED.workflow_slug, goal = EXCLUDED.goal,
      active_goal_id = EXCLUDED.active_goal_id, brand_profile_id = EXCLUDED.brand_profile_id, updated_at = now()
    RETURNING id::text AS id, (xmax <> 0) AS reserved
  `)) as unknown as Array<{ id: string; reserved: boolean }>;
  if (filed.reserved) {
    await tx.execute(sql`
      INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
      VALUES (${filed.id}::uuid, ${params.runId}, ${params.workflowSlug}, now(), 'followup_due')
    `);
  }
  await markDueServe(tx, due.id, { handedTo: params.outreachCampaignId, handedRowId: filed.id });
  return {
    kind: "handed",
    lead: {
      sourceRowId: row.id,
      sourceCampaignId: row.campaign_id,
      leadId: row.lead_id,
      email: contact.email,
      phone: contact.phone,
      audienceId: null,
      buyingSignal: null,
      personId: row.person_id,
      goal,
    },
  };
}
