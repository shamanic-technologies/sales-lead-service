/**
 * COST-ACCOUNTING-1023-P1 (second pass): every meeting / sale our outreach caused produces its outcome on the cost
 * ledger, subject = the lead, consuming the one outcome it came from. Pins each key, the subject, and the consumed rule.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

const { factOutcomeDeclaration, FACT_OUTCOME_KEYS } = await import("../../src/lib/run-outcomes.js");
const { consumedOutcomeFor, FACT_EVENTS_OF_OUTCOME, FACT_SOURCES_OF_OUTCOME, performerOf, utcDay, firstCrmReaches, CRM_REACHED_OUTCOMES, personOfLeadRows } = await import("../../src/lib/outcome-fact-declarations.js");

const none = { positiveReply: false, websiteVisit: false, formSubmitted: false, declaredMeetingBooked: false, declaredMeetingAttended: false, declaredPurchase: false };

describe("fact outcome declarations", () => {
  it("declares every fact outcome this service records, read off their ledger events (LEDGER-HISTORY-1024)", () => {
    expect([...FACT_OUTCOME_KEYS]).toEqual(["website_visit", "signup", "form_submitted", "purchase", "meeting_booked", "meeting_attended", "paid_client"]);
    expect(FACT_EVENTS_OF_OUTCOME).toEqual({
      website_visit: ["website_visit"],
      signup: ["signup"],
      form_submitted: ["form_submission"],
      purchase: ["sale", "purchase"],
      meeting_booked: ["meeting_booked"],
      meeting_attended: ["meeting_attended"],
      paid_client: ["sale", "purchase"],
    });
    // A Direct purchase is a sale the website tag reported; a stated / CRM / reply sale is Paid client only.
    expect(FACT_SOURCES_OF_OUTCOME).toEqual({ purchase: ["tracker"] });
  });

  it("a visit consumes the message our outreach sent; a signup, form or direct purchase the visit, else the positive reply, else the message", () => {
    expect(consumedOutcomeFor("website_visit", { ...none, positiveReply: true })).toEqual({ outcomeKey: "message_sent", basis: "message_sent" });
    for (const o of ["signup", "form_submitted", "purchase"] as const) {
      expect(consumedOutcomeFor(o, { ...none, websiteVisit: true, positiveReply: true })).toEqual({ outcomeKey: "website_visit", basis: "website_visit" });
      expect(consumedOutcomeFor(o, { ...none, positiveReply: true })).toEqual({ outcomeKey: "conversation", basis: "positive_reply" });
      expect(consumedOutcomeFor(o, none)).toEqual({ outcomeKey: "message_sent", basis: "message_sent" });
    }
  });

  it("a paid client consumes the direct purchase we declared first", () => {
    expect(consumedOutcomeFor("paid_client", { ...none, declaredPurchase: true, declaredMeetingAttended: true })).toEqual({ outcomeKey: "purchase", basis: "purchase" });
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

  it("an attended meeting consumes the booking we declared, else the entry outcome (never an undeclared booking)", () => {
    expect(consumedOutcomeFor("meeting_attended", { ...none, positiveReply: true, declaredMeetingBooked: true })).toEqual({ outcomeKey: "meeting_booked", basis: "meeting_booked" });
    expect(consumedOutcomeFor("meeting_attended", { ...none, positiveReply: true })).toEqual({ outcomeKey: "conversation", basis: "positive_reply" });
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

describe("performerOf (LEAD-GENERIC-1106): every externally attested occurrence names who performed it", () => {
  it("our script when its send first touched the person, else the fact's attester", () => {
    expect(performerOf("cold-email-v7", "crm")).toEqual({ kind: "script", workflowSlug: "cold-email-v7" });
    expect(performerOf(null, "crm")).toEqual({ kind: "crm" });
    expect(performerOf(null, "tracker")).toEqual({ kind: "tracker" });
    expect(performerOf(null, "manual")).toEqual({ kind: "client_team", name: "manual" });
  });

  it("the declaration carries the performer on the produced occurrence only", () => {
    const d = factOutcomeDeclaration({
      orgId: "o",
      runId: "r",
      leadId: "l",
      outcomeKey: "meeting_booked",
      consumedOutcomeKey: "conversation",
      performer: { kind: "crm" },
    });
    expect(d.produced).toEqual([{ outcomeKey: "meeting_booked", subjectService: "lead-service", subjectId: "l", performer: { kind: "crm" } }]);
    expect(d.consumed[0]).not.toHaveProperty("performer");
  });

  describe("LEDGER-DECLARE-1107: every Unit, whoever made it", () => {
    const row = (over: Record<string, unknown>) => ({
      orgId: "o", brandId: "b", leadId: "l1", leadIds: ["l1"], factId: "f", type: "signup", source: "clerk", payload: {}, at: null, occurredAt: "2026-08-01T00:00:00.000Z", ...over,
    });

    it("one Unit per lead per outcome, at the first reach: a lead paying twice is ONE paid client", () => {
      const firsts = firstCrmReaches([
        row({ factId: "s2", occurredAt: "2026-08-03T00:00:00.000Z" }),
        row({ factId: "s1", occurredAt: "2026-08-01T00:00:00.000Z" }),
        row({ factId: "p0", type: "payment", source: "stripe", payload: { status: "failed", amountMinor: 100 }, occurredAt: "2026-07-01T00:00:00.000Z" }),
        row({ factId: "p2", type: "payment", source: "stripe", payload: { status: "succeeded", amountMinor: 100 }, occurredAt: "2026-09-05T00:00:00.000Z" }),
        row({ factId: "p1", type: "payment", source: "stripe", payload: { status: "succeeded", amountMinor: 100 }, occurredAt: "2026-08-05T00:00:00.000Z" }),
        row({ factId: "x", leadId: "l2", leadIds: ["l2"], type: "payment", payload: { status: "succeeded", amountMinor: 100, amountRefunded: 100 } }),
      ]);
      expect(firsts.map((f) => [f.leadId, f.outcomeKey, f.crmFactId, f.ours, f.toolName])).toEqual([
        ["l1", "signup", "s1", false, "clerk"],
        ["l1", "paid_client", "p1", false, "stripe"],
      ]);
    });

    it("lead rows a fact names together are ONE person, transitively", () => {
      const person = personOfLeadRows([["c", "b"], ["b"], ["d", "c"], ["z"]]);
      expect(person("d")).toEqual(["b", "c", "d"]);
      expect(person("b")).toEqual(["b", "c", "d"]);
      expect(person("z")).toEqual(["z"]);
    });

    it("an undated reach comes after every dated one", () => {
      const firsts = firstCrmReaches([row({ factId: "u", occurredAt: null }), row({ factId: "d", occurredAt: "2026-08-09T00:00:00.000Z" })]);
      expect(firsts.map((f) => f.crmFactId)).toEqual(["d"]);
    });

    it("a CRM fact counts as the outcome the CRM sync records it as: never a session, never a form (a positive reply there)", () => {
      expect(Object.fromEntries(CRM_REACHED_OUTCOMES.map((o) => [o.outcomeKey, [...o.types].sort()]))).toEqual({
        signup: ["signup"],
        meeting_booked: ["meeting_booked"],
        meeting_attended: ["meeting_attended"],
        paid_client: ["payment", "sale"],
      });
    });

    it("a Unit another factory made consumes nothing and names its attester, never one of our scripts", () => {
      const d = factOutcomeDeclaration({ orgId: "o", runId: "r", leadId: "l", outcomeKey: "signup", consumedOutcomeKey: null, performer: performerOf(null, "crm", "clerk") });
      expect(d.consumed).toEqual([]);
      expect(d.produced).toEqual([{ outcomeKey: "signup", subjectService: "lead-service", subjectId: "l", performer: { kind: "crm", name: "clerk" } }]);
    });
  });
});
