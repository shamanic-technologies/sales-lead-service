/**
 * WHOSE WIN a step was, read across ONE person's steps at a brand (DIGEST-SALES-ATTRIB-1105, owner
 * 2026-11-05: "a sale downstream of a step that was not ours is not ours either").
 *
 * The date rule (`crmCauseRule`: after our first touch -> ours, before -> not ours) judged each step
 * ALONE on its own date. Doc Dinners, 2026-11-03: the client tidied their CRM and created "Off
 * Boarding" opportunities that day; Thomas Keogh had booked with them in 2025-03 (stated NOT ours,
 * before our first email of 2026-07), yet his 11-03 sale read OURS because its card moved after our
 * email, and the daily email told the client "3 sales yesterday". A person the client already had in
 * their funnel before us cannot become our win because a later card moved.
 *
 * The rule, pure, per person (lead) at (org, brand):
 *   - A PERSON's word on a step is never touched here (the writers keep it; it outranks this rule).
 *   - Every step's BASE answer = a person's word on it, else the date rule. Only base answers feed the
 *     rule, so nothing loops: a step this rule turns "not ours" was already preceded by a base "not
 *     ours" step, which therefore also precedes every step after it.
 *   - DATED step the date rule calls ours: not ours when another step of the person whose base answer
 *     is "not ours" happened at or before it (`after_step_not_ours`, naming the earliest such step).
 *   - UNDATED step (the date rule cannot answer: `event_undated`): ours ONLY when the person has a step
 *     ours and NO step anywhere whose base answer is "not ours" (`undated_after_our_step`: everything we
 *     know of them came through us, e.g. Daniel Bai booked after our email); otherwise it stays null.
 *     No purchase date is invented: `occurredAt` stays null.
 *   - A POSITIVE REPLY answers OUR message: the date rule alone decides it (a reply after our email is
 *     a reply to us, whatever their history with the client).
 *   - Nothing else moves: not ours / never delivered / not matched stay as the date rule answered.
 */
import { crmCauseRule, type CrmCauseRuleReason } from "./crm-evidence.js";

export type CoherentCauseReason = CrmCauseRuleReason | "after_step_not_ours" | "undated_after_our_step";

/** The step of the person the answer leans on (when it leans on one). */
export interface CauseAnchorStep {
  event: string;
  occurredAt: string | null;
}

export interface CoherentCauseRule {
  causedByOutreach: boolean | null;
  reason: CoherentCauseReason;
  firstDeliveredAt: string | null;
  /** Present only on the two cross-step reasons. */
  afterStep?: CauseAnchorStep;
}

/** One live outcome of the person at the brand (any source). */
export interface PersonStep {
  /** Unique within the person (row id, or `crm:<step>` for a CRM step being written). */
  key: string;
  event: string;
  occurredAt: string | null;
  /** A person's word on whose win it was; null = nobody said. */
  personCause: boolean | null;
}

/** The step whose answer is the date rule's alone. */
const DATE_RULE_ONLY_EVENTS: ReadonlySet<string> = new Set(["positive_reply"]);

/** Reasons a cross-step answer may carry; anything else is the date rule's own. */
export const CROSS_STEP_REASONS: readonly CoherentCauseReason[] = ["after_step_not_ours", "undated_after_our_step"];

function instant(at: string | null): number | null {
  if (at === null) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

function baseCause(step: PersonStep, firstDeliveredAt: string | null): boolean | null {
  if (step.personCause !== null) return step.personCause;
  return crmCauseRule(step.occurredAt, firstDeliveredAt).causedByOutreach;
}

/** Earliest step (undated last), deterministic on key. */
function earliest(steps: PersonStep[]): PersonStep {
  return [...steps].sort((a, b) => {
    const ta = instant(a.occurredAt);
    const tb = instant(b.occurredAt);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  })[0];
}

function anchor(step: PersonStep): CauseAnchorStep {
  return { event: step.event, occurredAt: step.occurredAt };
}

/**
 * The rule's answer for `target` (a step nobody gave a cause for), given every live step of the same
 * person at the brand (`steps` may include the target; it is skipped by key).
 */
export function coherentCauseRule(
  target: Pick<PersonStep, "key" | "event" | "occurredAt">,
  steps: readonly PersonStep[],
  firstDeliveredAt: string | null,
): CoherentCauseRule {
  const date = crmCauseRule(target.occurredAt, firstDeliveredAt);
  if (DATE_RULE_ONLY_EVENTS.has(target.event)) return date;
  const others = steps.filter((s) => s.key !== target.key);
  const notOurs = others.filter((s) => baseCause(s, firstDeliveredAt) === false);

  if (date.reason === "event_undated") {
    if (notOurs.length > 0) return date;
    const ours = others.filter((s) => instant(s.occurredAt) !== null && baseCause(s, firstDeliveredAt) === true);
    if (ours.length === 0) return date;
    return {
      causedByOutreach: true,
      reason: "undated_after_our_step",
      firstDeliveredAt,
      afterStep: anchor(earliest(ours)),
    };
  }

  if (date.causedByOutreach !== true) return date;
  const at = instant(target.occurredAt)!;
  const before = notOurs.filter((s) => {
    const t = instant(s.occurredAt);
    return t !== null && t <= at;
  });
  if (before.length === 0) return date;
  return {
    causedByOutreach: false,
    reason: "after_step_not_ours",
    firstDeliveredAt,
    afterStep: anchor(earliest(before)),
  };
}

/** Same answer, field by field (the anchor included). */
export function sameCoherentRule(
  a: Partial<CoherentCauseRule> | null | undefined,
  b: CoherentCauseRule,
): boolean {
  if (!a) return false;
  return (
    a.causedByOutreach === b.causedByOutreach &&
    a.reason === b.reason &&
    (a.firstDeliveredAt ?? null) === b.firstDeliveredAt &&
    (a.afterStep?.event ?? null) === (b.afterStep?.event ?? null) &&
    (a.afterStep?.occurredAt ?? null) === (b.afterStep?.occurredAt ?? null)
  );
}
