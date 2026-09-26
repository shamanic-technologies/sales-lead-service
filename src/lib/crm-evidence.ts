/**
 * WHAT THE CUSTOMER'S OWN CRM EVIDENCES ABOUT A LEAD WE EMAILED — the policy, pure.
 *
 * A customer runs their own CRM and we mirror it (crm-service). For a CRM contact PAIRED with one of
 * our leads (crm-pairing.ts decides that; only `paired` counts, never `unconfirmed` or `rejected`),
 * crm-service serves the dated funnel events their CRM evidences: a meeting booked, attended or not
 * held, a deal won or lost. Those are facts about OUR funnel steps that nobody here held, so a lead
 * whose deal their CRM shows WON read as a mere "Contacted" beside a CRM Merged row saying "We are
 * behind".
 *
 * crm-service owns what a GoHighLevel stage or status MEANS; nothing here re-derives it. This module
 * only maps crm-service's step vocabulary onto ours and answers two questions:
 *
 *   1. WHICH EVENT stands for a step. A contact often carries several (three appointments booked,
 *      a won status plus two stage entries for the same deal). The EARLIEST DATED one is the moment
 *      the step first happened, which is what a funnel step records; an undated event stands only
 *      when nothing dated exists for that step.
 *
 *   2. WHOSE WIN it was, by the owner's default rule:
 *        - the event is dated AFTER our first delivered email to that lead -> our outreach (true)
 *        - the event is dated at or before it                              -> not ours (false)
 *        - the event has no date, or we never delivered an email to them    -> undecided (null)
 *      An undated event is NEVER attributed to us. A person may override the answer per lead and
 *      per step (lead_step_cause_statements); their statement outranks the rule, and withdrawing it
 *      restores the rule's answer.
 *
 * Mapping (crm-service step -> ours):
 *   meeting_booked   -> outcome meeting_booked
 *   meeting_attended -> outcome meeting_attended
 *   sale             -> outcome sale
 *   meeting_not_held -> NEVER meeting_attended  (a meeting that did not take place)
 *   deal_lost        -> NEVER sale              (a deal their CRM closed lost)
 *   form_submitted   -> outcome positive_reply  (owner: "a form submitted in their CRM = a positive
 *                                                reply for us" — written only when the whose-win
 *                                                rule says it answered our outreach)
 * A never is represented exactly as a person's "never" is (lead_step_disqualifications), so the
 * leg graph's rules apply to it unchanged — and an outcome on the same step still beats it.
 */

/** crm-service's funnel event, as its `/orgs/gohighlevel/funnel-events` serves it. */
export interface CrmFunnelEvent {
  step: string;
  occurredAt: string | null;
  dateBasis: string | null;
  source: string | null;
  sourceId: string | null;
  detail?: Record<string, unknown> | null;
}

export type CrmEvidenceKind = "outcome" | "never";

/**
 * A POSITIVE REPLY is not a funnel step a person states (it is a delivery fact the reply
 * classifier measures), so it is not in the step-outcome vocabulary. The CRM evidences it all the
 * same — a form their prospect submitted — and it is written onto the SAME ledger under this event
 * name, which the Leads buckets and the standing read beside the delivery layer's own positive
 * reply (lead-buckets.ts, lead-standing-resolver.ts). No outcome COUNT reads it: those answer for
 * the step vocabulary only.
 */
export const CRM_POSITIVE_REPLY_STEP = "positive_reply" as const;

/** crm-service's funnel event for a form their prospect submitted — its own token, verbatim. */
export const CRM_FORM_SUBMITTED_EVENT = "form_submitted" as const;

/** The steps a CRM can evidence, in OUR vocabulary. */
export const CRM_EVIDENCED_STEPS = [
  "meeting_booked",
  "meeting_attended",
  "sale",
  CRM_POSITIVE_REPLY_STEP,
] as const;
export type CrmEvidencedStep = (typeof CRM_EVIDENCED_STEPS)[number];

const CRM_STEP_MAP: Record<string, { kind: CrmEvidenceKind; step: CrmEvidencedStep }> = {
  meeting_booked: { kind: "outcome", step: "meeting_booked" },
  meeting_attended: { kind: "outcome", step: "meeting_attended" },
  sale: { kind: "outcome", step: "sale" },
  meeting_not_held: { kind: "never", step: "meeting_attended" },
  deal_lost: { kind: "never", step: "sale" },
  [CRM_FORM_SUBMITTED_EVENT]: { kind: "outcome", step: CRM_POSITIVE_REPLY_STEP },
};

/** One step's evidence, chosen out of a contact's events. */
export interface CrmStepEvidence {
  kind: CrmEvidenceKind;
  step: CrmEvidencedStep;
  /** crm-service's own step name, verbatim (e.g. `meeting_not_held` behind a never). */
  crmStep: string;
  occurredAt: string | null;
  dateBasis: string | null;
  source: string | null;
  sourceId: string | null;
  detail: Record<string, unknown> | null;
}

function instant(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Whether `a` is a better representative of a step than `b`: dated beats undated, earlier beats later. */
function earlier(a: CrmStepEvidence, b: CrmStepEvidence): boolean {
  const ta = instant(a.occurredAt);
  const tb = instant(b.occurredAt);
  if (ta === null) return false;
  if (tb === null) return true;
  return ta < tb;
}

/**
 * The evidence per (kind, step) out of one contact's events. Unknown crm-service steps are ignored
 * (a vocabulary we do not read is not evidence of anything of ours).
 */
export function evidenceFromEvents(events: readonly CrmFunnelEvent[]): CrmStepEvidence[] {
  const best = new Map<string, CrmStepEvidence>();
  for (const e of events) {
    const mapped = CRM_STEP_MAP[e.step];
    if (!mapped) continue;
    const candidate: CrmStepEvidence = {
      kind: mapped.kind,
      step: mapped.step,
      crmStep: e.step,
      occurredAt: instant(e.occurredAt) === null ? null : new Date(e.occurredAt!).toISOString(),
      dateBasis: e.dateBasis ?? null,
      source: e.source ?? null,
      sourceId: e.sourceId ?? null,
      detail: e.detail ?? null,
    };
    const key = `${mapped.kind}:${mapped.step}`;
    const current = best.get(key);
    if (!current || earlier(candidate, current)) best.set(key, candidate);
  }
  return Array.from(best.values());
}

/**
 * Two paired contacts can name the same lead. One person is one row per step, so their evidence
 * merges by the same rule a single contact's events do.
 */
export function mergeEvidence(a: CrmStepEvidence, b: CrmStepEvidence): CrmStepEvidence {
  return earlier(b, a) ? b : a;
}

/**
 * Every form submission among these events, as positive-reply evidence — ALL of them, not the
 * earliest: a prospect who filled the form before we wrote to them and again after did answer us
 * the second time, so which one stands depends on our first delivery (`positiveReplyEvidence`).
 */
export function formSubmissionsFrom(events: readonly CrmFunnelEvent[]): CrmStepEvidence[] {
  return events
    .filter((e) => e.step === CRM_FORM_SUBMITTED_EVENT)
    .flatMap((e) => evidenceFromEvents([e]));
}

/**
 * The form submission that stands as a positive reply: the EARLIEST one dated strictly after our
 * first delivered email. `null` when none is — a form filled before we wrote, an undated one, or a
 * person we never delivered to is not a reply to anything we sent.
 */
export function positiveReplyEvidence(
  submissions: readonly CrmStepEvidence[],
  firstDeliveredAt: string | null,
): CrmStepEvidence | null {
  const delivered = instant(firstDeliveredAt);
  if (delivered === null) return null;
  let best: CrmStepEvidence | null = null;
  for (const s of submissions) {
    const t = instant(s.occurredAt);
    if (t === null || t <= delivered) continue;
    if (!best || t < instant(best.occurredAt)!) best = s;
  }
  return best;
}

/** Why the rule answered what it answered. Served beside the answer, never collapsed into it. */
export type CrmCauseRuleReason =
  | "after_first_delivery"
  | "before_first_delivery"
  | "event_undated"
  | "never_delivered";

export interface CrmCauseRule {
  causedByOutreach: boolean | null;
  reason: CrmCauseRuleReason;
  /** Our first delivered email to this person at brand scope — the rule's other input. */
  firstDeliveredAt: string | null;
}

/** The owner's default rule. An undated event is never attributed to us. */
export function crmCauseRule(
  occurredAt: string | null,
  firstDeliveredAt: string | null,
): CrmCauseRule {
  const event = instant(occurredAt);
  if (event === null) {
    return { causedByOutreach: null, reason: "event_undated", firstDeliveredAt };
  }
  const delivered = instant(firstDeliveredAt);
  if (delivered === null) {
    return { causedByOutreach: null, reason: "never_delivered", firstDeliveredAt: null };
  }
  return event > delivered
    ? { causedByOutreach: true, reason: "after_first_delivery", firstDeliveredAt }
    : { causedByOutreach: false, reason: "before_first_delivery", firstDeliveredAt };
}

/** Who the effective answer comes from. `null` basis only when there is nothing to answer about. */
export type CrmCauseBasis = "rule" | "person";

/** A person's override outranks the rule; withdrawing it restores the rule. */
export function effectiveCrmCause(
  rule: CrmCauseRule,
  statement: { causedByOutreach: boolean } | null,
): { causedByOutreach: boolean | null; basis: CrmCauseBasis } {
  if (statement) return { causedByOutreach: statement.causedByOutreach, basis: "person" };
  return { causedByOutreach: rule.causedByOutreach, basis: "rule" };
}

/**
 * The dedupe signature of a CRM-evidenced outcome in `conversion_events`: one per (brand, person,
 * step), disjoint from the tracker's `k:`/`a:` and a person's `m:` signatures.
 */
export function crmOutcomeSignature(leadId: string, step: string): string {
  return `crm:${leadId}:${step}`;
}

/** What `crm_evidence` holds on a stored row. */
export interface StoredCrmEvidence {
  crmContactId: string;
  crmStep: string;
  source: string | null;
  sourceId: string | null;
  dateBasis: string | null;
  detail: Record<string, unknown> | null;
  rule?: CrmCauseRule;
}

export function isCrmEvidencedStep(step: string): step is CrmEvidencedStep {
  return (CRM_EVIDENCED_STEPS as readonly string[]).includes(step);
}
