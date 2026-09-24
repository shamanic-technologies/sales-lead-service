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
 * FUNNEL-AWARE, deliberately. The alternative — "a click is buying intent everywhere" — makes a
 * click mean interest on a campaign that prices no click. A campaign selling `form_magnet` is
 * selling `visit -> form -> paid`, so somebody landing on the site has reached the step it sells;
 * a campaign selling meetings off a conversation prices a positive REPLY, and the same person
 * visiting the site has done something the campaign does not price. The grain makes that
 * expressible: the row is `(lead, campaign)`, so the same person can legitimately stand at
 * `sales_interest` under one campaign and `engaged` under another, which is what is true.
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
 *   4. no funnel             -> unresolved. Without the campaign's funnel there is no way to know
 *                              whether a click is the step being sold or an unrelated visit, so
 *                              the question has no answer here rather than a plausible one.
 *   5. the funnel's last step reached  -> customer.
 *   6. any funnel step reached         -> sales_interest.
 *   7. the funnel's last step "never"  -> disqualified. Somebody stated they will not buy, and
 *                                        a "never" propagates forward, so it lands on the last
 *                                        step whichever step it was made on.
 *   8. entry step reached    -> sales_interest. The measured half: a click on a visit-led funnel,
 *                              a positive reply on a conversation-led one.
 *   9. permanently out       -> disqualified. The delivery layer reports this person as not the
 *                              right contact, or gone from the role — ordinary sales
 *                              qualification, and the ONLY reading of a reply that takes a lead
 *                              out of play. We sell pears to supermarkets and wrote to somebody
 *                              in construction.
 *  9b. negative reply, known NOT to be that -> engaged. A decline is a judgement about the
 *                              MOMENT: the person is still reachable, the lead is still
 *                              recyclable, and the "no" is named as the evidence rather than
 *                              used as a verdict. Same posture as the bounce below.
 *  9c. negative reply, nobody can say which -> unresolved, reason
 *                              `reply_disqualification_unknown`. A provider that does not track
 *                              replies serves no disqualification reading at all, and neither
 *                              does a payload older than the field. Absent is stated, never
 *                              defaulted in either direction.
 *  10. replied / clicked / opened -> engaged. Something happened; it is not the step being sold.
 *  11. bounced              -> contacted, carrying `signal: "bounced"`. A failure of DELIVERY is
 *                             not an opinion: a bad address says nothing about whether the person
 *                             behind it would buy, so they stay in play and the bounce is named
 *                             as the evidence rather than used as a verdict. It sits below the
 *                             signals above so a lead who reached the funnel, or who said no, is
 *                             not demoted by a later bounce on a follow-up.
 *  12. contacted            -> contacted.
 *  13. otherwise            -> not_contacted.
 *
 * Precedence between the two kinds of evidence is: a HUMAN statement (5-7) beats a machine one
 * (8-11), because a person looking at the lead knows things the delivery layer cannot see. Within
 * the machine signals, reaching the funnel's own entry step beats a reply CLASSIFICATION — a
 * classification is a judgement about a message, reaching the step is a fact about the funnel. So
 * a lead who clicked through on a `form_magnet` campaign AND replied negatively stands at
 * `sales_interest`: they went to the site, which is what that campaign sells.
 *
 * `reachedEntryStep` is answered separately from `state`, because they are different questions and
 * both can be true at once: somebody who clicked and then unsubscribed reached the entry step
 * (true) and has opted out (state). It is `null` — never false — when the entry signal cannot be
 * resolved at all, which is every ads-led funnel (nothing here observes an ad click) and every read
 * where the funnel or the delivery evidence is missing.
 *
 * The raw delivery facts (`contacted`, `clicked`, `replied`, `replyClassification`, …) stay on the
 * wire beside this, untouched. They are what let the policy change later; this is the policy.
 */
import type { FunnelEntry, FunnelEntryMeasure, FunnelKey } from "./funnel-steps.js";
import type { StepReadState } from "./step-funnel-state.js";
import type { LeadStepOutcomeName } from "./step-statements.js";

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
] as const;
export type LeadStandingSignal = (typeof LEAD_STANDING_SIGNALS)[number];

export const LEAD_STANDING_UNRESOLVED_REASONS = [
  "delivery_not_queried",
  "campaign_service_unavailable",
  "campaign_unknown",
  "funnel_unstated",
  "statements_unreadable",
  "reply_disqualification_unknown",
] as const;
export type LeadStandingUnresolvedReason = (typeof LEAD_STANDING_UNRESOLVED_REASONS)[number];

/** Who said it: a person, the funnel's own rules, or a machine that measured it. */
export type LeadStandingOrigin = "stated" | "implied" | "measured";

export interface LeadStanding {
  state: LeadStandingState;
  signal: LeadStandingSignal;
  origin: LeadStandingOrigin | null;
  /** Why the standing is `unresolved`, and null for every other state. */
  reason: LeadStandingUnresolvedReason | null;
  funnelKey: FunnelKey | null;
  /** How this campaign's funnel is entered, in brand-service's funnel vocabulary. */
  entryStep: string | null;
  entryMeasure: FunnelEntryMeasure | null;
  /** Whether the person got onto the funnel. null = the signal for it cannot be resolved. */
  reachedEntryStep: boolean | null;
  /** The deepest step of this campaign's funnel known to have been reached, or null. */
  deepestStep: LeadStepOutcomeName | null;
  /** When the deciding statement was made, when a statement decided it. */
  at: string | null;
}

export interface LeadStandingDelivery {
  contacted: boolean;
  opened: boolean;
  clicked: boolean;
  replied: boolean;
  replyClassification: "positive" | "negative" | "neutral" | null;
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
}

export interface ResolvedLeadFunnel {
  key: FunnelKey;
  steps: readonly LeadStepOutcomeName[];
  entry: FunnelEntry;
}

export interface LeadStandingInput {
  /** `leads_campaigns.status`. Only a served row was ever written to. */
  lifecycleStatus: string;
  /** Whether the delivery layer was asked at all — false on an unscoped read. */
  deliveryQueried: boolean;
  delivery: LeadStandingDelivery;
  /** The campaign's funnel, or null when it could not be resolved. */
  funnel: ResolvedLeadFunnel | null;
  /** Why the funnel is null. Required exactly when `funnel` is null. */
  funnelUnresolvedReason: LeadStandingUnresolvedReason | null;
  /**
   * Every step's read state, with the funnel's two rules already applied (`resolveStepStates`).
   * A measured website visit is folded in by the caller exactly as the panel folds it in, so the
   * two surfaces cannot disagree about the same lead.
   */
  steps: readonly StepReadState[];
}

function base(input: LeadStandingInput): Omit<LeadStanding, "state" | "signal" | "origin" | "reason"> {
  return {
    funnelKey: input.funnel?.key ?? null,
    entryStep: input.funnel?.entry.step ?? null,
    entryMeasure: input.funnel?.entry.measure ?? null,
    reachedEntryStep: null,
    deepestStep: null,
    at: null,
  };
}

/**
 * Did this person get ONTO the funnel?
 *
 * `null` is a real answer and the only honest one for an ads-led funnel: nothing this service
 * holds observes an ad click, so "no" would be a claim it cannot make. A funnel step reached
 * answers `true` whatever the entry measure is — a lead who booked a meeting necessarily got onto
 * the funnel that leads to booking one.
 */
function resolveEntryReached(
  input: LeadStandingInput,
  funnelOutcomeIndex: number,
): boolean | null {
  if (funnelOutcomeIndex >= 0) return true;
  if (!input.funnel) return null;
  const { measure } = input.funnel.entry;
  if (measure === null) return null;
  if (!input.deliveryQueried) return null;
  if (measure === "delivery_click") return input.delivery.clicked;
  return input.delivery.replyClassification === "positive";
}

export function resolveLeadStanding(input: LeadStandingInput): LeadStanding {
  const { delivery, funnel } = input;
  const funnelSteps = funnel?.steps ?? [];
  const byStep = new Map(input.steps.map((s) => [s.step, s]));

  // The deepest step of the funnel that reads as reached, and whether the funnel's last step is
  // dead. Both come straight out of the funnel's own rules — nothing is re-derived here.
  let funnelOutcomeIndex = -1;
  for (let i = 0; i < funnelSteps.length; i++) {
    if (byStep.get(funnelSteps[i])?.state === "outcome") funnelOutcomeIndex = i;
  }
  const lastStep = funnelSteps.length > 0 ? funnelSteps[funnelSteps.length - 1] : null;
  const lastState = lastStep ? byStep.get(lastStep) : undefined;

  const reachedEntryStep = resolveEntryReached(input, funnelOutcomeIndex);
  const deepestStep = funnelOutcomeIndex >= 0 ? funnelSteps[funnelOutcomeIndex] : null;
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

  // 3. Nothing was ever asked of the delivery layer, so "nothing happened" is not something this
  //    read knows. A stated funnel outcome still answers — it needs no delivery evidence.
  if (!input.deliveryQueried && funnelOutcomeIndex < 0) {
    return {
      ...shared,
      state: "unresolved",
      signal: "none",
      origin: null,
      reason: "delivery_not_queried",
    };
  }

  // 4. Without the funnel there is no telling whether a click is the step being sold.
  if (!funnel) {
    return {
      ...shared,
      state: "unresolved",
      signal: "none",
      origin: null,
      reason: input.funnelUnresolvedReason,
    };
  }

  const deepest = deepestStep ? byStep.get(deepestStep) : undefined;
  const statementOrigin = (s: StepReadState | undefined): LeadStandingOrigin =>
    s?.origin === "implied" ? "implied" : s?.source === "tracker" && s.step === "website_visit" ? "measured" : "stated";
  const statementSignal = (s: StepReadState | undefined): LeadStandingSignal =>
    s?.source === "tracker" && s.step === "website_visit" ? "measured_visit" : "stated_outcome";

  // 5-6. What somebody (or the funnel) says already happened. A fact beats every machine signal.
  if (funnelOutcomeIndex >= 0 && funnelOutcomeIndex === funnelSteps.length - 1) {
    return {
      ...shared,
      state: "customer",
      signal: statementSignal(deepest),
      origin: statementOrigin(deepest),
      reason: null,
      at: deepest?.at ?? null,
    };
  }
  if (funnelOutcomeIndex >= 0) {
    return {
      ...shared,
      state: "sales_interest",
      signal: statementSignal(deepest),
      origin: statementOrigin(deepest),
      reason: null,
      at: deepest?.at ?? null,
    };
  }

  // 7. A "never" propagates forward, so it lands on the funnel's last step whichever step it was
  //    stated on: this person will not buy.
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

  // 9. The measured half of the entry step: a click on a visit-led funnel, a positive reply on a
  //    conversation-led one. This is what a click on the campaign that sells a visit means.
  if (reachedEntryStep === true) {
    return {
      ...shared,
      state: "sales_interest",
      signal: funnel.entry.measure === "delivery_click" ? "measured_visit" : "positive_reply",
      origin: "measured",
      reason: null,
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

  // 11. They said no, in a message, and the funnel's own entry step was not reached.
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
  //     above, so a lead who did reach the funnel — or who said no — is not demoted to it by a
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
 * WHERE ON THE FUNNEL a `sales_interest` lead stands — the finer reading of that one state.
 *
 * `sales_interest` means "reached some step of the funnel this campaign sells, short of its last":
 * a lead who replied positively and a lead who booked a meeting both stand there, and for every
 * consumer that only asks WHETHER somebody is in play that is exactly right, so it is unchanged.
 * A board that draws one column per funnel step needs the finer answer, and it has to be a
 * PARTITION of `sales_interest` (one step per lead, columns that do not overlap, sizes that add
 * up), which the nested engagement buckets cannot be — somebody who attended also booked.
 *
 * So the stage is the DEEPEST step known to have been reached, read off the same standing: the
 * deepest statable funnel step when one reads as reached (stated, implied by a later step, tracker-
 * reported or CRM-evidenced — the standing already resolved which), otherwise the funnel's ENTRY
 * step, which is what put the lead at `sales_interest` in the first place (a positive reply on a
 * conversation-led funnel, a click on a visit-led one). Nothing is re-derived: this is a projection
 * of `deepestStep` / `entryStep`, which the standing already carries on every row.
 *
 * The vocabulary is the funnel's own step names: `conversation_reply` / `website_visit` for an
 * entry (brand-service's funnel vocabulary, as `entryStep` already is), and the outcome names for
 * every later step (`meeting_booked`, `meeting_attended`, `signup`, `form_submission`). The last
 * step (`sale`) is never a stage — a lead who reached it is a `customer`.
 *
 * Null for every state other than `sales_interest`.
 */
export function salesInterestStage(standing: LeadStanding): string | null {
  if (standing.state !== "sales_interest") return null;
  const stage = standing.deepestStep ?? standing.entryStep;
  if (stage === null) {
    // Unreachable by construction: `sales_interest` is only ever reached through a funnel step or
    // the funnel's measured entry. A stage nobody can name must not be counted under a guessed one.
    throw new Error("a sales_interest standing names neither a funnel step nor an entry step");
  }
  return stage;
}

/**
 * Every stage a `sales_interest` lead can stand at, in the order a funnel is walked. The ENTRY
 * steps an ads-led funnel starts at are absent: nothing here observes an ad click, so no lead can
 * ever stand there and a zero would be a claim, not a count.
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
 * The stages ONE funnel's `sales_interest` leads can stand at, in funnel order: its measured entry,
 * then every statable step short of the last. A visit-led funnel's entry and first statable step
 * are the same step (`website_visit`), so it appears once.
 */
export function salesInterestStagesOf(
  entry: FunnelEntry,
  steps: readonly LeadStepOutcomeName[],
): SalesInterestStage[] {
  const out: string[] = [];
  if (entry.measure !== null) out.push(entry.step);
  for (const step of steps.slice(0, -1)) if (!out.includes(step)) out.push(step);
  return out.filter((s): s is SalesInterestStage =>
    (SALES_INTEREST_STAGES as readonly string[]).includes(s),
  );
}

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
