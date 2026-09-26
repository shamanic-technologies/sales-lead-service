/**
 * What every step of one lead reads as, once the leg graph's two rules are applied (step-graph.ts).
 *
 * PURE: it takes the statements a person actually made (plus whatever the delivery layer measured)
 * and answers what each step reads as. Nothing here writes, and nothing here invents a statement —
 * an implied step carries no author, no note and no date, because nobody made it. `origin` is what
 * keeps the two apart for a reader, and `statedState` is what a person really said about that step
 * even when the graph overrides it, so a real statement is never lost to satisfy the graph.
 *
 * Precedence per step, in this order and for this reason:
 *
 *   1. its own stated OUTCOME               — the person said it happened.
 *   2. an outcome on a step that can only be reached THROUGH this one — it necessarily got through
 *                                             this step to reach that one. A fact beats a
 *                                             prediction, which is exactly the same-step rule ("an
 *                                             outcome retracts a never") expressed along the legs.
 *   3. its own stated NEVER                 — the person said it will not happen.
 *   4. a never on a step every path to this one goes through — that path is closed, and there is
 *                                             no other.
 *   5. pending                              — nobody spoke, neither rule reaches it.
 *
 * A never on a step that reads as reached (rule 2) is contradicted, so it does not propagate. It is
 * still reported as `statedState: "never"` on its own step.
 */
import { STEP_ORDER, stepsRequiredBefore } from "./step-graph.js";
import type { LeadStepOutcomeName, StatementSource, StepState } from "./step-statements.js";

/** Whether a step's state is something a person stated, or something the leg graph implies. */
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
  /** What a person actually stated about THIS step, whatever the graph concluded. */
  statedState: "outcome" | "never" | null;
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
  outcomes: ReadonlyMap<LeadStepOutcomeName, StatedOutcome>;
  nevers: ReadonlyMap<LeadStepOutcomeName, StatedNever>;
}

function pending(step: LeadStepOutcomeName): StepReadState {
  return {
    step,
    state: "pending",
    origin: null,
    impliedBy: null,
    statedState: null,
    source: null,
    valueCents: null,
    costCents: null,
    causedByOutreach: null,
    note: null,
    statedByUserId: null,
    at: null,
  };
}

function implied(
  step: LeadStepOutcomeName,
  state: StepState,
  impliedBy: LeadStepOutcomeName,
  statedState: "outcome" | "never" | null,
): StepReadState {
  // Nobody stated it, so it carries no author, no note, no cost and no date.
  return {
    step,
    state,
    origin: "implied",
    impliedBy,
    statedState,
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
  const { allSteps, outcomes, nevers } = input;
  // Deepest first, so a step reached through several outcomes names the deepest one.
  const deepestFirst = [...STEP_ORDER].reverse();

  // Rule 2: reached because a step that can only be reached through it demonstrably happened.
  const reachedBy = new Map<LeadStepOutcomeName, LeadStepOutcomeName>();
  for (const outcomeStep of deepestFirst) {
    if (!outcomes.has(outcomeStep)) continue;
    for (const before of stepsRequiredBefore(outcomeStep)) {
      if (!reachedBy.has(before)) reachedBy.set(before, outcomeStep);
    }
  }
  const readsReached = (step: LeadStepOutcomeName) => outcomes.has(step) || reachedBy.has(step);

  // Rule 4: a never that is not contradicted closes every step reachable only through it.
  const closedBy = new Map<LeadStepOutcomeName, LeadStepOutcomeName>();
  for (const step of STEP_ORDER) {
    for (const before of [...stepsRequiredBefore(step)].reverse()) {
      if (nevers.has(before) && !readsReached(before)) {
        closedBy.set(step, before);
        break;
      }
    }
  }

  return allSteps.map((step) => {
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
        source: outcome.source,
        valueCents: outcome.valueCents,
        costCents: outcome.costCents,
        causedByOutreach: outcome.causedByOutreach,
        note: outcome.note,
        statedByUserId: outcome.statedByUserId,
        at: outcome.at,
      };
    }

    const reachedThrough = reachedBy.get(step);
    if (reachedThrough) return implied(step, "outcome", reachedThrough, statedState);

    if (never) {
      return {
        step,
        state: "never" as StepState,
        origin: "stated" as StepOrigin,
        impliedBy: null,
        statedState,
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

    const closedThrough = closedBy.get(step);
    if (closedThrough) return implied(step, "never", closedThrough, statedState);

    return pending(step);
  });
}
