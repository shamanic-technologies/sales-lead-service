import { describe, expect, it } from "vitest";
import { computePipeQueue, isoWeekStart } from "../../src/lib/pipe-queue.js";
import type { LeadStates, ReachedState, StepLeadState } from "../../src/lib/lead-states.js";

// features-service's step -> state map as ottawa-v1 ships it (LEAD-STATES-1024); `industry_update_video` reaches none.
const I = (state: string, rank: number): StepLeadState => ({ state, family: "interest", rank });
const CATALOGUE = new Map<string, StepLeadState>([
  ["conversation", I("lead_interested", 1)],
  ["meeting_booked", I("meeting_booked", 2)],
  ["meeting_attended", I("meeting_attended", 3)],
  ["paid_client", I("paid_client", 4)],
  ["website_visit", { state: "lead_visited", family: "visit", rank: 1 }],
]);

const at = (reachedAt: string | null): ReachedState => ({ reachedAt, basis: "meeting_booked", impliedBy: null, causedByOutreach: true, causeReason: "our_outreach" });
const states = (s: Partial<Record<keyof LeadStates, string | null>>): LeadStates => ({
  lead_interested: null,
  meeting_booked: null,
  meeting_attended: null,
  paid_client: null,
  lead_visited: null,
  ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, at(v ?? null)])),
});

const base = { from: "meeting_booked", to: "meeting_attended", catalogue: CATALOGUE, neverOnTo: new Set<string>(), untilWeek: "2026-10-26" };

describe("who waits on a pipe, and its weekly throughput (FACTORY-P4-PAGES)", () => {
  it("waits = reached the from state, not the to state, no live won't-happen; oldest wait first, undated last", () => {
    const q = computePipeQueue({
      ...base,
      neverOnTo: new Set(["dead"]),
      leads: [
        { leadId: "new", states: states({ meeting_booked: "2026-10-20T10:00:00Z" }) },
        { leadId: "old", states: states({ meeting_booked: "2026-10-01T10:00:00Z" }) },
        { leadId: "undated", states: states({ meeting_booked: null }) },
        { leadId: "dead", states: states({ meeting_booked: "2026-09-01T10:00:00Z" }) },
        { leadId: "met", states: states({ meeting_booked: "2026-10-02T10:00:00Z", meeting_attended: "2026-10-07T10:00:00Z" }) },
        { leadId: "only-replied", states: states({ lead_interested: "2026-10-03T10:00:00Z" }) },
      ],
    });
    expect(q.unservedReason).toBeNull();
    expect([q.fromState, q.toState]).toEqual(["meeting_booked", "meeting_attended"]);
    expect(q.waiting.map((w) => w.leadId)).toEqual(["old", "new", "undated"]);
    expect(q.waiting[0].waitingSince).toBe("2026-10-01T10:00:00Z");
  });

  it("throughput counts leads moving from -> to per ISO week, every week to the current one", () => {
    const q = computePipeQueue({
      ...base,
      leads: [
        { leadId: "a", states: states({ meeting_booked: "2026-10-01T10:00:00Z", meeting_attended: "2026-10-07T10:00:00Z" }) },
        { leadId: "b", states: states({ meeting_booked: "2026-10-01T10:00:00Z", meeting_attended: "2026-10-08T10:00:00Z" }) },
        { leadId: "c", states: states({ meeting_booked: "2026-10-10T10:00:00Z", meeting_attended: "2026-10-21T10:00:00Z" }) },
        // Attended BEFORE the booking date (CRM order): not this pipe's move.
        { leadId: "d", states: states({ meeting_booked: "2026-10-10T10:00:00Z", meeting_attended: "2026-10-09T10:00:00Z" }) },
      ],
    });
    expect(q.throughput).toEqual([
      { week: "2026-10-05", moved: 2 },
      { week: "2026-10-12", moved: 0 },
      { week: "2026-10-19", moved: 1 },
      { week: "2026-10-26", moved: 0 },
    ]);
  });

  it("a step reaching no state is said, never served as an empty queue", () => {
    const q = computePipeQueue({ ...base, from: "industry_update_video", leads: [{ leadId: "x", states: states({ meeting_booked: "2026-10-01T10:00:00Z" }) }] });
    expect(q.unservedReason).toBe("from_step_has_no_state");
    expect(q.waiting).toEqual([]);
    expect(computePipeQueue({ ...base, to: "nope", leads: [] }).unservedReason).toBe("to_step_has_no_state");
  });

  it("works across families: a visit waiting on a meeting", () => {
    const q = computePipeQueue({
      ...base,
      from: "website_visit",
      to: "meeting_booked",
      leads: [{ leadId: "v", states: states({ lead_visited: "2026-10-01T10:00:00Z" }) }],
    });
    expect(q.waiting.map((w) => w.leadId)).toEqual(["v"]);
  });

  it("weeks start on Monday, UTC", () => {
    expect(isoWeekStart("2026-10-25T23:59:00Z")).toBe("2026-10-19");
    expect(isoWeekStart("2026-10-26T00:00:00Z")).toBe("2026-10-26");
  });
});
