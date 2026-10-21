/**
 * The SIX tag dimensions of a Unibox lead (UNIBOX-SIX-TAGS-1017, owner 2026-10-17): a lead = a person crm-service
 * tags professional to the brand, at their company. Each dimension answers one question; they stack. Pure.
 *
 *   Status               prospect / customer / churned: ONE value (owner 2026-10-17)
 *   Roles                partner, investor, supplier, employee, advisor, press, other: several at once
 *                        (Status + Roles replace the single "Type"; `types` is still served while readers move)
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

/**
 * STATUS (owner 2026-10-17): ONE commercial value per person, never stacked, moving over time. Paying today =
 * customer (even after an earlier churn); paid then stopped = churned (only when a source STATES the end, never a
 * time guess); never paid = prospect. A prospect who became a customer is a customer.
 */
export const UNIBOX_STATUS = ["prospect", "customer", "churned"] as const;
export type UniboxStatus = (typeof UNIBOX_STATUS)[number];

export function statusOf(f: { customer: boolean; churned: boolean }): UniboxStatus {
  if (f.customer) return "customer";
  if (f.churned) return "churned";
  return "prospect";
}

/** One fact about being (or no longer being) a customer, as crm-service states it. `at` null = undated (a live tag: now). */
export type CustomerFact =
  | { kind: "client"; at: string | null }
  | { kind: "former_client"; at: string | null }
  | { kind: "subscription"; at: string | null; subscriptionId: string; status: string }
  | { kind: "paid"; at: string | null };

/** Stripe subscription statuses that END the relationship (crm-service, CRM-FORMER-CLIENT). */
const SUBSCRIPTION_ENDED = new Set(["canceled", "incomplete_expired"]);

const instant = (at: string | null): number => (at === null ? Number.POSITIVE_INFINITY : Date.parse(at));

/**
 * Has the person CHURNED, as a source states it (owner 2026-10-17: paid, then stopped; never a time guess)? The
 * latest END must be newer than the latest sign of being a customer:
 *   - END: a `former_client` fact (a CRM stage or tag; undated = a live tag = now), or a Stripe subscription whose
 *     latest status ended it (canceled / incomplete_expired);
 *   - CUSTOMER: a `client` fact NOT stated with a `former_client` at the same date (crm states both together for a
 *     former client), a Stripe subscription whose latest status is any other, or a payment / sale that stands.
 * A tie goes to the customer (paying today = customer, even after an earlier churn).
 */
export function customerStateFrom(facts: readonly CustomerFact[]): { churned: boolean; customerSign: boolean } {
  const formerAt = new Set(facts.filter((f) => f.kind === "former_client").map((f) => f.at ?? "undated"));
  let lastEnd = Number.NEGATIVE_INFINITY;
  let lastActive = Number.NEGATIVE_INFINITY;
  for (const f of facts) {
    if (f.kind === "former_client") lastEnd = Math.max(lastEnd, instant(f.at));
    else if (f.kind === "client" && !formerAt.has(f.at ?? "undated")) lastActive = Math.max(lastActive, instant(f.at));
    else if (f.kind === "paid") lastActive = Math.max(lastActive, instant(f.at));
  }
  // A subscription speaks by its LATEST status only.
  const latest = new Map<string, { at: number; status: string }>();
  for (const f of facts) {
    if (f.kind !== "subscription") continue;
    const at = instant(f.at);
    const cur = latest.get(f.subscriptionId);
    if (!cur || at >= cur.at) latest.set(f.subscriptionId, { at, status: f.status });
  }
  for (const s of latest.values()) {
    if (SUBSCRIPTION_ENDED.has(s.status)) lastEnd = Math.max(lastEnd, s.at);
    // A subscription still running is a customer NOW, whenever it last changed.
    else lastActive = Number.POSITIVE_INFINITY;
  }
  const churned = lastEnd > Number.NEGATIVE_INFINITY && lastEnd > lastActive;
  return { churned, customerSign: !churned && lastActive > Number.NEGATIVE_INFINITY };
}

/** ROLES (owner 2026-10-17): everything else a person is to the brand, stacking beside the status. */
export const UNIBOX_ROLES = ["partner", "investor", "supplier", "employee", "advisor", "press", "other"] as const;
export type UniboxRole = (typeof UNIBOX_ROLES)[number];

export function rolesOf(tags: readonly RelationshipTag[]): UniboxRole[] {
  const types = typesOf(tags);
  return UNIBOX_ROLES.filter((r) => (types as readonly string[]).includes(r));
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

/**
 * WHO the row is (UNIBOX-PERSON-NAME-1021, owner 2026-10-21: "Andreas Oberleitner @ Platomics", never his address).
 * The relation's own leads speak first (the person as sourced: first name, last name, current title), then the name
 * crm-service read off the conversation. A "name" holding an address is no name. Unknown = null, never a guess.
 */
export interface UniboxLeadIdentity {
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  /** Current job titles, the one at the relation's company first. */
  titles: string[];
}

export interface UniboxPersonIdentity {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
}

function realName(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t === "" || t.includes("@") ? null : t;
}

export function personIdentityOf(crmName: string | null, leads: readonly UniboxLeadIdentity[]): UniboxPersonIdentity {
  const sorted = [...leads].sort((a, b) => a.leadId.localeCompare(b.leadId));
  const named = sorted.find((l) => realName(l.firstName) || realName(l.lastName) || realName(l.name)) ?? null;
  const firstName = named ? realName(named.firstName) : null;
  const lastName = named ? realName(named.lastName) : null;
  const leadName = [firstName, lastName].filter((x) => x !== null).join(" ") || (named ? realName(named.name) : null);
  const titleOf = (l: UniboxLeadIdentity | null) => l?.titles.map((t) => t.trim()).find((t) => t !== "") ?? null;
  return {
    name: leadName || realName(crmName),
    firstName,
    lastName,
    title: titleOf(named) ?? sorted.map(titleOf).find((t) => t !== null) ?? null,
  };
}
