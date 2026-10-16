/**
 * EVERY-OUTCOME-FIRES-1015: the pure rules of which outcome trigger a reach fires, when, for which offer, and the
 * idempotency key campaign-service dedupes on (src/lib/outcome-trigger-rules.ts).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OUTCOME_FRESH_WINDOW_MS,
  canonicalEmails,
  eventPerson,
  isFreshReach,
  outcomeIdempotencyKey,
  outcomeTriggerFor,
  parseOutcomeTriggers,
  personKeyOf,
  pickOffers,
  stepOfCrmFact,
  stepsOfLedgerRow,
  ledgerSourceRef,
  LEDGER_ANY_SOURCE_EVENTS,
  LEDGER_SOURCE_BOUND_STEPS,
} from "../../src/lib/outcome-trigger-rules.js";

/** The served catalogue's trigger list as features-service served it on 2026-10-15 (the fields read). */
const SERVED = {
  triggers: [
    { id: "on_demand", type: "condition", outcomeKey: null, firedBy: "campaign-service", coded: true },
    { id: "positive_reply_received", type: "outcome", outcomeKey: "conversation", firedBy: "instantly-service", coded: true },
    { id: "website_visited", type: "outcome", outcomeKey: "website_visit", firedBy: "lead-service", coded: false },
    { id: "booking_call_started", type: "outcome", outcomeKey: "booking_call", firedBy: "lead-service", coded: false },
    { id: "meeting_booked", type: "outcome", outcomeKey: "meeting_booked", firedBy: "lead-service", coded: false },
    { id: "meeting_attended", type: "outcome", outcomeKey: "meeting_attended", firedBy: "lead-service", coded: false },
    { id: "signed_up", type: "outcome", outcomeKey: "signup", firedBy: "lead-service", coded: false },
    { id: "form_submitted", type: "outcome", outcomeKey: "form_submitted", firedBy: "crm-service", coded: true },
    { id: "purchase_made", type: "outcome", outcomeKey: "purchase", firedBy: "lead-service", coded: false },
    { id: "lead_found", type: "outcome", outcomeKey: "lead_found", firedBy: "lead-service", coded: false },
    { id: "paid_client", type: "outcome", outcomeKey: "paid_client", firedBy: "crm-service", coded: false },
    { id: "signup_not_paid_30_min", type: "condition", outcomeKey: null, firedBy: "campaign-service", coded: true },
  ],
};

describe("parseOutcomeTriggers", () => {
  it("keeps only the outcome triggers, as served", () => {
    const triggers = parseOutcomeTriggers(SERVED);
    expect(triggers.map((t) => t.id)).not.toContain("on_demand");
    expect(triggers.map((t) => t.id)).not.toContain("signup_not_paid_30_min");
    expect(triggers.find((t) => t.outcomeKey === "meeting_booked")).toEqual({
      id: "meeting_booked",
      outcomeKey: "meeting_booked",
      firedBy: "lead-service",
      coded: false,
    });
  });

  it("throws on a body without a trigger list, or an outcome trigger it cannot read", () => {
    expect(() => parseOutcomeTriggers({})).toThrow(/triggers array/);
    expect(() => parseOutcomeTriggers({ triggers: [{ id: "x", type: "outcome", outcomeKey: "x", firedBy: "lead-service" }] })).toThrow(
      /unreadable/,
    );
  });
});

describe("outcomeTriggerFor: the trigger is the catalogue's, never a slug list here", () => {
  const triggers = parseOutcomeTriggers(SERVED);

  it("fires each outcome's own trigger, read by outcomeKey", () => {
    expect(outcomeTriggerFor("meeting_booked", triggers)).toEqual({ fire: true, triggerId: "meeting_booked" });
    expect(outcomeTriggerFor("lead_found", triggers)).toEqual({ fire: true, triggerId: "lead_found" });
    expect(outcomeTriggerFor("signup", triggers)).toEqual({ fire: true, triggerId: "signed_up" });
    expect(outcomeTriggerFor("website_visit", triggers)).toEqual({ fire: true, triggerId: "website_visited" });
    expect(outcomeTriggerFor("booking_call", triggers)).toEqual({ fire: true, triggerId: "booking_call_started" });
  });

  it("never fires an outcome another service fires today (Positive reply, Form submitted)", () => {
    expect(outcomeTriggerFor("conversation", triggers)).toMatchObject({ fire: false, reason: "fired_by_another_service", triggerId: "positive_reply_received" });
    expect(outcomeTriggerFor("form_submitted", triggers)).toMatchObject({ fire: false, reason: "fired_by_another_service", triggerId: "form_submitted" });
  });

  it("fires an outcome nothing fires yet even when the catalogue names another firer (Paid client)", () => {
    expect(outcomeTriggerFor("paid_client", triggers)).toEqual({ fire: true, triggerId: "paid_client" });
  });

  it("stops firing the moment the catalogue says another service fires it", () => {
    const moved = triggers.map((t) => (t.outcomeKey === "paid_client" ? { ...t, coded: true } : t));
    expect(outcomeTriggerFor("paid_client", moved)).toMatchObject({ fire: false, reason: "fired_by_another_service" });
  });

  it("an outcome with no outcome trigger fires nothing", () => {
    expect(outcomeTriggerFor("industry_update_video", triggers)).toMatchObject({ fire: false, reason: "no_outcome_trigger" });
  });
});

describe("what reaches a step: step-reached.ts's vocabulary", () => {
  it("maps the CRM fact types and ledger events to catalogue steps", () => {
    expect(stepOfCrmFact("meeting_booked")).toBe("meeting_booked");
    expect(stepOfCrmFact("payment")).toBe("paid_client");
    expect(stepOfCrmFact("sale")).toBe("paid_client");
    expect(stepOfCrmFact("website_visit")).toBe("website_visit");
    expect(stepOfCrmFact("message_in")).toBeNull();
    expect(stepsOfLedgerRow("form_submission", "tracker")).toEqual(["form_submitted"]);
    expect(stepsOfLedgerRow("sale", "manual")).toEqual(["paid_client"]);
    expect(stepsOfLedgerRow("purchase", "reply")).toEqual(["paid_client"]);
    expect(stepsOfLedgerRow("meeting_booked", "manual")).toEqual(["meeting_booked"]);
    // A positive reply is the delivery layer's (instantly-service fires it): never a reach here.
    expect(stepsOfLedgerRow("positive_reply", "crm")).toEqual([]);
  });

  it("a sale the brand's website tag reported is a Direct purchase AND a paid client, each read under its own record", () => {
    expect(stepsOfLedgerRow("sale", "tracker")).toEqual(["paid_client", "purchase"]);
    expect(stepsOfLedgerRow("purchase", "tracker")).toEqual(["paid_client", "purchase"]);
    expect(ledgerSourceRef("x", "paid_client")).toBe("ce:x");
    expect(ledgerSourceRef("x", "purchase")).toBe("ce:x:purchase");
    expect(LEDGER_ANY_SOURCE_EVENTS).toContain("sale");
    expect(LEDGER_SOURCE_BOUND_STEPS).toEqual([{ step: "purchase", events: ["sale", "purchase"], sources: ["tracker"] }]);
  });
});

describe("isFreshReach: from now on, no back-fill", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const armedAt = new Date("2026-10-15T10:00:00Z");

  it("fires a reach after the detector was armed", () => {
    expect(isFreshReach("2026-10-15T11:59:00Z", armedAt, now)).toBe(true);
  });

  it("never fires one before it was armed, an undated one, or one older than the window", () => {
    expect(isFreshReach("2026-10-15T09:59:00Z", armedAt, now)).toBe(false);
    expect(isFreshReach(null, armedAt, now)).toBe(false);
    const longArmed = new Date("2026-01-01T00:00:00Z");
    expect(isFreshReach(new Date(now.getTime() - OUTCOME_FRESH_WINDOW_MS - 1000), longArmed, now)).toBe(false);
    expect(isFreshReach(new Date(now.getTime() - OUTCOME_FRESH_WINDOW_MS + 1000), longArmed, now)).toBe(true);
  });
});

describe("pickOffers: the offer the event names", () => {
  it("the record's own offer first", () => {
    expect(pickOffers({ stated: "o1", leadCampaignOffers: ["o2"], activeBrandOffers: ["o3"] })).toEqual({ offerIds: ["o1"], basis: "stated" });
  });

  it("else every offer of the person's campaigns at the brand, once each", () => {
    expect(pickOffers({ stated: null, leadCampaignOffers: ["o2", null, "o1", "o2"], activeBrandOffers: null })).toEqual({
      offerIds: ["o1", "o2"],
      basis: "lead_campaigns",
    });
  });

  it("else the brand's only active offer, never a guess among several", () => {
    expect(pickOffers({ stated: null, leadCampaignOffers: [null], activeBrandOffers: ["o9"] })).toEqual({ offerIds: ["o9"], basis: "only_offer" });
    expect(pickOffers({ stated: null, leadCampaignOffers: [], activeBrandOffers: ["o8", "o9"] })).toMatchObject({ offerIds: [], reason: "offer_unknown" });
    expect(pickOffers({ stated: null, leadCampaignOffers: [], activeBrandOffers: [] })).toMatchObject({ offerIds: [], reason: "offer_unknown" });
  });
});

describe("the person and the idempotency key", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const brandId = "11111111-1111-4111-8111-111111111111";
  const offerId = "22222222-2222-4222-8222-222222222222";
  const leadId = "33333333-3333-4333-8333-333333333333";

  it("keys a lead by its id, anybody else by their address", () => {
    expect(personKeyOf(leadId, "a@x.com")).toBe(`lead:${leadId}`);
    expect(personKeyOf(null, "a@x.com")).toBe("email:a@x.com");
    expect(personKeyOf(null, null)).toBeNull();
  });

  it("names the outcome, brand, offer and person; never an address in clear; fits campaign-service's 200", () => {
    const lead = outcomeIdempotencyKey({ step: "meeting_booked", brandId, offerId, personKey: `lead:${leadId}`, hash });
    expect(lead).toBe(`lead-service:outcome:meeting_booked:${brandId}:${offerId}:lead:${leadId}`);
    const long = `email:${"x".repeat(240)}@example.com`;
    const byEmail = outcomeIdempotencyKey({ step: "meeting_attended", brandId, offerId, personKey: long, hash });
    expect(byEmail).not.toContain("example.com");
    expect(byEmail.length).toBeLessThanOrEqual(200);
    expect(outcomeIdempotencyKey({ step: "meeting_attended", brandId, offerId, personKey: long, hash })).toBe(byEmail);
  });

  it("states a person by address, else by E.164 phone alone, within the door's limits", () => {
    expect(eventPerson(null, "A", null)).toBeNull();
    // A national number names nobody (campaign-service files a phone-only person by E.164).
    expect(eventPerson(null, "A", "06 12 34 56 78")).toBeNull();
    expect(eventPerson(null, " Wa Writer ", "+33 6 12 34 56 78")).toEqual({ phone: "+33612345678", name: "Wa Writer" });
    expect(eventPerson("a@x.com", "  Ann  ", null)).toEqual({ email: "a@x.com", name: "Ann" });
    expect(eventPerson("a@x.com", "n".repeat(400), "1".repeat(80))).toEqual({ email: "a@x.com", name: "n".repeat(300), phone: "1".repeat(50) });
  });

  it("canonical addresses: trimmed, lowercased, deduped, order kept", () => {
    expect(canonicalEmails([" A@X.com", null, "b@y.com", "a@x.com", "not-an-address"])).toEqual(["a@x.com", "b@y.com"]);
  });
});
