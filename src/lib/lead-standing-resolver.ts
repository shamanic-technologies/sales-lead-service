/**
 * The standing of MANY leads at once — what a list read needs, resolved the same way the one-lead
 * panel resolves it.
 *
 * Two facts have to be gathered before `resolveLeadStanding` (which is pure) can answer:
 *
 *   - WHICH leg each row's campaign works. campaign-service owns `legKey` and it is never
 *     inferred, so it is read from there — ONCE per request, org-wide (`fetchOrgCampaignLegs` is a
 *     single call that returns every campaign of the org), not once per row and not once per chunk.
 *     A brand with 57k rows across a dozen campaigns therefore costs exactly one call. The leg says
 *     where the campaign's leads step onto the leg graph (step-graph.ts).
 *   - WHAT somebody stated about each row's PERSON. Two indexed reads per chunk, batched over the
 *     chunk's lead ids: the outcome ledger (`conversion_events`) and the disqualification table,
 *     filtered exactly as the panel filters them so the two surfaces cannot disagree.
 *
 * A statement is a fact about the PERSON at the BRAND, never about the membership row it was
 * clicked from. One campaign as the customer knows it is often many stored rows (campaign-service
 * used to mint a new row on every workflow switch), so a sale stated from one row must read as a
 * sale on every row of that person — exactly as a tracker or CRM event, which names no row, always
 * did. Reading it only on the row it names is what showed a won customer as a live prospect on the
 * row the board happened to surface, while the buckets (keyed on the person) said they had bought.
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
  fetchOrgCampaignLegs,
  fetchOrgCampaignOffers,
  CampaignLegsUnavailableError,
  type CampaignLegContext,
} from "./campaign-leg-client.js";
import {
  fetchReplyVerdicts,
  ReplyVerdictsUnavailableError,
  type ReplyVerdictView,
} from "./reply-verdicts-client.js";
import { leadReplyOutcome, type LeadReplyOutcome } from "./reply-outcome.js";
import { entryOfLeg, legOf, type LegEntry } from "./step-graph.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { resolveStepStates, type StatedNever, type StatedOutcome } from "./step-states.js";
import { closedDealFrom, type ClosedDeal } from "./closed-deal.js";
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";
import { deriveWentCold, earlierInstant, type CrmColdEligibility } from "./lead-cold.js";
import {
  loadCrmColdEligibility,
  loadUnconfirmedPairingLeads,
} from "./crm-cold-eligibility.js";
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
  /**
   * The person's registered email — what their replies are keyed on at instantly-service. null
   * when the lead has none, in which case no reply can be attributed to them.
   */
  email: string | null;
  delivery: LeadStandingDelivery;
}

interface OutcomeRow {
  brand_id: string;
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
  brand_id: string;
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
  /** The deal on this lead, or null when nobody has stated one. See closed-deal.ts. */
  closedDeal: ClosedDeal | null;
}

export interface LeadStandingResolver {
  resolve(rows: StandingRow[]): Promise<Map<string, ResolvedLeadFacts>>;
}

export interface LeadStandingResolverOptions extends CampaignLegContext {
  /**
   * Whether the delivery layer was asked at all. False on an unscoped read, where every row's
   * overlay is the all-false default and "nothing happened" is not something the read knows.
   */
  deliveryQueried: boolean;
}

/**
 * The org's campaign -> leg map, read once and reused for every chunk. A failure is remembered as a
 * REASON rather than retried per chunk: campaign-service being down is a property of the request,
 * and retrying it 114 times on a 57k-row walk would turn one bad answer into a stampede.
 */
async function loadCampaignLegs(
  ctx: CampaignLegContext,
): Promise<{ legs: Map<string, string | null> | null; reason: LeadStandingUnresolvedReason | null }> {
  try {
    return { legs: await fetchOrgCampaignLegs(ctx), reason: null };
  } catch (error) {
    if (!(error instanceof CampaignLegsUnavailableError)) throw error;
    console.error(
      `[lead-standing] campaign-service could not say which legs this org's campaigns work, so ` +
        `every lead's standing is unresolved rather than guessed: ${error.message}`,
    );
    return { legs: null, reason: "campaign_service_unavailable" };
  }
}

export function createLeadStandingResolver(
  options: LeadStandingResolverOptions,
): LeadStandingResolver {
  const { deliveryQueried, ...ctx } = options;
  // Which offer each campaign sells, read only once a reply needs placing on an offer.
  let campaignOffers: Promise<Map<string, string | null>> | null = null;
  const offersFor = () => {
    if (!campaignOffers) {
      campaignOffers = fetchOrgCampaignOffers(ctx).catch((error: unknown) => {
        campaignOffers = null;
        throw new ReplyVerdictsUnavailableError(
          `[lead-standing] campaign-service could not say which offer each campaign sells, so no ` +
            `reply can be placed on an offer: ${(error as Error).message}`,
        );
      });
    }
    return campaignOffers;
  };
  let campaignLegs: Promise<{
    legs: Map<string, string | null> | null;
    reason: LeadStandingUnresolvedReason | null;
  }> | null = null;
  // Whether each brand's CRM can prove an absence, asked once per brand per resolver.
  const coldEligibility = new Map<string, Promise<CrmColdEligibility>>();
  const eligibilityFor = (brandId: string) => {
    let p = coldEligibility.get(brandId);
    if (!p) coldEligibility.set(brandId, (p = loadCrmColdEligibility(ctx.orgId, brandId)));
    return p;
  };

  return {
    async resolve(rows: StandingRow[]): Promise<Map<string, ResolvedLeadFacts>> {
      const out = new Map<string, ResolvedLeadFacts>();
      if (rows.length === 0) return out;

      if (!campaignLegs) campaignLegs = loadCampaignLegs(ctx);
      const { legs, reason: legsFailure } = await campaignLegs;

      const leadIds = Array.from(new Set(rows.map((r) => r.leadId)));

      // Every reply these people sent us, each with its own current verdict. Only a scoped read asks
      // (an unscoped one asked the delivery layer nothing either), and only for rows that were
      // written to. A failure THROWS: "they never replied" is the one wrong answer that looks right.
      const repliesByEmail = new Map<string, ReplyVerdictView[]>();
      // campaign-service down leaves every served row unresolved on its leg, so nothing a reply
      // could say would be read; its own failure is already the reason on the wire.
      const replyEmails = deliveryQueried && legs !== null
        ? rows.filter((r) => r.status === "served" && r.email).map((r) => r.email!.toLowerCase())
        : [];
      if (replyEmails.length > 0) {
        const replies = await fetchReplyVerdicts(replyEmails, {
          orgId: ctx.orgId,
          userId: ctx.userId ?? null,
          runId: ctx.runId ?? null,
        });
        for (const r of replies) {
          const key = r.leadEmail.toLowerCase();
          const list = repliesByEmail.get(key);
          if (list) list.push(r);
          else repliesByEmail.set(key, [r]);
        }
      }
      const offers = repliesByEmail.size > 0 ? await offersFor() : null;
      const brandIds = Array.from(new Set(rows.flatMap((r) => r.brandIds)));

      // Outcomes credited to these people for these brands — hand-stated, tracker-reported or
      // CRM-evidenced alike, all matched on the PERSON and the brand, exactly as the panel reads.
      const outcomeRows =
        brandIds.length === 0
          ? []
          : ((await db.execute(sql`
              SELECT brand_id, matched_lead_id, event, source, value_cents, cost_cents,
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
      // Keyed on the person and the brand, like the outcomes: a "never" stated from any row of the
      // person answers for all of them. A person's own statement answers before their CRM's.
      const neverRows =
        brandIds.length === 0
          ? []
          : ((await db.execute(sql`
        SELECT lead_id, brand_id, step, source, cost_cents, note, stated_by_user_id,
               -- A CRM "never" is dated by the CRM or not at all — never by when we synced it.
               CASE WHEN source = 'crm' THEN occurred_at ELSE updated_at END AS updated_at
        FROM lead_step_disqualifications
        WHERE lead_id = ANY(${sql.param(leadIds)}::uuid[])
          AND brand_id = ANY(${sql.param(brandIds)}::text[])
          AND retracted_at IS NULL
          AND withdrawn_at IS NULL
        ORDER BY (source = 'crm') ASC, updated_at DESC NULLS LAST
      `)) as unknown as NeverRow[]);

      // The went-cold rule reads the row's PRIMARY brand's CRM. Nothing below costs anything for a
      // brand whose CRM is not usable.
      const primaryBrands = Array.from(
        new Set(rows.map((r) => r.brandIds[0]).filter((b): b is string => Boolean(b))),
      );
      const eligibilityByBrand = new Map<string, CrmColdEligibility>();
      for (const b of primaryBrands) eligibilityByBrand.set(b, await eligibilityFor(b));
      const unconfirmedByBrand = new Map<string, Set<string>>();
      for (const [b, e] of eligibilityByBrand) {
        if (!e.eligible) continue;
        const ids = Array.from(new Set(rows.filter((r) => r.brandIds[0] === b).map((r) => r.leadId)));
        unconfirmedByBrand.set(b, await loadUnconfirmedPairingLeads(b, ids));
      }
      const now = new Date();

      const outcomesByLead = new Map<string, OutcomeRow[]>();
      for (const o of outcomeRows) {
        const list = outcomesByLead.get(o.matched_lead_id);
        if (list) list.push(o);
        else outcomesByLead.set(o.matched_lead_id, [o]);
      }
      const neversByLead = new Map<string, NeverRow[]>();
      for (const n of neverRows) {
        const list = neversByLead.get(n.lead_id);
        if (list) list.push(n);
        else neversByLead.set(n.lead_id, [n]);
      }

      for (const row of rows) {
        // A campaign stating no leg (or one this service does not know) is exactly that — never
        // resolved through anything the campaign used to be keyed on.
        const leg = legs ? legOf(legs.get(row.campaignId)) : null;
        const entry: LegEntry | null = leg ? entryOfLeg(leg) : null;
        const unresolvedReason: LeadStandingUnresolvedReason | null = entry
          ? null
          : (legsFailure ?? (legs && !legs.has(row.campaignId) ? "campaign_unknown" : "leg_unstated"));

        // Rows arrive newest first, so the first one seen for a step is the one that answers. Any
        // statement about this person under one of this row's brands answers, whichever of the
        // person's rows it was stated from.
        const outcomes = new Map<LeadStepOutcomeName, StatedOutcome>();
        for (const o of outcomesByLead.get(row.leadId) ?? []) {
          if (!row.brandIds.includes(o.brand_id)) continue;
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
            at: row.delivery.firstClickedAt ?? null,
          });
        }

        const nevers = new Map<LeadStepOutcomeName, StatedNever>();
        for (const n of neversByLead.get(row.leadId) ?? []) {
          if (!row.brandIds.includes(n.brand_id)) continue;
          const step = canonicalizeStepOutcome(n.step);
          if (!step || nevers.has(step)) continue;
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
        // same way: it is what reaches a conversation entry. Nothing else of the
        // delivery evidence moves — an opt-out still outranks it.
        const ledgerPositiveReplies = (outcomesByLead.get(row.leadId) ?? []).filter(
          (o) =>
            o.event === CRM_POSITIVE_REPLY_STEP && row.brandIds.includes(o.brand_id),
        );
        let ledgerPositiveReplyAt: string | null = null;
        for (const o of ledgerPositiveReplies) {
          ledgerPositiveReplyAt = earlierInstant(ledgerPositiveReplyAt, toIsoTimestamp(o.received_at));
        }

        // The reply half of the evidence, read off every reply's own verdict (reply-outcome.ts)
        // rather than off the one coarse value the delivery layer overwrites with the latest.
        const replies: LeadReplyOutcome | null =
          deliveryQueried && row.status === "served"
            ? leadReplyOutcome({
                replies: row.email ? (repliesByEmail.get(row.email.toLowerCase()) ?? []) : [],
                rowCampaignId: row.campaignId,
                rowBrandIds: row.brandIds,
                offers,
              })
            : null;
        const delivery = replyDelivery(row.delivery, replies, ledgerPositiveReplies.length > 0, ledgerPositiveReplyAt);

        const steps = resolveStepStates({
          allSteps: LEAD_STEP_OUTCOMES,
          outcomes,
          nevers,
        });

        // Went cold? The owner's rule over the SAME step states, only where the CRM could have
        // shown the step that never came (lead-cold.ts).
        const primaryBrand = row.brandIds[0];
        const eligibility = primaryBrand ? eligibilityByBrand.get(primaryBrand) : undefined;
        // The FIRST positive reply the person sent under the brand — reached, whatever came after.
        const positiveReplyAt: string | null = earlierInstant(
          replies?.brand.reached.positive ?? null,
          ledgerPositiveReplyAt,
        );
        const wentCold =
          eligibility && entry
            ? deriveWentCold({
                eligibility,
                steps,
                positiveReplyAt,
                pairingUnconfirmed: unconfirmedByBrand.get(primaryBrand!)?.has(row.leadId) ?? false,
                now,
              })
            : null;

        out.set(row.id, {
          standing: resolveLeadStanding({
            wentCold,
            replies,
            lifecycleStatus: row.status,
            deliveryQueried,
            delivery,
            entry,
            entryUnresolvedReason: unresolvedReason,
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

/**
 * The delivery facts the standing reads, with the REPLY half taken from the reply outcome.
 *
 *   - `replied` / `replyClassification` / `disqualified` = the OFFER's latest REAL reply ("what do we
 *     do now"): a machine answer never overrides a person's, and a reply on another offer of the
 *     brand says nothing about this one.
 *   - `positiveReplyReached` = a positive reply was EVER reached on this offer ("what has this lead
 *     reached").
 *   - `replyOptOut` = the person asked us to stop in any reply under the BRAND, at any point.
 *
 * A positive reply their CRM evidences (a form submitted after our first email, on the ledger) is a
 * real positive reply too: it counts as reached, and decides "now" unless a real reply came after.
 *
 * With no reply outcome (an unscoped read, a row never served) the delivery facts stand as they are.
 */
export function replyDelivery(
  base: LeadStandingDelivery,
  replies: LeadReplyOutcome | null,
  ledgerPositiveReply: boolean,
  ledgerPositiveReplyAt: string | null,
): LeadStandingDelivery {
  if (!replies) {
    return ledgerPositiveReply ? { ...base, replied: true, replyClassification: "positive" } : base;
  }
  const latest = replies.offer.latest;
  const ledgerIsNewer =
    ledgerPositiveReply &&
    (latest === null ||
      ledgerPositiveReplyAt === null ||
      Date.parse(ledgerPositiveReplyAt) >= Date.parse(latest.receivedAt));
  const replyClassification = ledgerIsNewer ? "positive" : (latest?.classification ?? null);
  return {
    ...base,
    replied: replies.offer.realReplies > 0 || ledgerPositiveReply,
    replyClassification,
    disqualified: !ledgerIsNewer && latest !== null && latest.notOurTarget,
    positiveReplyReached: replies.offer.reached.positive !== null || ledgerPositiveReply,
    replyOptOut: replies.brand.optedOutAt !== null,
  };
}

export { ReplyVerdictsUnavailableError };
