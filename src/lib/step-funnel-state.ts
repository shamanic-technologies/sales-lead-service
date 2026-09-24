/**
 * What every step of one lead's funnel reads as, once the funnel's two rules are applied.
 *
 * PURE: it takes the statements a person actually made (plus whatever the delivery layer measured)
 * and answers what each step reads as. Nothing here writes, and nothing here invents a statement —
 * an implied step carries no author, no note and no date, because nobody made it. `origin` is what
 * keeps the two apart for a reader, and `statedState` is what a person really said about that step
 * even when the funnel overrides it, so a real statement is never lost to satisfy the funnel.
 *
 * Precedence per step, in this order and for this reason:
 *
 *   1. its own stated OUTCOME               — the person said it happened.
 *   2. an outcome LATER on the funnel        — it necessarily got through this step to reach that
 *                                             one. A fact beats a prediction, which is exactly the
 *                                             same-step rule ("an outcome retracts a never")
 *                                             expressed along the funnel.
 *   3. its own stated NEVER                 — the person said it will not happen.
 *   4. a never EARLIER on the funnel         — once a step is false, everything after it is false.
 *   5. pending                              — nobody spoke, neither rule reaches it.
 *
 * A never that sits at or before the deepest outcome is contradicted by that outcome, so it does
 * not propagate forward (rule 2 beats it at its own step, and it cannot make later steps never
 * while a later step demonstrably happened). It is still reported as `statedState: "never"` on its
 * own step.
 */
import type { LeadStepOutcomeName, StatementSource, StepState } from "./step-statements.js";

/** Whether a step's state is something a person stated, or something the funnel implies. */
export type StepOrigin = "stated" | "implied";

export interface StatedOutcome {
  source: StatementSource;
  valueCents: number | null;
  /** What the CUSTOMER stated this leg cost them. Null = never asked; 0 = a stated zero. */
  costCents: number | null;
  /**
   * WHOSE win it was: true = the customer says our outreach caused this outcome, false = they say
   * something else of theirs did (a referral, a conference, their own pipeline — still a REAL
   * outcome), null = nobody was ever asked. Null is never read as either answer.
   */
  causedByOutreach: boolean | null;
  note: string | null;
  statedByUserId: string | null;
  at: string | null;
}

export interface StatedNever {
  /**
   * `manual` — a person stated it; `crm` — the customer's own CRM evidences it (a meeting not
   * held, a deal lost) for a lead paired with that CRM contact. Absent reads as `manual`, which is
   * what every "never" was before a CRM could evidence one.
   */
  source?: StatementSource;
  /** What the CUSTOMER stated this dead leg cost them. Null = never asked; 0 = a stated zero. */
  costCents: number | null;
  note: string | null;
  statedByUserId: string | null;
  at: string | null;
}

export interface StepReadState {
  step: LeadStepOutcomeName;
  state: StepState;
  /** null exactly when the step is pending. */
  origin: StepOrigin | null;
  /** The STATED step that implies this one, or null when nothing implies it. */
  impliedBy: LeadStepOutcomeName | null;
  /** What a person actually stated about THIS step, whatever the funnel concluded. */
  statedState: "outcome" | "never" | null;
  /** Whether this step is part of the lead's funnel at all. */
  inFunnel: boolean;
  stepIndex: number | null;
  source: StatementSource | null;
  valueCents: number | null;
  /**
   * What the CUSTOMER stated getting through this step cost them, in cents. Null on a pending step
   * (nobody said anything), on an IMPLIED one (nobody stated it, so nobody stated its cost either
   * — an implied step is not a statement) and on a statement made before the cost was asked for.
   * 0 is a stated zero, and it is not the same thing as null.
   */
  costCents: number | null;
  /**
   * WHOSE win it was — `true` our outreach, `false` something else of the customer's, `null` nobody
   * was asked. Null on a pending step, on an IMPLIED one (nobody stated it, so nobody stated its
   * cause), on a "never" (nothing happened, so nothing caused it) and on a tracker-reported outcome
   * (a page-load tag observes a page load and cannot know why somebody bought).
   */
  causedByOutreach: boolean | null;
  note: string | null;
  statedByUserId: string | null;
  at: string | null;
}

export interface ResolveStepStatesInput {
  /** Every step this service can answer for, in the order the response lists them. */
  allSteps: readonly LeadStepOutcomeName[];
  /** The lead's funnel, in order. */
  funnelSteps: readonly LeadStepOutcomeName[];
  outcomes: ReadonlyMap<LeadStepOutcomeName, StatedOutcome>;
  nevers: ReadonlyMap<LeadStepOutcomeName, StatedNever>;
}

function pending(
  step: LeadStepOutcomeName,
  inFunnel: boolean,
  stepIndex: number | null,
): StepReadState {
  return {
    step,
    state: "pending",
    origin: null,
    impliedBy: null,
    statedState: null,
    inFunnel,
    stepIndex,
    source: null,
    valueCents: null,
    costCents: null,
    causedByOutreach: null,
    note: null,
    statedByUserId: null,
    at: null,
  };
}

export function resolveStepStates(input: ResolveStepStatesInput): StepReadState[] {
  const { allSteps, funnelSteps, outcomes, nevers } = input;

  // The deepest step on the funnel a stated outcome reaches. Everything up to it is reached.
  let deepestOutcome = -1;
  for (let i = 0; i < funnelSteps.length; i++) {
    if (outcomes.has(funnelSteps[i])) deepestOutcome = i;
  }

  // The shallowest never that is NOT contradicted by that outcome. Everything from it on is never.
  let earliestNever = -1;
  for (let i = funnelSteps.length - 1; i > deepestOutcome; i--) {
    if (nevers.has(funnelSteps[i])) earliestNever = i;
  }

  return allSteps.map((step) => {
    const index = funnelSteps.indexOf(step);
    const inFunnel = index >= 0;
    const stepIndex = inFunnel ? index : null;
    const outcome = outcomes.get(step) ?? null;
    const never = nevers.get(step) ?? null;
    const statedState: "outcome" | "never" | null = outcome ? "outcome" : never ? "never" : null;

    if (outcome) {
      return {
        step,
        state: "outcome" as StepState,
        origin: "stated" as StepOrigin,
        impliedBy: null,
        statedState,
        inFunnel,
        stepIndex,
        source: outcome.source,
        valueCents: outcome.valueCents,
        costCents: outcome.costCents,
        causedByOutreach: outcome.causedByOutreach,
        note: outcome.note,
        statedByUserId: outcome.statedByUserId,
        at: outcome.at,
      };
    }

    if (inFunnel && deepestOutcome >= 0 && index < deepestOutcome) {
      // Reached, because a later step on this funnel demonstrably happened. Nobody stated it, so it
      // carries no author, no note and no date.
      return {
        step,
        state: "outcome" as StepState,
        origin: "implied" as StepOrigin,
        impliedBy: funnelSteps[deepestOutcome],
        statedState,
        inFunnel,
        stepIndex,
        source: null,
        valueCents: null,
        costCents: null,
        causedByOutreach: null,
        note: null,
        statedByUserId: null,
        at: null,
      };
    }

    if (never) {
      return {
        step,
        state: "never" as StepState,
        origin: "stated" as StepOrigin,
        impliedBy: null,
        statedState,
        inFunnel,
        stepIndex,
        source: never.source ?? ("manual" as StatementSource),
        valueCents: null,
        costCents: never.costCents,
        // Nothing happened, so nothing caused it.
        causedByOutreach: null,
        note: never.note,
        statedByUserId: never.statedByUserId,
        at: never.at,
      };
    }

    if (inFunnel && earliestNever >= 0 && index > earliestNever) {
      return {
        step,
        state: "never" as StepState,
        origin: "implied" as StepOrigin,
        impliedBy: funnelSteps[earliestNever],
        statedState,
        inFunnel,
        stepIndex,
        source: null,
        valueCents: null,
        costCents: null,
        causedByOutreach: null,
        note: null,
        statedByUserId: null,
        at: null,
      };
    }

    return pending(step, inFunnel, stepIndex);
  });
}
