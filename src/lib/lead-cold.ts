/**
 * A lead that WENT COLD at a step — derived, never stated.
 *
 * A positive reply from May that never led to a meeting still read as a live prospect in the
 * brand's pipeline and ROI, forever: the only way a lead was dead at a step was a person stating
 * "never". Time alone proves nothing without the customer's CRM — we simply do not see whether a
 * meeting happened. WITH their CRM mirrored and readable we would SEE a booking if one had been
 * made, so a month of silence after the step before it is evidence the lead went cold.
 *
 * The owner's rule, and only it:
 *
 *   - a positive reply, and no meeting booked within COLD_AFTER_DAYS of the reply
 *       -> cold at `meeting_booked`, since reply + COLD_AFTER_DAYS
 *   - a meeting booked, and not attended within COLD_AFTER_DAYS of the booking's date
 *       -> cold at `meeting_attended`, since booking + COLD_AFTER_DAYS
 *   - a meeting attended never goes cold (the sales cycle after a meeting runs for months).
 *
 * PURE and DERIVED ON READ, so it moves with the facts under it and is never written anywhere: a
 * lead that books (or attends) later stops reading as cold on the very next read. It is not a
 * "never" and it never becomes one — no row a person would read as somebody's decision is written.
 * A person's statement on the step (an outcome, or a "never") always wins: the step then reads as
 * what they said, and the derivation has nothing to add.
 *
 * It applies ONLY where the CRM could have shown the missing step (`CrmColdEligibility`): no
 * connection, not synced, sync failing, unreadable, or a CRM whose stages were never resolved into
 * a meaning for that step — nothing goes cold, and everything reads exactly as it did before.
 *
 * The known risk is a meeting booked in their CRM for a person we FAILED to pair with our lead: we
 * would not see it and the lead would go cold wrongly. The pairing bounds it, and the one case we
 * CAN see — a CRM contact that is a candidate for this lead but whose pairing is still unconfirmed —
 * is held back (`pairingUnconfirmed`): such a lead never goes cold until the pairing is decided.
 */
import type { StepReadState } from "./step-states.js";

/** The owner's number: how long the next step may stay silent before the lead reads as cold. */
export const COLD_AFTER_DAYS = 30;
const COLD_AFTER_MS = COLD_AFTER_DAYS * 24 * 60 * 60 * 1000;

/** The only steps the rule can make cold. */
export type ColdStep = "meeting_booked" | "meeting_attended";

/** What the stalled step was — the fact the silence is measured from. */
export type ColdAfter = "positive_reply" | "meeting_booked";

export interface WentCold {
  /** The step the lead went cold at: the one that never came. */
  step: ColdStep;
  /** When it went cold: `stalledSince` + COLD_AFTER_DAYS. */
  since: string;
  /** The step reached before the silence. */
  after: ColdAfter;
  /** When that step was reached — the instant the silence is measured from. */
  stalledSince: string;
  afterDays: number;
}

export const CRM_COLD_INELIGIBLE_REASONS = [
  // No CRM contact of this brand was ever paired against our leads, so no CRM evidence can reach
  // any of them: their CRM's silence says nothing about our leads.
  "crm_never_paired",
  "no_crm_connection",
  "crm_not_active",
  "crm_not_synced",
  "crm_sync_stale",
  "crm_sync_failing",
  "crm_unreadable",
] as const;
export type CrmColdIneligibleReason = (typeof CRM_COLD_INELIGIBLE_REASONS)[number];

/**
 * Whether the brand's CRM could have shown the step that never came.
 *
 * `evidences.meeting_booked` is true only when their CRM has at least one pipeline stage crm-service
 * resolved to "meeting booked" and serves as evidence — a CRM whose stages mean nothing to us would
 * never show a booking, so its silence proves nothing. Same for attendance (a stage meaning
 * "attended" or "not held").
 */
export interface CrmColdEligibility {
  eligible: boolean;
  reason: CrmColdIneligibleReason | null;
  evidences: Record<ColdStep, boolean>;
}

export const CRM_COLD_INELIGIBLE: (reason: CrmColdIneligibleReason) => CrmColdEligibility = (
  reason,
) => ({ eligible: false, reason, evidences: { meeting_booked: false, meeting_attended: false } });

export interface WentColdInput {
  eligibility: CrmColdEligibility;
  /** Every step's read state, with the leg graph's rules already applied (`resolveStepStates`). */
  steps: readonly StepReadState[];
  /** When the lead first replied positively (delivery layer or their CRM's form), or null. */
  positiveReplyAt: string | null;
  /** A CRM contact is a candidate for this lead and its pairing is not decided yet. */
  pairingUnconfirmed: boolean;
  now: Date;
}

function coldAt(from: string | null, now: Date): string | null {
  if (!from) return null;
  const t = Date.parse(from);
  if (!Number.isFinite(t)) return null;
  const since = t + COLD_AFTER_MS;
  return since <= now.getTime() ? new Date(since).toISOString() : null;
}

export function deriveWentCold(input: WentColdInput): WentCold | null {
  const { eligibility, now } = input;
  if (!eligibility.eligible || input.pairingUnconfirmed) return null;

  const byStep = new Map(input.steps.map((s) => [s.step, s]));
  const booked = byStep.get("meeting_booked");
  const attended = byStep.get("meeting_attended");

  // A lead who bought never goes cold, whatever the meetings read: a sale can close off a reply
  // with no meeting at all, so it implies no attendance on the leg graph and has to be read here.
  if (byStep.get("sale")?.state === "outcome") return null;

  // Attended — stated or evidenced — never goes cold. And a "never" on it is already a statement
  // of what happened: nothing to derive.
  if (attended && attended.state !== "pending") return null;

  if (booked?.state === "outcome") {
    if (!eligibility.evidences.meeting_attended) return null;
    // An implied booking carries no date (nobody stated it), and without a date there is no
    // silence to measure: never cold.
    const since = coldAt(booked.at, now);
    if (!since) return null;
    return {
      step: "meeting_attended",
      since,
      after: "meeting_booked",
      stalledSince: new Date(Date.parse(booked.at!)).toISOString(),
      afterDays: COLD_AFTER_DAYS,
    };
  }

  // A "never" on the booking is somebody's statement (or their CRM's): it wins.
  if (booked && booked.state !== "pending") return null;
  if (!eligibility.evidences.meeting_booked) return null;

  const since = coldAt(input.positiveReplyAt, now);
  if (!since) return null;
  return {
    step: "meeting_booked",
    since,
    after: "positive_reply",
    stalledSince: new Date(Date.parse(input.positiveReplyAt!)).toISOString(),
    afterDays: COLD_AFTER_DAYS,
  };
}

/** The earlier of two ISO instants, either possibly null. */
export function earlierInstant(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}
