/**
 * The TIMELINE vocabulary: what each fact about a person IS, and the conversation tags derived from
 * those facts, at the lead x offer x brand grain.
 *
 * Owner rules (2026-10-08):
 *   - A label is a FACT, independent of the campaign and of the channel it arrived by (our outreach,
 *     the customer's CRM, a person stating it by hand). Campaigns are attribution, never the grain.
 *   - Every item is stored (silver `lead_timeline_facts`) with whether it is ATTRIBUTABLE to us.
 *   - The conversation carries one or more tag DIMENSIONS derived from its items (gold, on read):
 *     its LAST WORD and its FURTHEST STEP.
 *
 * This module is pure: it names the vocabulary, maps each source fact onto it, and derives the
 * conversation tags. Reading and writing live in `timeline-facts.ts`. The reply vocabulary of the
 * outreach provider is NOT copied here: a reply is placed from the provider's own per-verdict flags,
 * never from a kind name.
 */
/**
 * One reply's verdict as the outreach provider serves it: its coarse classification, its four
 * flags, and the finer distinctions it derives itself (instantly-service#1022), all optional so a
 * verdict older than them still places on the flags.
 */
export interface PlaceableVerdict {
  classification: "positive" | "negative" | "neutral" | null;
  automatedAnswer: boolean;
  stopRequested: boolean;
  notOurTarget: boolean;
  handedToPerson: boolean;
  positiveSignal?: string | null;
  declinedOffer?: boolean;
  notOurTargetReason?: string | null;
  handoffReason?: string | null;
}

/** The provider's per-reply Jev judgments (instantly-service#1022), each `{value, confidence}` or null. */
export interface PlaceableJudgments {
  question?: { value: string } | null;
  proposalType?: { value: string } | null;
}

/** What one timeline item is. Closed: a new label is added here and nowhere else. */
export const TIMELINE_ITEM_LABELS = [
  // What we sent. Served by the outreach provider's fact feed.
  "initial_email",
  "followup",
  "bounced",
  // How the person reacted to an email.
  "opened",
  "website_visit",
  "link_click",
  "unsubscribed",
  "tagged_as_spam",
  // What the person answered.
  "interested",
  "not_interested",
  "question_answerable",
  "question_to_escalate",
  "question",
  "referral",
  "other_proposal",
  "hand_over",
  "wrong_contact",
  "changed_job",
  "opt_out",
  "auto_reply",
  "reply",
  // How far the person went.
  "signup",
  "form_filled",
  "meeting_booked",
  "meeting_attended",
  "paid_client",
] as const;
export type TimelineItemLabel = (typeof TIMELINE_ITEM_LABELS)[number];

/** Where a timeline fact came from. */
export const TIMELINE_SOURCES = ["outreach", "reply", "tracker", "manual", "crm", "reply_statement", "never"] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** Why an item is (or is not) ours. */
export const TIMELINE_ATTRIBUTION_BASES = [
  /** An email we sent: ours by construction. */
  "our_email",
  /** A reaction to an email we sent (a reply, an open, a click): ours by construction. */
  "reaction_to_our_email",
  /** The prospect said so in their reply (already a client: not ours). */
  "prospect_said",
  /** A person said whose win it was. */
  "person",
  /** The owner's date rule (outcome-cause.ts) answered. */
  "rule",
  /** A person stated it on a lead we worked. */
  "stated_on_our_lead",
] as const;
export type TimelineAttributionBasis = (typeof TIMELINE_ATTRIBUTION_BASES)[number];

/** The replies that are a person's word (a machine's answer is not). */
const WORD_LABELS: ReadonlySet<TimelineItemLabel> = new Set([
  "interested",
  "not_interested",
  "question_answerable",
  "question_to_escalate",
  "question",
  "referral",
  "other_proposal",
  "hand_over",
  "wrong_contact",
  "changed_job",
  "opt_out",
  "reply",
]);

const QUESTION_LABELS: ReadonlySet<TimelineItemLabel> = new Set([
  "question_answerable",
  "question_to_escalate",
  "question",
]);

/** A question, split by the provider's judgment: answerable now, or to escalate to the user. */
function questionLabel(judgments: PlaceableJudgments | null | undefined): TimelineItemLabel {
  const v = judgments?.question?.value;
  if (v === "answerable") return "question_answerable";
  if (v === "needs_sender_company") return "question_to_escalate";
  return "question";
}

/**
 * A reply, placed from the provider's per-verdict flags and distinctions (never a kind name).
 * Precedence: a machine answer is not a person's word; a stop request outranks everything a person
 * wrote beside it; then "not who we sell to" (an existing client is a PAID CLIENT, not ours: owner
 * 2026-10-08); then a hand-over to a person; then a plain no; then interest and questions. A
 * distinction the provider did not serve falls back to its flag (`hand_over`, `question`).
 * Null = not judged yet, so no item is written until it is.
 */
export function replyLabel(
  verdict: PlaceableVerdict | null,
  judgments?: PlaceableJudgments | null,
): TimelineItemLabel | null {
  if (!verdict) return null;
  if (verdict.automatedAnswer) return "auto_reply";
  if (verdict.stopRequested) return "opt_out";
  if (verdict.notOurTargetReason === "already_customer") return "paid_client";
  if (verdict.notOurTargetReason === "left_role") return "changed_job";
  if (verdict.notOurTarget || verdict.notOurTargetReason) return "wrong_contact";
  if (verdict.handoffReason === "referral") return "referral";
  if (verdict.handoffReason === "unrelated_proposal") return "other_proposal";
  if (verdict.handedToPerson) return "hand_over";
  if (verdict.declinedOffer || verdict.classification === "negative") return "not_interested";
  if (verdict.positiveSignal === "information_request") return questionLabel(judgments);
  if (verdict.positiveSignal || verdict.classification === "positive") return "interested";
  if (verdict.classification === "neutral") return questionLabel(judgments);
  return "reply";
}

/** A click: on the brand's own site it is a website visit, anywhere else a link click. */
export function clickLabel(url: string | null, siteHosts: readonly string[]): TimelineItemLabel {
  // The provider's click webhook carries no URL; a click on our email is the measured visit, as
  // the standing reads it (lead-standing.ts), until a URL says otherwise.
  if (url === null) return "website_visit";
  const host = hostOf(url);
  if (host === null) return "link_click";
  return siteHosts.some((h) => host === h || host.endsWith(`.${h}`)) ? "website_visit" : "link_click";
}

/** A URL's or domain's host, lowercased, `www.` stripped; null when unreadable. */
export function hostOf(value: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return u.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** A step outcome (conversion_events.event), placed. Null = a word this vocabulary does not hold. */
export function outcomeLabel(event: string): TimelineItemLabel | null {
  switch (event) {
    case "website_visit":
      return "website_visit";
    case "form_submission":
      return "form_filled";
    case "meeting_booked":
      return "meeting_booked";
    case "meeting_attended":
      return "meeting_attended";
    case "sale":
    case "purchase":
      return "paid_client";
    case "signup":
      return "signup";
    default:
      return null;
  }
}

/** The conversation's last word: the latest a PERSON said, or that nothing was said. */
export const CONVERSATION_LAST_WORDS = [
  "no_reply",
  "interested",
  "not_interested",
  "question_answerable",
  "question_to_escalate",
  "question",
  "referral",
  "other_proposal",
  "hand_over",
  "wrong_contact",
  "changed_job",
  "opted_out",
  "reply",
] as const;
export type ConversationLastWord = (typeof CONVERSATION_LAST_WORDS)[number];

/** The conversation's furthest step, shallowest first (owner-ordered 2026-10-08). */
export const CONVERSATION_STEPS = [
  "contacted",
  "website_visited",
  "conversation_ongoing",
  "form_filled",
  "meeting_booked",
  "meeting_attended",
  "paid_client",
] as const;
export type ConversationStep = (typeof CONVERSATION_STEPS)[number];

/** The rung an item puts the conversation on, or null when it reaches none beyond `contacted`. */
function stepOf(label: TimelineItemLabel): ConversationStep | null {
  switch (label) {
    case "website_visit":
      return "website_visited";
    case "interested":
    case "question_answerable":
    case "question_to_escalate":
    case "question":
    case "referral":
    case "other_proposal":
    case "hand_over":
      return "conversation_ongoing";
    case "form_filled":
      return "form_filled";
    case "meeting_booked":
      return "meeting_booked";
    case "meeting_attended":
      return "meeting_attended";
    case "paid_client":
      return "paid_client";
    default:
      return null;
  }
}

/** One stored item, as the gold derivation reads it. */
export interface TimelineItem {
  id: string;
  label: TimelineItemLabel;
  source: TimelineSource;
  occurredAt: string | null;
  attributable: boolean | null;
  attributionBasis: TimelineAttributionBasis | null;
  campaignId: string | null;
  /** null = a fact about the person at the brand, true on every offer page of it. */
  offerId: string | null;
  url: string | null;
  withdrawnAt: string | null;
}

export interface ConversationTags {
  lastWord: ConversationLastWord;
  /** When the last word was said; null for `no_reply`. */
  lastWordAt: string | null;
  /** null = no fact at all about this person here. */
  furthestStep: ConversationStep | null;
  /** Whether the item that put the conversation on `furthestStep` is ours (true wins over others). */
  furthestStepAttributable: boolean | null;
}

function instant(at: string | null): number {
  return at === null ? Number.POSITIVE_INFINITY : Date.parse(at);
}

/**
 * The tags of ONE conversation, from its live items (already narrowed to lead x offer x brand, the
 * brand-level ones included). Withdrawn items say nothing.
 *
 * Last word: the latest word a person said, in date order (undated last). Two owner rules carry over
 * from the reply reading (reply-outcome.ts): an opt-out is sticky, nothing said after undoes it; and
 * a plain question after an interest does not replace the interest.
 */
export function conversationTags(items: readonly TimelineItem[]): ConversationTags {
  const live = items
    .filter((i) => i.withdrawnAt === null)
    .sort((a, b) => instant(a.occurredAt) - instant(b.occurredAt) || a.id.localeCompare(b.id));

  let lastWord: ConversationLastWord = "no_reply";
  let lastWordAt: string | null = null;
  let optedOutAt: string | null | undefined;
  for (const item of live) {
    if (!WORD_LABELS.has(item.label)) continue;
    if (item.label === "opt_out") {
      if (optedOutAt === undefined) optedOutAt = item.occurredAt;
      continue;
    }
    if (lastWord === "interested" && QUESTION_LABELS.has(item.label)) continue;
    lastWord = item.label as ConversationLastWord;
    lastWordAt = item.occurredAt;
  }
  if (optedOutAt !== undefined) {
    lastWord = "opted_out";
    lastWordAt = optedOutAt;
  }

  let furthest = -1;
  let furthestAttributable: boolean | null = null;
  for (const item of live) {
    const step = stepOf(item.label);
    const rung = step === null ? 0 : CONVERSATION_STEPS.indexOf(step);
    if (rung > furthest) {
      furthest = rung;
      furthestAttributable = item.attributable;
    } else if (rung === furthest && item.attributable === true) {
      furthestAttributable = true;
    }
  }

  return {
    lastWord,
    lastWordAt,
    furthestStep: furthest < 0 ? null : CONVERSATION_STEPS[furthest],
    furthestStepAttributable: furthest < 0 ? null : furthestAttributable,
  };
}
