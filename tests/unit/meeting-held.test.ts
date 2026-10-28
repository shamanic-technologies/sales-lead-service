import { describe, expect, it } from "vitest";
import {
  ASSUMED_MEETING_LENGTH_MS,
  HELD_GRACE_MS,
  heldMeetingSourceRef,
  heldMeetingVerdict,
  meetingEndOf,
} from "../../src/lib/meeting-held.js";

const start = "2026-10-28T10:00:00.000Z";
const end = "2026-10-28T10:30:00.000Z";
const at = (iso: string, plusMs: number) => new Date(Date.parse(iso) + plusMs);

describe("meeting held (MEETING-ATTENDED-SOURCE-1028)", () => {
  it("ends at the stated end, else one hour after the start; no start = no meeting time", () => {
    expect(meetingEndOf({ startsAt: start, endsAt: end })?.toISOString()).toBe(end);
    expect(meetingEndOf({ startsAt: start })?.getTime()).toBe(Date.parse(start) + ASSUMED_MEETING_LENGTH_MS);
    expect(meetingEndOf({ startsAt: start, endsAt: "2026-10-28T09:00:00.000Z" })?.getTime()).toBe(Date.parse(start) + ASSUMED_MEETING_LENGTH_MS);
    expect(meetingEndOf({ startsAt: null })).toBeNull();
    expect(meetingEndOf({ startsAt: "soon" })).toBeNull();
    expect(meetingEndOf(null)).toBeNull();
  });

  it("held once it ended + grace, at its end", () => {
    const m = { payload: { startsAt: start, endsAt: end }, withdrawn: false, settled: false };
    expect(heldMeetingVerdict(m, at(end, HELD_GRACE_MS - 1))).toEqual({ held: false, reason: "not_over_yet" });
    expect(heldMeetingVerdict(m, at(end, HELD_GRACE_MS))).toEqual({ held: true, at: new Date(end) });
  });

  it("a cancel / no-show / showed fact, a withdrawal or no meeting time: never held here", () => {
    const later = at(end, 10 * HELD_GRACE_MS);
    expect(heldMeetingVerdict({ payload: { startsAt: start }, withdrawn: false, settled: true }, later)).toMatchObject({ reason: "settled_by_source" });
    expect(heldMeetingVerdict({ payload: { startsAt: start }, withdrawn: true, settled: false }, later)).toMatchObject({ reason: "withdrawn" });
    expect(heldMeetingVerdict({ payload: { stageName: "Booked" }, withdrawn: false, settled: false }, later)).toMatchObject({ reason: "no_meeting_time" });
  });

  it("one record per meeting", () => {
    expect(heldMeetingSourceRef("b1", "gohighlevel", "appt1")).toBe("held:b1:gohighlevel:appt1");
  });
});
