/**
 * The two answers about EVERY person who writes to a brand (HOT-INBOUND-UNANSWERED-1016, owner 2026-10-16: "EVERY
 * person who writes to us is TAGGED to know whether they are a LEAD or not; and IF a lead, they are TAGGED on whether
 * they WANT to do business with us or not"), whatever the channel they came by (a message on any mirrored channel, a
 * signup, a form, a meeting, a payment, a reply to our outreach). Pure.
 *
 *   1. `lead`: DERIVED from the relationship tags (relationship-tags.ts), never judged twice: yes when `prospect` or
 *      `customer` is yes, unsure when one of them is unsure and none is yes, no when the tags speak and both are no,
 *      null when nothing speaks yet. Its basis is the strongest basis among the deciding tags.
 *   2. `wantsBusiness`: asked only of a lead (yes or unsure) who wrote to us. Bases, precedence person > judgment: a
 *      person of the org said yes or no (statement tag `wants_business`, withdrawable), else Jev's judgment of the
 *      whole thread as of now (relationship-intent-judge.ts; same edges as a tag: >= 50% yes, < 40% no, unsure
 *      between, asked on the review page). No source fact decides it: a past payment or meeting says what happened,
 *      not what the person wants now (the judge reads them in the thread).
 * Hot = lead yes AND wantsBusiness yes. Nobody here reorders or ranks anyone.
 */
import { judgedState, type RelationshipTag, type TagBasis, type TagDetail, type TagState } from "./relationship-tags.js";

/** A person's own act toward the brand on the CRM fact feed (never one of ours, never a group roster line). */
export const INBOUND_FACT_TYPES = ["message_in", "signup", "form_submitted", "meeting_booked", "meeting_attended", "payment", "sale"] as const;

/** The statement key a person of the org uses for the second answer (PUT/DELETE .../relationships/{humanId}/tags/wants_business). */
export const WANTS_BUSINESS = "wants_business" as const;
export type IntentAnswerKey = typeof WANTS_BUSINESS;

export const LEAD_TAGS: readonly RelationshipTag[] = ["prospect", "customer"];

const BASIS_RANK: Record<TagBasis, number> = { person: 3, evidence: 2, judgment: 1 };

export interface LeadAnswer {
  state: TagState | null;
  basis: TagBasis | null;
  /** The lead tags (prospect, customer) holding the decided state. */
  tags: RelationshipTag[];
}

export const WANTS_BUSINESS_REASONS = ["lead_unknown", "not_a_lead", "has_not_written", "not_judged_yet"] as const;
export type WantsBusinessReason = (typeof WANTS_BUSINESS_REASONS)[number];

export interface WantsBusinessAnswer {
  state: TagState | null;
  basis: Extract<TagBasis, "person" | "judgment"> | null;
  confidence: number | null;
  at: string | null;
  /** Why there is no answer (state null); null when there is one. */
  reason: WantsBusinessReason | null;
}

export function decideLead(details: readonly TagDetail[]): LeadAnswer {
  const leadDetails = details.filter((d) => LEAD_TAGS.includes(d.tag));
  for (const state of ["yes", "unsure", "no"] as const) {
    const hit = leadDetails.filter((d) => d.state === state);
    if (hit.length === 0) continue;
    // "no" needs every lead tag that speaks to say no (an unsure or yes already returned above).
    const basis = hit.reduce((best, d) => (BASIS_RANK[d.basis] > BASIS_RANK[best] ? d.basis : best), hit[0].basis);
    return { state, basis, tags: hit.map((d) => d.tag) };
  }
  return { state: null, basis: null, tags: [] };
}

export function decideWantsBusiness(input: {
  lead: LeadAnswer;
  wroteToUs: boolean;
  statement: { state: "yes" | "no"; at: string } | null;
  judgment: { p: number; at: string } | null;
}): WantsBusinessAnswer {
  const none = (reason: WantsBusinessReason): WantsBusinessAnswer => ({ state: null, basis: null, confidence: null, at: null, reason });
  if (input.lead.state === null) return none("lead_unknown");
  if (input.lead.state === "no") return none("not_a_lead");
  if (input.statement) return { state: input.statement.state, basis: "person", confidence: null, at: input.statement.at, reason: null };
  if (!input.wroteToUs) return none("has_not_written");
  if (!input.judgment) return none("not_judged_yet");
  return { state: judgedState(input.judgment.p), basis: "judgment", confidence: input.judgment.p, at: input.judgment.at, reason: null };
}

export const EMPTY_LEAD: LeadAnswer = { state: null, basis: null, tags: [] };
export const EMPTY_WANTS_BUSINESS: WantsBusinessAnswer = { state: null, basis: null, confidence: null, at: null, reason: "lead_unknown" };
