/**
 * COST-ACCOUNTING-1023-P1 (second pass): every meeting / sale our outreach caused produces its outcome on the cost
 * ledger, subject = the lead, consuming the one outcome it came from. Pins each key, the subject, and the consumed rule.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

const { factOutcomeDeclaration, FACT_OUTCOME_KEYS } = await import("../../src/lib/run-outcomes.js");
const { consumedOutcomeFor, FACT_EVENTS_OF_OUTCOME, utcDay } = await import("../../src/lib/outcome-fact-declarations.js");

const none = { positiveReply: false, websiteVisit: false, formSubmitted: false, declaredMeetingBooked: false, declaredMeetingAttended: false };

describe("fact outcome declarations", () => {
  it("declares exactly meeting_booked, meeting_attended and paid_client, read off their ledger events", () => {
    expect([...FACT_OUTCOME_KEYS]).toEqual(["meeting_booked", "meeting_attended", "paid_client"]);
    expect(FACT_EVENTS_OF_OUTCOME).toEqual({
      meeting_booked: ["meeting_booked"],
      meeting_attended: ["meeting_attended"],
      paid_client: ["sale", "purchase"],
    });
  });

  it("produces the outcome and consumes its input, both on the lead", () => {
    expect(factOutcomeDeclaration({ orgId: "o", runId: "r", leadId: "L", outcomeKey: "paid_client", consumedOutcomeKey: "meeting_attended" })).toEqual({
      orgId: "o",
      runId: "r",
      produced: [{ outcomeKey: "paid_client", subjectService: "lead-service", subjectId: "L" }],
      consumed: [{ outcomeKey: "meeting_attended", subjectService: "lead-service", subjectId: "L" }],
    });
  });

  it("a booked meeting consumes the positive reply, else the website visit, else the form", () => {
    expect(consumedOutcomeFor("meeting_booked", { ...none, positiveReply: true, websiteVisit: true, formSubmitted: true })).toEqual({ outcomeKey: "conversation", basis: "positive_reply" });
    expect(consumedOutcomeFor("meeting_booked", { ...none, websiteVisit: true, formSubmitted: true })).toEqual({ outcomeKey: "website_visit", basis: "website_visit" });
    expect(consumedOutcomeFor("meeting_booked", { ...none, formSubmitted: true })).toEqual({ outcomeKey: "form_submitted", basis: "form_submitted" });
  });

  it("no entry evidence = conversation, stated as no_evidence (unknown provenance at runs-service, never $0)", () => {
    expect(consumedOutcomeFor("meeting_booked", none)).toEqual({ outcomeKey: "conversation", basis: "no_evidence" });
  });

  it("an attended meeting consumes the booked one", () => {
    expect(consumedOutcomeFor("meeting_attended", { ...none, positiveReply: true })).toEqual({ outcomeKey: "meeting_booked", basis: "meeting_booked" });
  });

  it("a paid client consumes the last of attended / booked we declared, else the entry outcome", () => {
    expect(consumedOutcomeFor("paid_client", { ...none, declaredMeetingBooked: true, declaredMeetingAttended: true })).toEqual({ outcomeKey: "meeting_attended", basis: "meeting_attended" });
    expect(consumedOutcomeFor("paid_client", { ...none, declaredMeetingBooked: true })).toEqual({ outcomeKey: "meeting_booked", basis: "meeting_booked" });
    expect(consumedOutcomeFor("paid_client", { ...none, websiteVisit: true })).toEqual({ outcomeKey: "website_visit", basis: "website_visit" });
  });

  it("the recording run is per UTC day", () => {
    expect(utcDay(new Date("2026-10-23T23:59:59.999Z"))).toBe("2026-10-23");
    expect(utcDay(new Date("2026-10-24T00:00:00.000Z"))).toBe("2026-10-24");
  });
});
