/**
 * The standing of MANY leads at once — what a list read needs, resolved the same way the one-lead
 * panel resolves it.
 *
 * Two facts have to be gathered before `resolveLeadStanding` (which is pure) can answer:
 *
 *   - WHICH funnel each row's campaign sells. campaign-service owns `funnelKey` and it is never
 *     inferred, so it is read from there — ONCE per request, org-wide (`fetchOrgCampaignFunnelKeys`
 *     is a single call that returns every campaign of the org), not once per row and not once per
 *     chunk. A brand with 57k rows across a dozen campaigns therefore costs exactly one call.
 *   - WHAT somebody stated about each row's steps. Two indexed reads per chunk, batched over the
 *     chunk's lead ids: the outcome ledger (`conversion_events`) and the disqualification table,
 *     filtered exactly as the panel filters them so the two surfaces cannot disagree.
 *
 * The measured website visit is folded in from the delivery overlay the caller already fetched —
 * a click on the email we sent IS the automatic half of `website_visit`, and the panel folds the
 * same fact in from the same source. No extra email-gateway call is made for it. One deliberate
 * difference: the panel always asks at BRAND scope, while a list read folds in the click AT THE
 * SCOPE IT WAS ASKED FOR, so a campaign-scoped read answers for that campaign. That is the same
 * scoping every other engagement field on the row already carries.
 *
 * NO SILENT FALLBACK. campaign-service unreachable does not make every lead's standing "contacted"
 * — it makes it `unresolved` with the reason on the wire, and the raw delivery facts beside it are
 * untouched. The list read itself still answers: a standing nobody can resolve is a fact about one
 * field, not a reason to fail a 57k-row walk.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  fetchOrgCampaignFunnelKeys,
  FunnelStepsError,
  type CampaignFunnelContext,
} from "./campaign-funnel-client.js";
import { FUNNEL_ENTRY, FUNNEL_STEPS, type FunnelKey } from "./funnel-steps.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { resolveStepStates, type StatedNever, type StatedOutcome } from "./step-funnel-state.js";
import { closedDealFrom, type ClosedDeal } from "./closed-deal.js";
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";
import {
  canonicalizeStepOutcome,
  statementSourceOf,
  LEAD_STEP_OUTCOMES,
  WEBSITE_VISIT,
  type LeadStepOutcomeName,
} from "./step-statements.js";
import {
  resolveLeadStanding,
  type LeadStanding,
  type LeadStandingDelivery,
  type LeadStandingUnresolvedReason,
} from "./lead-standing.js";

/** One row the resolver answers for. Exactly what both list paths already hold per row. */
export interface StandingRow {
  /** `leads_campaigns.id` — the key the answer is returned under. */
  id: string;
  leadId: string;
  campaignId: string;
  brandIds: string[];
  status: string;
  delivery: LeadStandingDelivery;
}

interface OutcomeRow {
  lead_campaign_id: string | null;
  matched_lead_id: string;
  event: string;
  source: string;
  value_cents: number | null;
  cost_cents: number | null;
  caused_by_outreach: boolean | null;
  note: string | null;
  stated_by_user_id: string | null;
  received_at: Date | string | null;
}

interface NeverRow {
  lead_id: string;
  campaign_id: string;
  step: string;
  source: string | null;
  cost_cents: number | null;
  note: string | null;
  stated_by_user_id: string | null;
  updated_at: Date | string | null;
}

/**
 * What one row reads as, derived from the SAME statements in the SAME pass.
 *
 * The standing and the closed deal are two answers off one set of facts, so they are resolved
 * together: reading them apart would mean two queries over the same ledger and two chances for the
 * row and the panel to disagree about whether somebody bought.
 */
export interface ResolvedLeadFacts {
  standing: LeadStanding;
  /** The deal on this lead's funnel, or null when nobody has stated one. See closed-deal.ts. */
  closedDeal: ClosedDeal | null;
}

export interface LeadStandingResolver {
  resolve(rows: StandingRow[]): Promise<Map<string, ResolvedLeadFacts>>;
}

export interface LeadStandingResolverOptions extends CampaignFunnelContext {
  /**
   * Whether the delivery layer was asked at all. False on an unscoped read, where every row's
   * overlay is the all-false default and "nothing happened" is not something the read knows.
   */
  deliveryQueried: boolean;
}

/**
 * The org's campaign -> funnel map, read once and reused for every chunk. A failure is remembered
 * as a REASON rather than retried per chunk: campaign-service being down is a property of the
 * request, and retrying it 114 times on a 57k-row walk would turn one bad answer into a stampede.
 */
async function loadFunnelKeys(
  ctx: CampaignFunnelContext,
): Promise<{ keys: Map<string, FunnelKey | null> | null; reason: LeadStandingUnresolvedReason | null }> {
  try {
    return { keys: await fetchOrgCampaignFunnelKeys(ctx), reason: null };
  } catch (error) {
    if (!(error instanceof FunnelStepsError)) throw error;
    console.error(
      `[lead-standing] campaign-service could not say which funnels this org's campaigns sell, so ` +
        `every lead's standing is unresolved rather than guessed: ${error.message}`,
    );
    return { keys: null, reason: "campaign_service_unavailable" };
  }
}

export function createLeadStandingResolver(
  options: LeadStandingResolverOptions,
): LeadStandingResolver {
  const { deliveryQueried, ...ctx } = options;
  let funnels: Promise<{
    keys: Map<string, FunnelKey | null> | null;
    reason: LeadStandingUnresolvedReason | null;
  }> | null = null;

  return {
    async resolve(rows: StandingRow[]): Promise<Map<string, ResolvedLeadFacts>> {
      const out = new Map<string, ResolvedLeadFacts>();
      if (rows.length === 0) return out;

      if (!funnels) funnels = loadFunnelKeys(ctx);
      const { keys, reason: funnelFailure } = await funnels;

      const leadIds = Array.from(new Set(rows.map((r) => r.leadId)));
      const campaignIds = Array.from(new Set(rows.map((r) => r.campaignId)));
      const brandIds = Array.from(new Set(rows.flatMap((r) => r.brandIds)));

      // Outcomes credited to these people for these brands. A hand-stated one is keyed to the row
      // it was stated on; a tracker-reported one knows only the brand, so it is matched on the
      // lead — exactly the pairing the one-lead panel reads.
      const outcomeRows =
        brandIds.length === 0
          ? []
          : ((await db.execute(sql`
              SELECT lead_campaign_id, matched_lead_id, event, source, value_cents, cost_cents,
                     caused_by_outreach, note, stated_by_user_id, received_at
              FROM conversion_events
              WHERE brand_id = ANY(${sql.param(brandIds)}::text[])
                AND matched_lead_id = ANY(${sql.param(leadIds)}::uuid[])
                AND attribution_status = 'attributed'
                AND withdrawn_at IS NULL
              -- What the customer's CRM evidences answers a step only when nobody and nothing
              -- else of ours did: a person's statement and the tracker's report come first.
              ORDER BY (source = 'crm') ASC, received_at DESC NULLS LAST
            `)) as unknown as OutcomeRow[]);

      // Retracted and withdrawn statements are excluded: kept for the record, not read as live.
      const neverRows = (await db.execute(sql`
        SELECT lead_id, campaign_id, step, source, cost_cents, note, stated_by_user_id,
               -- A CRM "never" is dated by the CRM or not at all — never by when we synced it.
               CASE WHEN source = 'crm' THEN occurred_at ELSE updated_at END AS updated_at
        FROM lead_step_disqualifications
        WHERE lead_id = ANY(${sql.param(leadIds)}::uuid[])
          AND campaign_id = ANY(${sql.param(campaignIds)}::text[])
          AND retracted_at IS NULL
          AND withdrawn_at IS NULL
      `)) as unknown as NeverRow[];

      const outcomesByLead = new Map<string, OutcomeRow[]>();
      for (const o of outcomeRows) {
        const list = outcomesByLead.get(o.matched_lead_id);
        if (list) list.push(o);
        else outcomesByLead.set(o.matched_lead_id, [o]);
      }
      const neversByRow = new Map<string, NeverRow[]>();
      for (const n of neverRows) {
        const key = `${n.lead_id}:${n.campaign_id}`;
        const list = neversByRow.get(key);
        if (list) list.push(n);
        else neversByRow.set(key, [n]);
      }

      for (const row of rows) {
        const funnelKey = keys ? (keys.get(row.campaignId) ?? undefined) : undefined;
        const resolvedKey = funnelKey ?? null;
        const funnel = resolvedKey
          ? {
              key: resolvedKey,
              steps: FUNNEL_STEPS[resolvedKey],
              entry: FUNNEL_ENTRY[resolvedKey],
            }
          : null;
        const unresolvedReason: LeadStandingUnresolvedReason | null = funnel
          ? null
          : (funnelFailure ??
            (keys && !keys.has(row.campaignId) ? "campaign_unknown" : "funnel_unstated"));

        // Rows arrive newest first, so the first one seen for a step is the one that answers. A
        // hand-stated outcome is only this row's when it names this row; a tracker one names none.
        const outcomes = new Map<LeadStepOutcomeName, StatedOutcome>();
        for (const o of outcomesByLead.get(row.leadId) ?? []) {
          if (o.lead_campaign_id !== null && o.lead_campaign_id !== row.id) continue;
          const step = canonicalizeStepOutcome(o.event);
          if (!step || outcomes.has(step)) continue;
          outcomes.set(step, {
            source: statementSourceOf(o.source),
            valueCents: o.value_cents,
            costCents: o.cost_cents,
            causedByOutreach: o.caused_by_outreach,
            note: o.note,
            statedByUserId: o.stated_by_user_id,
            at: toIsoTimestamp(o.received_at),
          });
        }

        // The automatic half of the website visit: a click on the email we sent, which the
        // delivery layer owns and this read already holds. Read where it lives, exactly as the
        // panel reads it — a hand statement already on the row wins, being the more specific fact.
        if (!outcomes.has(WEBSITE_VISIT) && deliveryQueried && row.delivery.clicked) {
          outcomes.set(WEBSITE_VISIT, {
            source: "tracker",
            valueCents: null,
            costCents: null,
            causedByOutreach: null,
            note: null,
            statedByUserId: null,
            at: null,
          });
        }

        const nevers = new Map<LeadStepOutcomeName, StatedNever>();
        for (const n of neversByRow.get(`${row.leadId}:${row.campaignId}`) ?? []) {
          const step = canonicalizeStepOutcome(n.step);
          if (!step) continue;
          nevers.set(step, {
            source: n.source === "crm" ? "crm" : "manual",
            costCents: n.cost_cents,
            note: n.note,
            statedByUserId: n.stated_by_user_id,
            at: toIsoTimestamp(n.updated_at),
          });
        }

        // A positive reply the ledger holds (their CRM's form, dated after our first email) is the
        // same fact as a positive reply the delivery layer classified, so the standing reads it the
        // same way: it is what puts a lead on a conversation-led funnel. Nothing else of the
        // delivery evidence moves — an opt-out still outranks it.
        const ledgerPositiveReply = (outcomesByLead.get(row.leadId) ?? []).some(
          (o) =>
            o.event === CRM_POSITIVE_REPLY_STEP &&
            (o.lead_campaign_id === null || o.lead_campaign_id === row.id),
        );
        const delivery: LeadStandingDelivery = ledgerPositiveReply
          ? { ...row.delivery, replied: true, replyClassification: "positive" }
          : row.delivery;

        const steps = resolveStepStates({
          allSteps: LEAD_STEP_OUTCOMES,
          funnelSteps: funnel?.steps ?? [],
          outcomes,
          nevers,
        });

        out.set(row.id, {
          standing: resolveLeadStanding({
            lifecycleStatus: row.status,
            deliveryQueried,
            delivery,
            funnel,
            funnelUnresolvedReason: unresolvedReason,
            steps,
          }),
          // Off the SAME step states, in the same pass — never a second read of the same ledger.
          closedDeal: closedDealFrom(steps),
        });
      }

      return out;
    },
  };
}
