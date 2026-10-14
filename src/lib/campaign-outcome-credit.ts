/**
 * Which of a person's outcomes a CAMPAIGN-scoped read may credit to that campaign.
 *
 * Owner rule (VALUED-ATTRIBUTION-1014, 2026-10-14): an outcome counts for a campaign only when it
 * happened AFTER that campaign reached the person, and a campaign is never credited with a result
 * it did not produce. The outcome ledger is keyed on the person at the brand, not on the campaign,
 * so without this a campaign that serves the brand's OWN CRM contacts inherits every signup and
 * payment they made months before: Valued (4af21454, Your CRM Contacts -> Cold WhatsApp) read
 * "contacted 8, signup 9, sale 4" while every one of those 9 signups and 4 sales predated the
 * campaign's first message.
 *
 * "Reached" = the scope's FIRST TOUCH of the person (`campaignFirstTouch`): its first message when
 * it sent one (`firstSentAt` of the scope's overlay: email-gateway's send, or the channel send
 * folded in by `withChannelSend`), otherwise its serve. Finding someone IS how a source campaign
 * reaches them, and the owner supports Start -> Lead found -> Paid client funnels that never send
 * (LEADS-ONLY-FUNNEL-CAMPAIGN, 2026-10-12), so one rule covers every campaign, no per-pipe branch.
 * Never `contacted` (queued in a sequence, nothing left). An outcome is credited iff its LATEST
 * instance is strictly after that instant; an undated outcome, or a row with neither a send nor a
 * serve date, credits nothing (same "never ours when we cannot date it" stance as outcome-cause.ts).
 *
 * Only reads that name campaigns (a campaign identity or an offer's campaigns) apply it; a BRAND
 * read describes the person at the brand and keeps every live outcome.
 */
import type { LeadOutcomes } from "./lead-index.js";
import type { LeadStepOutcomeName } from "./step-statements.js";

/** The scope's first touch of a person: its first send when it sent one, otherwise its serve. */
export function campaignFirstTouch(firstSentAt: string | null, servedAt: string | null): string | null {
  return firstSentAt ?? servedAt;
}

function isAfter(at: string | null | undefined, reachMs: number): at is string {
  if (!at) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms > reachMs;
}

export function outcomesCreditedAfterReach(outcomes: LeadOutcomes, reachedAt: string | null): LeadOutcomes {
  const steps = new Set<LeadStepOutcomeName>();
  const stepAt = new Map<LeadStepOutcomeName, string | null>();
  const reachMs = reachedAt ? Date.parse(reachedAt) : NaN;
  if (!Number.isFinite(reachMs)) return { steps, latestAt: null, stepAt };

  let latestAt: string | null = null;
  const keep = (at: string) => {
    if (latestAt === null || Date.parse(at) > Date.parse(latestAt)) latestAt = at;
  };
  for (const step of outcomes.steps) {
    const at = outcomes.stepAt?.get(step);
    if (isAfter(at, reachMs)) {
      steps.add(step);
      stepAt.set(step, at);
      keep(at);
    }
  }
  const credited: LeadOutcomes = { steps, latestAt, stepAt };
  if (outcomes.positiveReply && isAfter(outcomes.positiveReplyAt, reachMs)) {
    credited.positiveReply = true;
    credited.positiveReplyAt = outcomes.positiveReplyAt;
    keep(outcomes.positiveReplyAt!);
  }
  credited.latestAt = latestAt;
  return credited;
}
