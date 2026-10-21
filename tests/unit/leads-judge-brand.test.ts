/**
 * LEADS-JUDGE-BRAND-1021: who becomes and stays a brand's lead, and what counts as an action of theirs.
 *  - the relationship judge always reads the brand with each of its offers (name + what it offers);
 *  - a lead whose verdict flips (the judge, or crm-service on their conversations) is no longer a lead;
 *  - an automatic answer is judged (never a rule on words), and "a person wrote it" is what counts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));

const { brandCardHash, judgmentState, whatWeOfferOf, TAG_QUESTIONS } = await import("../../src/lib/relationship-judge.js");
const { notBrandLeadOf, pureProspectAllows } = await import("../../src/lib/relationship-tags.js");
const { decideProspectFollowup } = await import("../../src/lib/prospect-followup.js");
const { decideClaimGate } = await import("../../src/lib/followup-relationship-gate.js");
const { EMPTY_RELATIONSHIP } = await import("../../src/lib/relationship-read.js");
const { AUTOMATED_QUESTION, automatedState } = await import("../../src/lib/their-acts.js");

const CARD = {
  name: "Distribute",
  domain: "distribute.you",
  offers: [
    { name: "Product-led", whatWeOffer: "Autonomous multi-channel acquisition" },
    { name: "Sales Meetings", whatWeOffer: "Autonomous Sales Meetings Acquisition" },
  ],
};

describe("the judge reads the brand with its offers", () => {
  it("the state carries the brand and every offer's name + what it offers", () => {
    const state = judgmentState({ name: "Regina", emails: ["regina@example.com"], phones: [], channels: ["gmail"] }, CARD, null, []);
    expect(state.brand).toEqual(CARD);
    expect(state.brand.offers.map((o) => [o.name, o.whatWeOffer])).toEqual([
      ["Product-led", "Autonomous multi-channel acquisition"],
      ["Sales Meetings", "Autonomous Sales Meetings Acquisition"],
    ]);
    expect(state.context).toContain("brand.offers");
    expect(TAG_QUESTIONS.prospect.instructions).toContain("brand.offers");
  });

  it("what an offer offers = its stated Service sold, else its own text, never its Q&A", () => {
    expect(whatWeOfferOf({ description: null, fields: { services: ["Autonomous Sales Meetings Acquisition"] } })).toBe("Autonomous Sales Meetings Acquisition");
    expect(whatWeOfferOf({ description: "Dinner events for chiropractors", fields: {} })).toBe("Dinner events for chiropractors");
    expect(whatWeOfferOf({ description: null, fields: { dreamOutcome: ["More patients"] } })).toBeNull();
  });

  it("the card's fingerprint moves with any offer and ignores order", () => {
    const h = brandCardHash(CARD);
    expect(brandCardHash({ ...CARD, offers: [...CARD.offers].reverse() })).toBe(h);
    expect(brandCardHash({ ...CARD, offers: [...CARD.offers, { name: "New", whatWeOffer: null }] })).not.toBe(h);
    expect(brandCardHash({ ...CARD, offers: [{ ...CARD.offers[0], whatWeOffer: "x" }, CARD.offers[1]] })).not.toBe(h);
  });
});

describe("a lead whose verdict flips is no longer a lead", () => {
  const base = { subject: true, leadState: "yes" as const, connectionTags: ["professional_to_brand"] };

  it("the judge says no prospect, no customer = not the brand's lead", () => {
    expect(notBrandLeadOf(base)).toBeNull();
    expect(notBrandLeadOf({ ...base, leadState: "no" })).toBe("judged_not_a_lead");
  });

  it("crm-service reads their conversations as professional NOT to the brand = not the brand's lead", () => {
    expect(notBrandLeadOf({ subject: false, leadState: null, connectionTags: ["professional_not_to_brand"] })).toBe("crm_not_to_brand");
    // A person nobody judged and crm-service does not know (only our outreach found them) stays a lead.
    expect(notBrandLeadOf({ subject: false, leadState: null, connectionTags: [] })).toBeNull();
  });

  it("not the brand's lead = no pure prospect, a stop for the follow-up, a refusal for the claim", () => {
    expect(pureProspectAllows({ subject: false, hasDirect: false, tags: [], unsureTags: [], judgedAt: null })).toBe(true);
    expect(pureProspectAllows({ subject: false, hasDirect: false, tags: [], unsureTags: [], judgedAt: null, notBrandLead: "crm_not_to_brand" })).toBe(false);
    const relationship = { ...EMPTY_RELATIONSHIP, humanId: "h1", notBrandLead: "judged_not_a_lead" as const, judgedAt: "2026-10-21T00:00:00Z", subject: true };
    const v = decideProspectFollowup({
      labels: new Set(["initial_email"]),
      outcomes: new Set(),
      human: null,
      disqualified: false,
      sender: { queued: false, unsubscribed: false, bounced: false },
      relationship,
      waitingOnAnswer: false,
    });
    expect(v).toMatchObject({ owed: false, kind: "stop", reason: "not_brand_lead" });
    expect(decideClaimGate(relationship, true)).toMatchObject({ kind: "refuse", reason: "not_a_lead" });
  });
});

describe("an automatic answer is judged, never matched on words", () => {
  it("Jev reads the message itself and is asked whether a machine sent it", () => {
    const state = automatedState({ subject: "Automatic reply: [EXTERNAL] workforce transition", text: "I am out of the office today.", channel: "email", source: "gmail" });
    expect(state.message).toEqual({ channel: "email", subject: "Automatic reply: [EXTERNAL] workforce transition", text: "I am out of the office today." });
    expect(AUTOMATED_QUESTION.instructions).toMatch(/out-of-office/);
  });
});
