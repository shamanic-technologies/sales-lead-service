/**
 * A BOOKED MEETING WHOSE TIME HAS PASSED, NOT CANCELLED, NOT A NO-SHOW, WAS HELD (MEETING-ATTENDED-SOURCE-1028,
 * owner 2026-10-28). The pure rule; the IO is the outcome-trigger sweep (`outcome-triggers.ts` `sweepHeldMeetings`).
 *
 * Why: calendars rarely say a meeting happened. GoHighLevel appointments stay `confirmed` after the call (prod
 * 2026-10-28: 326 confirmed, 1 `showed` ever), and a Google Calendar event says nothing either, so the Meeting
 * attended trigger fired once in two weeks and every "meeting attended -> paid client" campaign sat idle.
 *
 * The rule, read off crm-service's facts by TYPE and payload, whatever the tool (GoHighLevel, Google Calendar,
 * any calendar crm-service states tomorrow), never a per-brand branch:
 *  - a `meeting_booked` fact that states WHEN the meeting is (`payload.startsAt`) is one meeting, keyed by its
 *    (source, sourceRef): crm-service re-states a moved or merged booking under the same key, the latest copy wins;
 *  - it ENDS at `payload.endsAt` when the source states a usable one (after the start), else one hour after the
 *    start (`ASSUMED_MEETING_LENGTH_MS`: a sales call; the source stated no length);
 *  - it counts as HELD once it ended `HELD_GRACE_MS` ago (time for a cancel or no-show status to reach us), unless
 *    the same meeting carries a live `meeting_not_held` (cancelled, no-show) or `meeting_attended` (the source said
 *    it: that fact fires on its own) fact, or the booking itself was withdrawn;
 *  - held AT its end. Fires like every outcome: from now on, inside the fresh window (outcome-trigger-rules.ts), once
 *    per meeting (`heldMeetingSourceRef`) and once per person (the fires ledger).
 * A booking with no meeting time (a CRM stage "Booked") says nothing about when it is held: never held here.
 */

export const MEETING_HELD_STEP = "meeting_attended";

/** Length taken for a meeting whose source states no end. */
export const ASSUMED_MEETING_LENGTH_MS = 60 * 60_000;
/** Wait after the end before calling a meeting held: a cancel or no-show the CRM records just after still wins. */
export const HELD_GRACE_MS = 60 * 60_000;

/** crm-service fact types that settle what became of a booked meeting (the source said so). */
export const MEETING_SETTLED_TYPES: readonly string[] = ["meeting_not_held", "meeting_attended"];

function instant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** When a booked meeting ends, or null when the booking states no meeting time. */
export function meetingEndOf(payload: Record<string, unknown> | null): Date | null {
  const start = instant(payload?.startsAt);
  if (start === null) return null;
  const end = instant(payload?.endsAt);
  return new Date(end !== null && end > start ? end : start + ASSUMED_MEETING_LENGTH_MS);
}

export interface BookedMeeting {
  payload: Record<string, unknown> | null;
  /** The booking fact was withdrawn. */
  withdrawn: boolean;
  /** A live `meeting_not_held` / `meeting_attended` fact names the same meeting. */
  settled: boolean;
}

export type HeldVerdict =
  | { held: true; at: Date }
  | { held: false; reason: "no_meeting_time" | "withdrawn" | "settled_by_source" | "not_over_yet" };

/** Whether a booked meeting counts as held now, and when it was. */
export function heldMeetingVerdict(m: BookedMeeting, now: Date): HeldVerdict {
  if (m.withdrawn) return { held: false, reason: "withdrawn" };
  const end = meetingEndOf(m.payload);
  if (end === null) return { held: false, reason: "no_meeting_time" };
  if (m.settled) return { held: false, reason: "settled_by_source" };
  if (now.getTime() < end.getTime() + HELD_GRACE_MS) return { held: false, reason: "not_over_yet" };
  return { held: true, at: end };
}

/** The record a held meeting fires under: one per meeting, whichever copy of its booking is read. */
export function heldMeetingSourceRef(brandId: string, source: string, sourceRef: string): string {
  return `held:${brandId}:${source}:${sourceRef}`;
}
