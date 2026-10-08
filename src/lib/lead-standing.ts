/**
 * Where ONE lead stands on the campaign it was served under — one served answer, so a consumer
 * renders a value instead of deriving one.
 *
 * "Is this person still a live prospect" is COMMERCIAL POLICY, and it was decided in three
 * independent places from two different sources with no owner: the dashboard computed it per lead
 * off the reply signals, features-service counted an aggregate for the campaign's stat card, and
 * instantly-service froze a coarse classification at write time that fed both. That split has
 * already produced a customer-visible contradiction (a referral read as interest on one surface
 * and not on the other for months). This service is the only one holding BOTH halves — the
 * delivery evidence it already joins onto the membership row, and the hand-stated step statements
 * it already owns — so the policy is authored here, once, and everything else reads it.
 *
 * LEG-AWARE, with ONE exception the owner decided (2026-09-28): a WEBSITE VISIT is interest on
 * every campaign, whatever its leg (rule 9a) — the dashboard's own definition of interested is "a
 * website visit or a positive reply", and a board that filed visitors under `engaged` contradicted
 * its own heading. What stays leg-aware is WHICH step counts as the one being worked (a visit off a
 * reply leg is interest, not that leg's entry), and everything else below. A campaign is (offer x leg x channel), and its
 * leg says where its leads step onto the leg graph (step-graph.ts): a campaign working
 * `start_to_website_visit` puts leads on the site, so somebody landing there has reached the step
 * it works; a campaign working `start_to_conversation` works a positive REPLY, and the same person
 * visiting the site reached a step off that leg — interest all the same (9a), but not its entry, so
 * `reachedEntryStep` stays false and a disqualifying reply still outranks it there.
 * The grain makes that expressible: the row is `(lead, campaign)`, so the same person can
 * legitimately stand differently under two campaigns (a positive reply off a site leg is `engaged`).
 *
 * The ladder, and why it is in this order:
 *
 *   1. never served          -> not_contacted. Nobody was written to; there is nothing to judge,
 *                              and inventing a standing for a lead nobody contacted is exactly
 *                              the fabrication this must not do.
 *   2. unsubscribed          -> opted_out. A hard opt-out, and NOTHING overrides it — not a
 *                              click, not a sale, not a hand statement. It is a decision the
 *                              person made about being contacted at all.
 *
 *                              It is its OWN state rather than a shade of `disqualified`, because
 *                              the two are different facts with different consequences: an opt-out
 *                              is the prospect's own act and legally binding, while a
 *                              disqualification is a commercial judgement of ours that we may
 *                              revisit. A board draws them as two columns, with different copy and
 *                              different moves, so it has to be able to COUNT them apart — and a
 *                              count cannot read `signal` off rows it deliberately never fetched.
 *                              Splitting the state keeps the partition intact: a lead still has
 *                              exactly one standing, so the counts still sum to the population.
 *   3. no delivery evidence  -> unresolved. The read was not scoped to a brand or a campaign, so
 *                              nothing was ever asked of the delivery layer. Stated, never
 *                              defaulted to "nothing happened".
 *   4. no leg                -> unresolved. Without the campaign's leg there is no way to know
 *                              whether a click is the step being worked or an unrelated visit, so
 *                              the question has no answer here rather than a plausible one.
 *   5. `sale` reached        -> customer.
 *   6. any step reachable from the entry reached -> sales_interest.
 *   7. `sale` reads "never"  -> disqualified. Somebody stated they will not buy (or closed the
 *                              only way to it).
 *   8. entry step reached    -> sales_interest. The measured half: a click on a campaign entering
 *                              at the site, a positive reply on one entering at a conversation.
 *   9. permanently out       -> disqualified. The delivery layer reports this person as not the
 *                              right contact, or gone from the role — ordinary sales
 *                              qualification, and the ONLY reading of a reply that takes a lead
 *                              out of play. We sell pears to supermarkets and wrote to somebody
 *                              in construction.
 *  9b. negative reply, known NOT to be that -> engaged. A decline is a judgement about the
 *                              MOMENT: the person is still reachable, the lead is still
 *                              recyclable, and the "no" is named as the evidence rather than
 *                              used as a verdict. Same posture as the bounce below.
 *  9a. website visited, on a leg that does not enter at the site -> sales_interest, stage
 *                              `website_visit`. Owner-decided 2026-09-28: a visit is interest
 *                              whatever the leg, exactly as a positive reply is; filing it under
 *                              `engaged` drew visitors in Contacted beneath a board heading that
 *                              defines interested as "a website visit or a positive reply".
 *  9c. negative reply, nobody can say which -> unresolved, reason
 *                              `reply_disqualification_unknown`. A provider that does not track
 *                              replies serves no disqualification reading at all, and neither
 *                              does a payload older than the field. Absent is stated, never
 *                              defaulted in either direction.
 *  10. replied / opened      -> engaged. Something happened; it is not the step being sold.
 *  11. bounced              -> contacted, carrying `signal: "bounced"`. A failure of DELIVERY is
 *                             not an opinion: a bad address says nothing about whether the person
 *                             behind it would buy, so they stay in play and the bounce is named
 *                             as the evidence rather than used as a verdict. It sits below the
 *                             signals above so a lead who reached a step, or who said no, is
 *                             not demoted by a later bounce on a follow-up.
 *  12. contacted            -> contacted.
 *  13. otherwise            -> not_contacted.
 *
 * Precedence between the two kinds of evidence is: a HUMAN statement (5-7) beats a machine one
 * (8-11), because a person looking at the lead knows things the delivery layer cannot see. Within
 * the machine signals, reaching the campaign's own entry step beats a reply CLASSIFICATION — a
 * classification is a judgement about a message, reaching the step is a fact about the lead. So
 * a lead who clicked through on a campaign entering at the site AND replied negatively stands at
 * `sales_interest`: they went to the site, which is what that campaign sells.
 *
 * `reachedEntryStep` is answered separately from `state`, because they are different questions and
 * both can be true at once: somebody who clicked and then unsubscribed reached the entry step
 * (true) and has opted out (state). It is `null` — never false — when the entry signal cannot be
 * resolved at all, which is every ad-delivered entry (nothing here observes an ad) and every read
 * where the leg or the delivery evidence is missing.
 *
 * The raw delivery facts (`contacted`, `clicked`, `replied`, `replyClassification`, …) stay on the
 * wire beside this, untouched. They are what let the policy change later; this is the policy.
 */
import type { WentCold } from "./lead-cold.js";
import type { LeadReplyOutcome } from "./reply-outcome.js";
import { TERMINAL_STEP, type EntryMeasure, type LegEntry } from "./step-graph.js";
import type { StepReadState } from "./step-states.js";
import type { LeadStepOutcomeName } from "./step-statements.js";

/** The step a website visit is, statable by hand and measured as a click on our email. */
const WEBSITE_VISIT_STEP = "website_visit" as const;

export const LEAD_STANDING_STATES = [
  "unresolved",
  "not_contacted",
  "contacted",
  "engaged",
  "sales_interest",
  "customer",
  "disqualified",
  "opted_out",
] as const;
export type LeadStandingState = (typeof LEAD_STANDING_STATES)[number];

/**
 * The TAG a conversation carries: the label a person-facing surface (the Unibox) shows for what
 * the person actually did. lead-service owns it (owner 2026-10-08); a consumer relays it and never
 * re-derives it. It is the state, except where the state is broader than the act: a lead whose
 * only interest is a website visit (a click on our email, or a visit stated by hand) stays
 * `sales_interest` in every count and board — a visit IS a degree of sales interest there — and
 * is tagged `website_visit`, because a click alone is not somebody telling us they want to buy.
 */
export const LEAD_STANDING_TAGS = [...LEAD_STANDING_STATES, "website_visit"] as const;
export type LeadStandingTag = (typeof LEAD_STANDING_TAGS)[number];

export const LEAD_STANDING_SIGNALS = [
  "none",
  "not_served",
  "contacted",
  "open",
  "click",
  "reply",
  "negative_reply",
  "disqualifying_reply",
  "positive_reply",
  "measured_visit",
  "stated_outcome",
  "stated_never",
  "bounced",
  "unsubscribed",
  "opt_out_reply",
] as const;
export type LeadStandingSignal = (typeof LEAD_STANDING_SIGNALS)[number];

export const LEAD_STANDING_UNRESOLVED_REASONS = [
  "delivery_not_queried",
  "campaign_service_unavailable",
  "campaign_unknown",
  "leg_unstated",
  "statements_unreadable",
  "reply_disqualification_unknown",
  "reply_verdicts_unreadable",
] as const;
export type LeadStandingUnresolvedReason = (typeof LEAD_STANDING_UNRESOLVED_REASONS)[number];

/** Who said it: a person, the leg graph's own rules, or a machine that measured it. */
export type LeadStandingOrigin = "stated" | "implied" | "measured";

export interface LeadStanding {
  state: LeadStandingState;
  /** The conversation's tag (see `LEAD_STANDING_TAGS`): the state, or `website_visit`. */
  tag: LeadStandingTag;
  signal: LeadStandingSignal;
  origin: LeadStandingOrigin | null;
  /** Why the standing is `unresolved`, and null for every other state. */
  reason: LeadStandingUnresolvedReason | null;
  /** The leg the row's campaign works (campaign-service's `legKey`), or null when unresolved. */
  legKey: string | null;
  /** Where that leg's leads step onto the leg graph (`conversation_reply`, `website_visit`, …). */
  entryStep: string | null;
  entryMeasure: EntryMeasure | null;
  /** Whether the person reached that entry step. null = the signal for it cannot be resolved. */
  reachedEntryStep: boolean | null;
  /** The deepest step reachable from the entry known to have been reached, or null. */
  deepestStep: LeadStepOutcomeName | null;
  /** When the deciding statement was made, or the first click when a measured visit decided it. */
  at: string | null;
  /**
   * Whether the lead WENT COLD at a step, and since when (lead-cold.ts) — or null.
   * A separate fact beside the state, never a state of its own: a cold lead keeps the standing it
   * has, so a board partitioned by standing is unchanged. Only ever set for a brand whose CRM is
   * connected and readable.
   */
  wentCold: WentCold | null;
  /**
   * What this person's replies mean, at the lead x OFFER and lead x BRAND grains (reply-outcome.ts),
   * built from every reply's own verdict. null when the replies were not read (an unscoped read, a
   * row never served). The state above is decided off it; this is the evidence, served beside it.
   */
  replies: LeadReplyOutcome | null;
}

export interface LeadStandingDelivery {
  contacted: boolean;
  opened: boolean;
  clicked: boolean;
  replied: boolean;
  replyClassification: "positive" | "negative" | "neutral" | null;
  /** When the delivery layer first saw a reply. Only read by the went-cold rule. */
  firstRepliedAt?: string | null;
  /** When the delivery layer first saw a click: the date of a measured visit. */
  firstClickedAt?: string | null;
  /**
   * Whether the delivery layer reports this person as PERMANENTLY out — the wrong contact, or
   * gone from the role. Derived by the provider from its own reply vocabulary and forwarded here;
   * this service reads the derived answer and never re-derives it.
   *
   * `undefined` is a THIRD state and it means nobody can tell us (a provider that does not track
   * replies, or a payload older than the field). It is neither a yes nor a no — see the ladder.
   */
  disqualified?: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  globalBounced: boolean;
  globalUnsubscribed: boolean;
  /**
   * The person asked us to STOP in a reply, under this brand (reply-outcome.ts: sticky, brand-wide).
   * Absent reads as false: the delivery layer's own unsubscribe flags above still decide.
   */
  replyOptOut?: boolean;
  /**
   * Whether a positive reply was EVER reached at this grain ("what has this lead reached"), while
   * `replyClassification` is the latest real reply ("what do we do now"). Absent reads as
   * `replyClassification === "positive"` — the two readings coincide when only one is known.
   */
  positiveReplyReached?: boolean;
}

export interface LeadStandingInput {
  /** `leads_campaigns.status`. Only a served row was ever written to. */
  lifecycleStatus: string;
  /** Whether the delivery layer was asked at all — false on an unscoped read. */
  deliveryQueried: boolean;
  delivery: LeadStandingDelivery;
  /** How the row's campaign enters the leg graph (its leg), or null when it could not be resolved. */
  entry: LegEntry | null;
  /** Why the entry is null. Required exactly when `entry` is null. */
  entryUnresolvedReason: LeadStandingUnresolvedReason | null;
  /**
   * Every step's read state, with the leg graph's two rules already applied (`resolveStepStates`).
   * A measured website visit is folded in by the caller exactly as the panel folds it in, so the
   * two surfaces cannot disagree about the same lead.
   */
  steps: readonly StepReadState[];
  /** Derived by the caller (lead-cold.ts) off the same steps. Absent reads as null. */
  wentCold?: WentCold | null;
  /** The reply outcome the delivery facts above were read off, served beside the state. */
  replies?: LeadReplyOutcome | null;
}

function base(input: LeadStandingInput): Omit<LeadStanding, "state" | "tag" | "signal" | "origin" | "reason"> {
  return {
    legKey: input.entry?.legKey ?? null,
    entryStep: input.entry?.step ?? null,
    entryMeasure: input.entry?.measure ?? null,
    reachedEntryStep: null,
    deepestStep: null,
    at: null,
    wentCold: input.wentCold ?? null,
    replies: input.replies ?? null,
  };
}

/**
 * Did this person reach the step their campaign's leg enters at?
 *
 * `null` is a real answer and the only honest one for an ad-delivered entry: nothing this service
 * holds observes an ad, so "no" would be a claim it cannot make. A step reachable from the entry
 * that reads as reached answers `true` whatever the entry measure is.
 */
function resolveEntryReached(
  input: LeadStandingInput,
  outcomeIndex: number,
): boolean | null {
  if (outcomeIndex >= 0) return true;
  if (!input.entry) return null;
  const { measure } = input.entry;
  if (measure === null) return null;
  if (!input.deliveryQueried) return null;
  if (measure === "delivery_click") return input.delivery.clicked;
  return positiveReached(input.delivery);
}

/** "What has this lead reached": a positive reply at least once, whatever came after. */
function positiveReached(delivery: LeadStandingDelivery): boolean {
  return delivery.positiveReplyReached ?? delivery.replyClassification === "positive";
}

export function resolveLeadStanding(input: LeadStandingInput): LeadStanding {
  const standing = resolveStandingState(input);
  const tag: LeadStandingTag =
    salesInterestStage(standing) === WEBSITE_VISIT_STEP ? WEBSITE_VISIT_STEP : standing.state;
  return { ...standing, tag };
}

function resolveStandingState(input: LeadStandingInput): Omit<LeadStanding, "tag"> {
  const { delivery, entry } = input;
  // The steps reachable from where this campaign's leads enter, shallowest first. A step off it (a
  // site visit on a campaign working replies) is not the thing this campaign moves leads toward.
  const scopeSteps = entry?.reachableSteps ?? [];
  const byStep = new Map(input.steps.map((s) => [s.step, s]));

  // The deepest reachable step that reads as reached, and whether the terminal step is dead. Both
  // come straight out of the leg graph's own rules — nothing is re-derived here.
  let outcomeIndex = -1;
  for (let i = 0; i < scopeSteps.length; i++) {
    if (byStep.get(scopeSteps[i])?.state === "outcome") outcomeIndex = i;
  }
  const lastState = entry ? byStep.get(TERMINAL_STEP) : undefined;

  const reachedEntryStep = resolveEntryReached(input, outcomeIndex);
  const deepestStep = outcomeIndex >= 0 ? scopeSteps[outcomeIndex] : null;
  const shared = { ...base(input), reachedEntryStep, deepestStep };

  // 1. Nobody was written to. There is nothing to judge, and judging it anyway would be inventing
  //    a standing for a lead that was never contacted.
  if (input.lifecycleStatus !== "served") {
    return { ...shared, state: "not_contacted", signal: "not_served", origin: null, reason: null };
  }

  // 2. A hard opt-out outranks every positive signal there is, including a stated sale. It is
  //    its own state, never folded into `disqualified`: the person decided this, we did not, and
  //    a consumer must be able to size that column without reading a row's evidence.
  if (delivery.unsubscribed || delivery.globalUnsubscribed) {
    return {
      ...shared,
      state: "opted_out",
      signal: "unsubscribed",
      origin: "measured",
      reason: null,
    };
  }
  // 2b. They asked us to stop IN A REPLY, under this brand — on any of its offers, at any point,
  //     whatever they wrote after. Same act as clicking the link, said in words.
  if (delivery.replyOptOut === true) {
    return {
      ...shared,
      state: "opted_out",
      signal: "opt_out_reply",
      origin: "measured",
      reason: null,
    };
  }

  // 3. Nothing was ever asked of the delivery layer, so "nothing happened" is not something this
  //    read knows. A stated outcome still answers — it needs no delivery evidence.
  if (!input.deliveryQueried && outcomeIndex < 0) {
    return {
      ...shared,
      state: "unresolved",
      signal: "none",
      origin: null,
      reason: "delivery_not_queried",
    };
  }

  // 4. Without the campaign's leg there is no telling whether a click is the step being worked.
  if (!entry) {
    return {
      ...shared,
      state: "unresolved",
      signal: "none",
      origin: null,
      reason: input.entryUnresolvedReason,
    };
  }

  const deepest = deepestStep ? byStep.get(deepestStep) : undefined;
  const statementOrigin = (s: StepReadState | undefined): LeadStandingOrigin =>
    s?.origin === "implied" ? "implied" : s?.source === "tracker" && s.step === "website_visit" ? "measured" : "stated";
  const statementSignal = (s: StepReadState | undefined): LeadStandingSignal =>
    s?.source === "tracker" && s.step === "website_visit" ? "measured_visit" : "stated_outcome";

  // 5-6. What somebody (or the leg graph) says already happened. A fact beats every machine signal.
  if (deepestStep === TERMINAL_STEP) {
    return {
      ...shared,
      state: "customer",
      signal: statementSignal(deepest),
      origin: statementOrigin(deepest),
      reason: null,
      at: deepest?.at ?? null,
    };
  }
  if (outcomeIndex >= 0) {
    return {
      ...shared,
      state: "sales_interest",
      signal: statementSignal(deepest),
      origin: statementOrigin(deepest),
      reason: null,
      at: deepest?.at ?? null,
    };
  }

  // 7. The terminal step reads "never" (stated, or closed by a never every path to it goes
  //    through): this person will not buy.
  if (lastState?.state === "never") {
    return {
      ...shared,
      state: "disqualified",
      signal: "stated_never",
      origin: lastState.origin === "implied" ? "implied" : "stated",
      reason: null,
      at: lastState.at ?? null,
    };
  }

  // 9. The measured half of the entry step: a click where the campaign enters at the site, a
  //    positive reply where it enters at a conversation. This is what a click on the campaign that sells a visit means.
  //    On a conversation entry the STATE reads the latest real reply ("what do we do now"): a
  //    positive reply followed by a "not now" reached the entry (`reachedEntryStep` stays true, the
  //    stats count it) and is no longer interest today.
  const entryHoldsNow =
    entry.measure === "delivery_click" ? reachedEntryStep === true : delivery.replyClassification === "positive";
  if (reachedEntryStep === true && entryHoldsNow) {
    return {
      ...shared,
      state: "sales_interest",
      signal: entry.measure === "delivery_click" ? "measured_visit" : "positive_reply",
      origin: "measured",
      reason: null,
      at: entry.measure === "delivery_click" ? (delivery.firstClickedAt ?? null) : null,
    };
  }

  // 10. The provider says this person is PERMANENTLY out: the wrong contact, or gone from the
  //     role. That is ordinary sales qualification — we realised they are not who we sell to —
  //     and it is the ONE thing that takes a lead out of play on the strength of a reply.
  if (delivery.disqualified === true) {
    return {
      ...shared,
      state: "disqualified",
      signal: "disqualifying_reply",
      origin: "measured",
      reason: null,
    };
  }

  // 9a. They VISITED the brand's website, on a campaign whose leg does not enter there. A visit is
  //     interest whatever the leg (owner-decided 2026-09-28): the dashboard defines interested as
  //     "a website visit or a positive reply", and filing a visitor under `engaged` put them in
  //     Contacted beneath a heading that says otherwise. Measured (a click on our email, folded in
  //     by the caller as the tracker's `website_visit`) or stated by a person, both read here as
  //     the step's outcome. It sits BELOW a disqualifying reply on purpose: off the leg, the visit
  //     is interest and not the step being worked, so a reply saying they are the wrong contact
  //     still takes them out. It sits ABOVE a negative reply, exactly as the entry step does.
  //     The click is read here too, not only through the caller's fold, so the rule does not
  //     depend on every caller remembering to fold it.
  const visit = byStep.get(WEBSITE_VISIT_STEP);
  if (visit?.state === "outcome") {
    return {
      ...shared,
      state: "sales_interest",
      signal: statementSignal(visit),
      origin: statementOrigin(visit),
      reason: null,
      at: visit.at ?? null,
    };
  }
  if (input.deliveryQueried && delivery.clicked) {
    return {
      ...shared,
      state: "sales_interest",
      signal: "measured_visit",
      origin: "measured",
      reason: null,
      at: delivery.firstClickedAt ?? null,
    };
  }

  // 11. They said no, in a message, and the campaign's own entry step was not reached.
  //
  //     A decline is a judgement about the MOMENT, not about the person: they are still reachable
  //     and the lead is still recyclable, so they stay in play and the "no" is named as the
  //     evidence rather than used as a verdict. Same posture as the bounce below.
  //
  //     When the provider serves no disqualification reading at all (`undefined` — a provider
  //     without reply tracking, or a payload older than the field), we cannot tell a decline from
  //     a wrong-contact. Absent is deliberately NOT read as "not disqualified", any more than it
  //     is read as "disqualified": both are claims this service would be making on the provider's
  //     behalf. It says so instead.
  if (delivery.replyClassification === "negative") {
    if (delivery.disqualified === undefined) {
      return {
        ...shared,
        state: "unresolved",
        signal: "negative_reply",
        origin: null,
        reason: "reply_disqualification_unknown",
      };
    }
    return {
      ...shared,
      state: "engaged",
      signal: "negative_reply",
      origin: "measured",
      reason: null,
    };
  }

  // 11. Something happened. It is not the step this campaign sells.
  if (delivery.replied) {
    return { ...shared, state: "engaged", signal: "reply", origin: "measured", reason: null };
  }
  if (delivery.clicked) {
    return { ...shared, state: "engaged", signal: "click", origin: "measured", reason: null };
  }
  if (delivery.opened) {
    return { ...shared, state: "engaged", signal: "open", origin: "measured", reason: null };
  }

  // 12. The mail did not arrive. That is a failure of DELIVERY, not an opinion: a bad address
  //     says nothing about whether the person behind it would buy, so they stay in play and the
  //     bounce is named as the evidence rather than used as a verdict. It sits HERE rather than
  //     above, so a lead who did reach a step — or who said no — is not demoted to it by a
  //     later bounce on a follow-up.
  //
  //     Deliberately NOT `engaged`: that state means the PERSON did something, and a bounce is
  //     the mail server. An address to repair is what this is, and the consumer reads `signal` to
  //     say so.
  if (delivery.bounced || delivery.globalBounced) {
    return { ...shared, state: "contacted", signal: "bounced", origin: "measured", reason: null };
  }

  if (delivery.contacted) {
    return { ...shared, state: "contacted", signal: "contacted", origin: "measured", reason: null };
  }

  // Served, in scope, and the delivery layer has no event for them yet.
  return { ...shared, state: "not_contacted", signal: "none", origin: null, reason: null };
}

/**
 * WHERE a `sales_interest` lead stands — the finer reading of that one state.
 *
 * `sales_interest` means "reached some step reachable from where the campaign put them, short of
 * `sale`": a lead who replied positively and a lead who booked a meeting both stand there, and for
 * every consumer that only asks WHETHER somebody is in play that is exactly right, so it is
 * unchanged. A board that draws one column per step needs the finer answer, and it has to be a
 * PARTITION of `sales_interest` (one step per lead, columns that do not overlap, sizes that add
 * up), which the nested engagement buckets cannot be — somebody who attended also booked.
 *
 * So the stage is the DEEPEST step known to have been reached, read off the same standing: the
 * deepest statable step when one reads as reached (stated, implied by the leg graph, tracker-
 * reported or CRM-evidenced — the standing already resolved which), otherwise the campaign's ENTRY
 * step, which is what put the lead at `sales_interest` in the first place (a positive reply where
 * the campaign enters at a conversation, a click where it enters at the site). Nothing is
 * re-derived: this is a projection of `deepestStep` / `entryStep`, which every row carries.
 *
 * `conversation_reply` / `website_visit` name an entry, and the outcome names name every later step
 * (`meeting_booked`, `meeting_attended`, `signup`, `form_submission`). `sale` is never a stage — a
 * lead who reached it is a `customer`.
 *
 * Null for every state other than `sales_interest`.
 */
export function salesInterestStage(standing: Omit<LeadStanding, "tag">): string | null {
  if (standing.state !== "sales_interest") return null;
  // A lead at `sales_interest` without a reachable step reached either reached the campaign's
  // entry (`reachedEntryStep`) or VISITED the site on a leg that does not enter there (9a) — the
  // only other door into the state — and that one's stage is the visit.
  // The entry decided it exactly when the deciding signal is the entry's own measure: a positive
  // reply on a conversation entry, a measured visit on a site entry. A lead who reached a
  // conversation entry once and reads as interest today only because they visited the site (their
  // latest reply is not positive) stands at the visit.
  const entryDecided =
    standing.reachedEntryStep === true &&
    ((standing.entryMeasure === "positive_reply" && standing.signal === "positive_reply") ||
      standing.entryMeasure === "delivery_click");
  const stage = standing.deepestStep ?? (entryDecided ? standing.entryStep : WEBSITE_VISIT_STEP);
  if (stage === null) {
    // Unreachable by construction: `sales_interest` is only ever reached through a step reading as
    // reached or the campaign's measured entry. A stage nobody can name must not be counted under a
    // guessed one.
    throw new Error("a sales_interest standing names neither a reached step nor an entry step");
  }
  return stage;
}

/**
 * Every stage a `sales_interest` lead can stand at, shallowest first on the leg graph. An
 * ad-delivered entry is never a stage on its own: nothing here observes an ad, so a lead only
 * stands there through a step that reads as reached, which names itself.
 */
export const SALES_INTEREST_STAGES = [
  "conversation_reply",
  "website_visit",
  "signup",
  "form_submission",
  "meeting_booked",
  "meeting_attended",
] as const;
export type SalesInterestStage = (typeof SALES_INTEREST_STAGES)[number];

/**
 * Resolve the `stage` query param: a comma-separated list of `SALES_INTEREST_STAGES`, read as ONE
 * set exactly as `standing` is. Absent -> null. Anything unknown, or an empty set, is a 400.
 */
export function parseSalesInterestStageFilter(raw: unknown): readonly SalesInterestStage[] | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") throw new Error("stage must be a single comma-separated string");
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`stage must name at least one of: ${SALES_INTEREST_STAGES.join(", ")}`);
  }
  const unknown = parts.filter((p) => !(SALES_INTEREST_STAGES as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown stage value(s): ${unknown.join(", ")}. Valid: ${SALES_INTEREST_STAGES.join(", ")}`,
    );
  }
  return Array.from(new Set(parts)) as SalesInterestStage[];
}

/**
 * Resolve the `standing` query param into the standings a read answers for.
 *
 * Absent → null (no standing filter). Otherwise a COMMA-SEPARATED list of standing states, read as
 * ONE set: the read answers for every named state at once, in one order, with one total and one
 * walkable cursor — exactly as `status` already reads a list of lifecycle statuses.
 *
 * It takes a list because a COLUMN of a triage board is not always ONE standing. The board draws
 * five columns over the eight states, so two of them hold two states each (still in play holds the
 * person nobody has heard from and the person who did something that is not the step their campaign
 * sells; showing interest holds the person who reached that step and the person who bought). Those
 * are product decisions about what somebody triaging a list needs side by side. Sizing such a column
 * was already solved — the counts are a partition, so a consumer adds the two numbers it is given —
 * but DRAWING it was not: two independently-ordered, independently-bounded lists cannot be merged
 * into one column that pages, so a consumer stitching them would be back to stating a cap as a
 * population. One read over the named set is the whole fix.
 *
 * Naming a single standing behaves exactly as it always did. Anything that is not a standing state
 * is a 400 (throws) — never a silent "no filter", which would answer a whole brand to a caller that
 * asked for one column, and never a silently narrowed set.
 */
export function parseLeadStandingFilter(raw: unknown): readonly LeadStandingState[] | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("standing must be a single comma-separated string");
  }
  const trimmed = raw.trim();
  const parts = trimmed.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`standing must name at least one of: ${LEAD_STANDING_STATES.join(", ")}`);
  }
  const unknown = parts.filter((p) => !(LEAD_STANDING_STATES as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown standing value(s): ${unknown.join(", ")}. Valid: ${LEAD_STANDING_STATES.join(", ")}`,
    );
  }
  return Array.from(new Set(parts)) as LeadStandingState[];
}

/** A count per standing state, every key always present — a state nobody is in is 0, never absent. */
export function zeroStandingCounts(): Record<LeadStandingState, number> {
  return Object.fromEntries(LEAD_STANDING_STATES.map((s) => [s, 0])) as Record<
    LeadStandingState,
    number
  >;
}
