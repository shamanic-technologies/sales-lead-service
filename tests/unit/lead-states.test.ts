import { describe, expect, it } from "vitest";
import { firstReachedStates, type StateEvidence } from "../../src/lib/lead-states.js";
import { decodeLeadStatesCursor, encodeLeadStatesCursor, groupLeadStates, LeadStatesCursorError } from "../../src/lib/lead-states-read.js";

const ev = (kind: StateEvidence["kind"], at: string | null): StateEvidence => ({ kind, at });

describe("first reach of each lead state (LEAD-STATES-1024)", () => {
  it("3 positive replies and a later meeting = ONE interested at the first reply, ONE meeting booked", () => {
    // The SQL hands the earliest instant per evidence kind; the grouping folds three replies into one kind.
    const rows = [
      { org_id: "o", brand_id: "b", lead_id: "l", kind: "positive_reply", at: "2026-10-01 09:00:00+00" },
      { org_id: "o", brand_id: "b", lead_id: "l", kind: "meeting_booked", at: "2026-10-05 10:00:00+00" },
    ];
    const [lead] = groupLeadStates(rows);
    expect(lead.states.lead_interested).toEqual({ reachedAt: "2026-10-01T09:00:00.000Z", basis: "positive_reply", impliedBy: null });
    expect(lead.states.meeting_booked).toEqual({ reachedAt: "2026-10-05T10:00:00.000Z", basis: "meeting_booked", impliedBy: null });
    expect(lead.states.meeting_attended).toBeNull();
    expect(lead.states.paid_client).toBeNull();
    expect(lead.states.lead_visited).toBeNull();
  });

  it("a meeting booked with no positive reply makes the lead interested AT the booking", () => {
    const s = firstReachedStates([ev("meeting_booked", "2026-10-05T10:00:00.000Z")]);
    expect(s.lead_interested).toEqual({ reachedAt: "2026-10-05T10:00:00.000Z", basis: "meeting_booked", impliedBy: "meeting_booked" });
    expect(s.meeting_booked?.impliedBy).toBeNull();
  });

  it("a higher state reached BEFORE the lower one's own evidence dates the lower state", () => {
    const s = firstReachedStates([ev("positive_reply", "2026-10-10T00:00:00.000Z"), ev("sale", "2026-10-02T00:00:00.000Z")]);
    expect(s.lead_interested).toMatchObject({ reachedAt: "2026-10-02T00:00:00.000Z", impliedBy: "paid_client" });
    expect(s.meeting_booked).toMatchObject({ reachedAt: "2026-10-02T00:00:00.000Z", impliedBy: "paid_client" });
    expect(s.paid_client).toMatchObject({ reachedAt: "2026-10-02T00:00:00.000Z", impliedBy: null, basis: "sale" });
  });

  it("a click never makes a lead interested; a yes never makes a lead visited", () => {
    expect(firstReachedStates([ev("click", "2026-10-01T00:00:00.000Z")]).lead_interested).toBeNull();
    expect(firstReachedStates([ev("positive_reply", "2026-10-01T00:00:00.000Z"), ev("sale", "2026-10-02T00:00:00.000Z")]).lead_visited).toBeNull();
  });

  it("visited = the earliest of click, site session, stated visit", () => {
    const s = firstReachedStates([ev("click", "2026-10-03T00:00:00.000Z"), ev("site_session", "2026-10-01T00:00:00.000Z")]);
    expect(s.lead_visited).toEqual({ reachedAt: "2026-10-01T00:00:00.000Z", basis: "site_session", impliedBy: null });
  });

  it("an undated reach counts as reached with no date; a dated one wins", () => {
    expect(firstReachedStates([ev("sale", null)]).lead_interested).toEqual({ reachedAt: null, basis: "sale", impliedBy: "paid_client" });
    expect(firstReachedStates([ev("sale", null), ev("positive_reply", "2026-10-01T00:00:00.000Z")]).lead_interested).toMatchObject({
      reachedAt: "2026-10-01T00:00:00.000Z",
      basis: "positive_reply",
    });
  });

  it("groups rows per (org, brand, lead): one lead at two brands = two answers", () => {
    const out = groupLeadStates([
      { org_id: "o", brand_id: "b1", lead_id: "l", kind: "click", at: "2026-10-01 00:00:00+00" },
      { org_id: "o", brand_id: "b2", lead_id: "l", kind: "positive_reply", at: "2026-10-02 00:00:00+00" },
    ]);
    expect(out.map((r) => [r.brandId, !!r.states.lead_visited, !!r.states.lead_interested])).toEqual([
      ["b1", true, false],
      ["b2", false, true],
    ]);
  });

  it("an unknown evidence kind throws (never dropped)", () => {
    expect(() => groupLeadStates([{ org_id: "o", brand_id: "b", lead_id: "l", kind: "open", at: null }])).toThrow(/unknown evidence kind/);
  });

  it("cursor round-trips; a foreign cursor is refused", () => {
    const k = { orgId: "o", brandId: "b", leadId: "l" };
    expect(decodeLeadStatesCursor(encodeLeadStatesCursor(k))).toEqual(k);
    expect(() => decodeLeadStatesCursor("abc")).toThrow(LeadStatesCursorError);
  });
});
