/**
 * The SIX tag dimensions of a Unibox lead (UNIBOX-SIX-TAGS-1017, owner 2026-10-17): a lead = a person crm-service
 * tags professional to the brand, at their company. Each dimension answers one question; they stack. Pure.
 *
 *   Type                 who are they to us?        several at once (a customer can also be a partner)
 *   Lifecycle            how far did they ever go?  ONE value: the highest rung reached on the absolute ladder
 *   Interest             do they want to buy?       one value
 *   Conversation status  whose turn is it?          one value
 *   Contactability       may we write?              one value
 *   Fit                  right person, right company? one value + a free note
 *
 * Who decides: Type from the relationship tags (a person's word > a source's evidence > Jev); Lifecycle from the
 * steps reached, ranked by features-service's catalogue ladder (`lifecycleRank`, never hard-coded here: a step
 * declared tomorrow states its own rung); Interest = the existing "wants business" answer; Conversation status from
 * the latest word of each side; Contactability from opt-out / unsubscribe / bounce facts; Fit from the
 * disqualification marks (lead level, then company level).
 */
import type { RelationshipTag } from "./relationship-tags.js";

export const UNIBOX_TYPES = ["prospect", "customer", "partner", "investor", "supplier", "employee", "advisor", "press", "other"] as const;
export type UniboxType = (typeof UNIBOX_TYPES)[number];

/** Relationship tag -> Type value. `personal` is crm-service's connection, not a Type. */
const TYPE_OF_TAG: Partial<Record<RelationshipTag, UniboxType>> = {
  prospect: "prospect",
  customer: "customer",
  partner: "partner",
  investor: "investor",
  supplier: "supplier",
  team: "employee",
  advisor: "advisor",
  journalist: "press",
  other_professional: "other",
};

export function typesOf(tags: readonly RelationshipTag[]): UniboxType[] {
  const out = new Set<UniboxType>();
  for (const t of tags) {
    const v = TYPE_OF_TAG[t];
    if (v) out.add(v);
  }
  return UNIBOX_TYPES.filter((t) => out.has(t));
}

export const UNIBOX_INTEREST = ["interested", "not_interested", "unsure", "not_asked"] as const;
export type UniboxInterest = (typeof UNIBOX_INTEREST)[number];

export function interestOf(wantsBusiness: "yes" | "no" | "unsure" | null): UniboxInterest {
  if (wantsBusiness === "yes") return "interested";
  if (wantsBusiness === "no") return "not_interested";
  if (wantsBusiness === "unsure") return "unsure";
  return "not_asked";
}

export const UNIBOX_CONTACTABILITY = ["contactable", "unsubscribed", "bounced", "do_not_contact"] as const;
export type UniboxContactability = (typeof UNIBOX_CONTACTABILITY)[number];

/** Strongest stop first: a person's own do-not-contact / opt-out, then an unsubscribe, then a bounce. */
export function contactabilityOf(f: { doNotContact: boolean; optedOut: boolean; unsubscribed: boolean; bounced: boolean }): UniboxContactability {
  if (f.doNotContact || f.optedOut) return "do_not_contact";
  if (f.unsubscribed) return "unsubscribed";
  if (f.bounced) return "bounced";
  return "contactable";
}

export const UNIBOX_CONVERSATION = ["waiting_on_us", "waiting_on_them", "no_reply_yet", "closed"] as const;
export type UniboxConversation = (typeof UNIBOX_CONVERSATION)[number];

/**
 * Whose turn is it? Closed = nobody owes a word: we may not write (contactability) or they said no (interest).
 * Otherwise their latest word newer than ours = waiting on us; they wrote before and ours is newer = waiting on
 * them; they never wrote = no reply yet.
 */
export function conversationOf(f: {
  lastTheirsAt: string | null;
  lastOursAt: string | null;
  contactability: UniboxContactability;
  interest: UniboxInterest;
}): UniboxConversation {
  if (f.contactability !== "contactable" || f.interest === "not_interested") return "closed";
  if (f.lastTheirsAt === null) return "no_reply_yet";
  if (f.lastOursAt === null || Date.parse(f.lastTheirsAt) > Date.parse(f.lastOursAt)) return "waiting_on_us";
  return "waiting_on_them";
}

export const UNIBOX_FIT = ["fit", "wrong_person", "not_our_target"] as const;
export type UniboxFit = (typeof UNIBOX_FIT)[number];

/** The lead's own mark answers first (this person here), then the company's (nobody there is our target). */
export function fitOf(marks: { lead: boolean; company: boolean }): UniboxFit {
  if (marks.lead) return "wrong_person";
  if (marks.company) return "not_our_target";
  return "fit";
}

/** One rung of features-service's lifecycle ladder. */
export interface LifecycleRung {
  key: string;
  rank: number;
  label: string;
}

/** Each catalogue step's rank on the ladder (null = on no rung). */
export type StepRanks = ReadonlyMap<string, number | null>;

/**
 * The lead's Lifecycle: the highest rung over the steps they reached. A step the catalogue does not know, or that
 * sits on no rung, does not count. Null = no step on the ladder reached yet.
 */
export function lifecycleOf(stepsReached: Iterable<string>, ranks: StepRanks, ladder: readonly LifecycleRung[]): LifecycleRung | null {
  let best = 0;
  for (const step of stepsReached) {
    const r = ranks.get(step);
    if (typeof r === "number" && r > best) best = r;
  }
  return best === 0 ? null : (ladder.find((x) => x.rank === best) ?? null);
}

/**
 * Our timeline labels and crm-service fact types, in features-service's STEP vocabulary. Anything else reached by a
 * person is not a step (an open, a click on another site, a question).
 */
export const STEP_OF_TIMELINE_LABEL: Readonly<Record<string, string>> = {
  initial_email: "email_sent",
  followup: "email_sent",
  interested: "conversation",
  website_visit: "website_visit",
  signup: "signup",
  form_filled: "form_submitted",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  paid_client: "paid_client",
  industry_update_video: "industry_update_video",
};
