import { describe, expect, it } from "vitest";
import { assertCatalogueCovers, evidenceCause, firstReachedStates as reach, LeadStateCatalogueError, type StateEvidence, type StepLeadState } from "../../src/lib/lead-states.js";
import {
  decodeLeadStatesCursor,
  encodeLeadStatesCursor,
  groupLeadStates as group,
  LeadStatesCursorError,
  resolveBookingCalls,
} from "../../src/lib/lead-states-read.js";

// features-service's catalogue as ottawa-v1 ships it (LEAD-STATES-1024): step -> leadState / family / rank.
const I = (state: string, rank: number): StepLeadState => ({ state, family: "interest", rank });
const V: StepLeadState = { state: "lead_visited", family: "visit", rank: 1 };
const CATALOGUE = new Map<string, StepLeadState>([
  ["conversation", I("lead_interested", 1)],
  ["form_submitted", I("lead_interested", 1)],
  ["signup", I("lead_interested", 1)],
  ["booking_call", I("lead_interested", 1)],
  ["lead_interested", I("lead_interested", 1)],
  ["meeting_booked", I("meeting_booked", 2)],
  ["meeting_attended", I("meeting_attended", 3)],
  ["paid_client", I("paid_client", 4)],
  ["purchase", I("paid_client", 4)],
  ["website_visit", V],
  ["lead_visited", V],
]);
const firstReachedStates = (e: StateEvidence[]) => reach(e, CATALOGUE);
const groupLeadStates = (rows: Parameters<typeof group>[0]) => group(rows, CATALOGUE);

const OURS = { causedByOutreach: true, causeReason: "our_outreach" } as const;
const ev = (kind: StateEvidence["kind"], at: string | null, cause: StateEvidence["cause"] = OURS): StateEvidence => ({ kind, at, cause });

describe("first reach of each lead state (LEAD-STATES-1024)", () => {
  it("3 positive replies and a later meeting = ONE interested at the first reply, ONE meeting booked", () => {
    // The SQL hands the earliest instant per evidence kind; the grouping folds three replies into one kind.
    const rows = [
      { org_id: "o", brand_id: "b", lead_id: "l", kind: "positive_reply", at: "2026-10-01 09:00:00+00" },
      { org_id: "o", brand_id: "b", lead_id: "l", kind: "meeting_booked", at: "2026-10-05 10:00:00+00" },
    ];
    const [lead] = groupLeadStates(rows);
    expect(lead.states.lead_interested).toMatchObject({ reachedAt: "2026-10-01T09:00:00.000Z", basis: "positive_reply", impliedBy: null });
    expect(lead.states.meeting_booked).toMatchObject({ reachedAt: "2026-10-05T10:00:00.000Z", basis: "meeting_booked", impliedBy: null });
    expect(lead.states.meeting_attended).toBeNull();
    expect(lead.states.paid_client).toBeNull();
    expect(lead.states.lead_visited).toBeNull();
  });

  it("a meeting booked with no positive reply makes the lead interested AT the booking", () => {
    const s = firstReachedStates([ev("meeting_booked", "2026-10-05T10:00:00.000Z")]);
    expect(s.lead_interested).toMatchObject({ reachedAt: "2026-10-05T10:00:00.000Z", basis: "meeting_booked", impliedBy: "meeting_booked" });
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
    expect(s.lead_visited).toMatchObject({ reachedAt: "2026-10-01T00:00:00.000Z", basis: "site_session", impliedBy: null });
  });

  it("an undated reach counts as reached with no date; a dated one wins", () => {
    expect(firstReachedStates([ev("sale", null)]).lead_interested).toMatchObject({ reachedAt: null, basis: "sale", impliedBy: "paid_client" });
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

  it("a signup, a form or a booking call makes the lead interested (catalogue), never visited", () => {
    for (const kind of ["signup", "form_submitted", "booking_call"] as const) {
      const s = firstReachedStates([ev(kind, "2026-10-01T00:00:00.000Z")]);
      expect(s.lead_interested).toMatchObject({ reachedAt: "2026-10-01T00:00:00.000Z", basis: kind, impliedBy: null });
      expect(s.meeting_booked).toBeNull();
      expect(s.lead_visited).toBeNull();
    }
  });

  it("a step the catalogue gives no state reaches nothing; a catalogue missing a state row is refused", () => {
    const noSignup = new Map(CATALOGUE);
    noSignup.delete("signup");
    expect(reach([ev("signup", "2026-10-01T00:00:00.000Z")], noSignup).lead_interested).toBeNull();
    const noVisit = new Map(CATALOGUE);
    noVisit.delete("lead_visited");
    expect(() => reach([], noVisit)).toThrow(LeadStateCatalogueError);
    expect(() => assertCatalogueCovers(noVisit, new Set(CATALOGUE.keys()))).toThrow(LeadStateCatalogueError);
    expect(() => assertCatalogueCovers(CATALOGUE, new Set([...CATALOGUE.keys()].filter((k) => k !== "booking_call")))).toThrow(/booking_call/);
    expect(() => assertCatalogueCovers(CATALOGUE, new Set(CATALOGUE.keys()))).not.toThrow();
  });

  it("an acted row is a booking call only when its acting campaign places them", async () => {
    const rows = [
      { org_id: "o", brand_id: "b", lead_id: "l", kind: "booking_call_candidate:call-camp", at: "2026-10-01 00:00:00+00" },
      { org_id: "o", brand_id: "b", lead_id: "m", kind: "booking_call_candidate:email-camp", at: "2026-10-01 00:00:00+00" },
    ];
    const out = await resolveBookingCalls(rows, async () => new Set(["call-camp"]));
    expect(out).toEqual([{ ...rows[0], kind: "booking_call" }]);
    expect(group(out, CATALOGUE)[0].states.lead_interested?.basis).toBe("booking_call");
  });

  it("cursor round-trips; a foreign cursor is refused", () => {
    const k = { orgId: "o", brandId: "b", leadId: "l" };
    expect(decodeLeadStatesCursor(encodeLeadStatesCursor(k))).toEqual(k);
    expect(() => decodeLeadStatesCursor("abc")).toThrow(LeadStatesCursorError);
  });
});

describe("whose win each state was (OUR-FACTORY-OUTCOMES-1027)", () => {
  const row = (kind: string, at: string | null, extra: Record<string, unknown> = {}) => ({ org_id: "o", brand_id: "b", lead_id: "l", kind, at, ...extra });
  const TOUCH = "2026-02-01 00:00:00+00";

  it("a Doc Dinners CRM form from 2024 (before our first email in 2026) = interested, NOT ours; a later positive reply does not make it ours", () => {
    const [lead] = groupLeadStates([
      row("form_submitted", "2024-08-24 10:00:00+00", { first_touch_at: TOUCH }),
      row("positive_reply", "2026-03-01 10:00:00+00", { first_touch_at: TOUCH }),
    ]);
    expect(lead.states.lead_interested).toMatchObject({ basis: "form_submitted", causedByOutreach: false, causeReason: "before_first_delivery" });
  });

  it("a positive reply to our email, a click of our link, a booking call we placed = ours", () => {
    for (const kind of ["positive_reply", "click", "booking_call"] as const) {
      expect(evidenceCause({ kind, at: "2026-03-01T00:00:00.000Z", ledger: null, firstTouchAt: null })).toEqual({ causedByOutreach: true, causeReason: "our_outreach" });
    }
  });

  it("a CRM fact goes through the ledger's date rule against our first touch (after = ours, never touched / undated = null)", () => {
    const c = (at: string | null, firstTouchAt: string | null) => evidenceCause({ kind: "signup", at, ledger: null, firstTouchAt });
    expect(c("2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toEqual({ causedByOutreach: true, causeReason: "after_first_delivery" });
    expect(c("2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toEqual({ causedByOutreach: false, causeReason: "before_first_delivery" });
    expect(c("2026-03-01T00:00:00.000Z", null)).toEqual({ causedByOutreach: null, causeReason: "never_delivered" });
    expect(c(null, "2026-02-01T00:00:00.000Z")).toEqual({ causedByOutreach: null, causeReason: "event_undated" });
    expect(evidenceCause({ kind: "positive_message", at: "2026-01-01T00:00:00.000Z", ledger: null, firstTouchAt: "2026-02-01T00:00:00.000Z" }).causedByOutreach).toBe(false);
  });

  it("a ledger row serves its STORED answer: a person's word, the rule's reason, or `recorded` when its writer stored another answer", () => {
    const l = (causedByOutreach: boolean | null, stated: boolean, ruleCausedByOutreach: boolean | null, ruleReason: string | null) =>
      evidenceCause({ kind: "meeting_booked", at: "2024-08-24T00:00:00.000Z", ledger: { causedByOutreach, stated, ruleCausedByOutreach, ruleReason }, firstTouchAt: "2026-02-01T00:00:00.000Z" });
    expect(l(true, true, false, "before_first_delivery")).toEqual({ causedByOutreach: true, causeReason: "stated" });
    expect(l(null, false, null, "never_delivered")).toEqual({ causedByOutreach: null, causeReason: "never_delivered" });
    expect(l(false, false, true, "after_first_delivery")).toEqual({ causedByOutreach: false, causeReason: "recorded" });
    expect(l(false, false, null, null)).toEqual({ causedByOutreach: false, causeReason: "recorded" });
    expect(l(null, false, null, null)).toEqual({ causedByOutreach: null, causeReason: "not_judged_yet" });
  });

  it("an implied state takes the cause of the reach that implied it; a later state reached after our touch is ours", () => {
    const [lead] = groupLeadStates([
      row("meeting_booked", "2024-08-24 10:00:00+00", { ledger: true, caused: false, stated: false, rule_caused: false, rule_reason: "before_first_delivery", first_touch_at: TOUCH }),
      row("sale", "2026-05-29 10:00:00+00", { ledger: true, caused: true, stated: false, rule_caused: true, rule_reason: "after_first_delivery", first_touch_at: TOUCH }),
    ]);
    expect(lead.states.lead_interested).toMatchObject({ impliedBy: "meeting_booked", causedByOutreach: false });
    expect(lead.states.meeting_booked).toMatchObject({ causedByOutreach: false, causeReason: "before_first_delivery" });
    expect(lead.states.meeting_attended).toMatchObject({ impliedBy: "paid_client", causedByOutreach: true });
    expect(lead.states.paid_client).toMatchObject({ causedByOutreach: true, causeReason: "after_first_delivery" });
  });
});
