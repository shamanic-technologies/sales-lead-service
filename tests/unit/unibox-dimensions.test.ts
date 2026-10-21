import { describe, expect, it } from "vitest";
import {
  contactabilityOf,
  customerStateFrom,
  conversationOf,
  fitOf,
  interestOf,
  lifecycleOf,
  rolesOf,
  statusOf,
  typesOf,
} from "../../src/lib/unibox-dimensions.js";

// UNIBOX-SIX-TAGS-1017: the six dimensions of a Unibox lead, each read off its owner. Pure rules.
const ladder = [
  { key: "lead_found", rank: 1, label: "Lead found" },
  { key: "contacted", rank: 2, label: "Contacted" },
  { key: "engaged", rank: 3, label: "Engaged" },
  { key: "signup_or_form", rank: 4, label: "Signed up" },
  { key: "paid_client", rank: 7, label: "Paid client" },
];
const ranks = new Map<string, number | null>([
  ["lead_found", 1],
  ["email_sent", 2],
  ["website_visit", 3],
  ["conversation", 3],
  ["signup", 4],
  ["paid_client", 7],
  ["purchase", 7],
  ["technical", null],
]);

describe("unibox dimensions", () => {
  it("Type: several at once, in the vocabulary's order; personal is no Type", () => {
    expect(typesOf(["customer", "personal", "partner", "team", "journalist", "other_professional", "prospect"])).toEqual([
      "prospect",
      "customer",
      "partner",
      "employee",
      "press",
      "other",
    ]);
  });

  it("Status is ONE value: paying today = customer (even after an earlier churn), stated end = churned, else prospect", () => {
    expect(statusOf({ customer: true, churned: true })).toBe("customer");
    expect(statusOf({ customer: false, churned: true })).toBe("churned");
    expect(statusOf({ customer: false, churned: false })).toBe("prospect");
  });

  it("Churned only when a source states the end, newer than any sign of being a customer", () => {
    // GHL: crm states former_client WITH client on the same date = churned; a later client entry = customer again.
    expect(customerStateFrom([{ kind: "client", at: "2026-09-01T00:00:00Z" }, { kind: "former_client", at: "2026-09-01T00:00:00Z" }])).toEqual({ churned: true, customerSign: false });
    expect(
      customerStateFrom([
        { kind: "client", at: "2026-09-01T00:00:00Z" },
        { kind: "former_client", at: "2026-09-01T00:00:00Z" },
        { kind: "client", at: "2026-10-01T00:00:00Z" },
      ]),
    ).toEqual({ churned: false, customerSign: true });
    // A live undated former tag = now; a payment after it cannot be newer than now, a running subscription ties = customer.
    expect(customerStateFrom([{ kind: "former_client", at: null }, { kind: "paid", at: "2026-10-01T00:00:00Z" }]).churned).toBe(true);
    // Stripe: a subscription speaks by its LATEST status.
    const sub = (status: string, at: string) => ({ kind: "subscription" as const, at, subscriptionId: "sub_1", status });
    expect(customerStateFrom([sub("active", "2026-08-01T00:00:00Z"), sub("canceled", "2026-09-01T00:00:00Z")]).churned).toBe(true);
    expect(customerStateFrom([sub("canceled", "2026-09-01T00:00:00Z"), { kind: "paid", at: "2026-10-01T00:00:00Z" }])).toEqual({ churned: false, customerSign: true });
    expect(customerStateFrom([sub("active", "2026-08-01T00:00:00Z")])).toEqual({ churned: false, customerSign: true });
    // Nothing stated = never a guess.
    expect(customerStateFrom([])).toEqual({ churned: false, customerSign: false });
    expect(customerStateFrom([{ kind: "paid", at: "2025-01-01T00:00:00Z" }]).churned).toBe(false);
  });

  it("Roles stack beside the status; prospect and customer are never roles", () => {
    expect(rolesOf(["customer", "investor", "prospect", "team", "journalist"])).toEqual(["investor", "employee", "press"]);
  });

  it("Lifecycle: the highest rung over every step reached, whatever the funnel; unknown or unranked steps do not count", () => {
    expect(lifecycleOf(["lead_found", "website_visit", "signup", "email_sent"], ranks, ladder)).toEqual(ladder[3]);
    expect(lifecycleOf(["technical", "never_heard_of"], ranks, ladder)).toBeNull();
    expect(lifecycleOf(["paid_client", "lead_found"], ranks, ladder)?.key).toBe("paid_client");
  });

  it("Interest reads the wants-business answer", () => {
    expect([interestOf("yes"), interestOf("no"), interestOf("unsure"), interestOf(null)]).toEqual(["interested", "not_interested", "unsure", "not_asked"]);
  });

  it("Contactability: a person's own stop first, then unsubscribe, then bounce", () => {
    expect(contactabilityOf({ doNotContact: false, optedOut: true, unsubscribed: true, bounced: true })).toBe("do_not_contact");
    expect(contactabilityOf({ doNotContact: false, optedOut: false, unsubscribed: true, bounced: true })).toBe("unsubscribed");
    expect(contactabilityOf({ doNotContact: false, optedOut: false, unsubscribed: false, bounced: true })).toBe("bounced");
    expect(contactabilityOf({ doNotContact: false, optedOut: false, unsubscribed: false, bounced: false })).toBe("contactable");
  });

  it("Conversation status: closed when we may not write or they said no; else whose word is newest", () => {
    const base = { contactability: "contactable" as const, interest: "unsure" as const };
    expect(conversationOf({ ...base, lastTheirsAt: null, lastOursAt: "2026-10-01T00:00:00Z" })).toBe("no_reply_yet");
    expect(conversationOf({ ...base, lastTheirsAt: "2026-10-02T00:00:00Z", lastOursAt: "2026-10-01T00:00:00Z" })).toBe("waiting_on_us");
    expect(conversationOf({ ...base, lastTheirsAt: "2026-10-02T00:00:00Z", lastOursAt: null })).toBe("waiting_on_us");
    expect(conversationOf({ ...base, lastTheirsAt: "2026-10-01T00:00:00Z", lastOursAt: "2026-10-02T00:00:00Z" })).toBe("waiting_on_them");
    expect(conversationOf({ ...base, interest: "not_interested", lastTheirsAt: "2026-10-02T00:00:00Z", lastOursAt: null })).toBe("closed");
    expect(conversationOf({ ...base, contactability: "bounced", lastTheirsAt: null, lastOursAt: null })).toBe("closed");
  });

  it("Fit: the lead's own mark before the company's", () => {
    expect(fitOf({ lead: true, company: true })).toBe("wrong_person");
    expect(fitOf({ lead: false, company: true })).toBe("not_our_target");
    expect(fitOf({ lead: false, company: false })).toBe("fit");
  });
});
