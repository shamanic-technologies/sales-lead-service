/**
 * Every CRM source, not only GoHighLevel: a person who SIGNED UP (PostHog) or PAID (Stripe) is
 * evidence of our signup / sale step, mapped on crm-service's fact TYPE, never on the tool.
 */
import { describe, expect, it } from "vitest";
import { evidenceFromEvents, paidValueCents, paymentStands, CRM_EVIDENCED_STEPS } from "../../src/lib/crm-evidence.js";
import { CRM_FUNNEL_FACT_TYPES } from "../../src/lib/crm-fact-events.js";

const payment = (occurredAt: string, detail: Record<string, unknown>, sourceId = "py_1") => ({
  step: "payment",
  occurredAt,
  dateBasis: "created",
  source: null,
  sourceId,
  detail: { status: "succeeded", currency: "usd", refunded: false, amountMinor: 9900, amountRefunded: 0, ...detail },
});

describe("signup and payment facts", () => {
  it("are read off the fact copy and are steps a CRM can evidence", () => {
    expect(CRM_FUNNEL_FACT_TYPES).toEqual(expect.arrayContaining(["signup", "payment"]));
    expect(CRM_EVIDENCED_STEPS).toEqual(expect.arrayContaining(["signup", "sale"]));
  });

  it("a signup is the signup step, a payment that stands is the sale step (earliest wins)", () => {
    const out = evidenceFromEvents([
      { step: "signup", occurredAt: "2026-09-01T00:00:00Z", dateBasis: "person_created_at", source: null, sourceId: "p1", detail: {} },
      payment("2026-09-20T00:00:00Z", {}, "py_late"),
      payment("2026-09-10T00:00:00Z", {}, "py_early"),
    ]);
    const byKey = new Map(out.map((e) => [`${e.kind}:${e.step}`, e]));
    expect(byKey.get("outcome:signup")!.crmStep).toBe("signup");
    expect(byKey.get("outcome:sale")).toMatchObject({ crmStep: "payment", sourceId: "py_early" });
  });

  it("a failed or wholly refunded payment is not a paid client", () => {
    expect(paymentStands({ status: "failed", amountMinor: 1000 })).toBe(false);
    expect(paymentStands({ status: "succeeded", amountMinor: 1000, amountRefunded: 1000, refunded: true })).toBe(false);
    expect(paymentStands({ status: "succeeded", amountMinor: 1000, amountRefunded: 400 })).toBe(true);
    expect(paymentStands(null)).toBe(false);
    const out = evidenceFromEvents([
      payment("2026-09-10T00:00:00Z", { amountRefunded: 9900, refunded: true }, "py_refunded"),
      payment("2026-09-11T00:00:00Z", { status: "failed" }, "py_failed"),
    ]);
    expect(out).toEqual([]);
  });

  it("the value is what the person paid, net of refunds, in cents; mixed currencies are not added", () => {
    expect(
      paidValueCents([
        payment("2026-09-10T00:00:00Z", {}),
        payment("2026-09-11T00:00:00Z", { amountMinor: 5000, amountRefunded: 1000 }),
        payment("2026-09-12T00:00:00Z", { amountRefunded: 9900, refunded: true }),
      ]),
    ).toBe(9900 + 4000);
    expect(paidValueCents([payment("2026-09-10T00:00:00Z", { currency: "eur" })])).toBeNull();
    expect(paidValueCents([payment("2026-09-10T00:00:00Z", { status: "failed" })])).toBeNull();
    expect(paidValueCents([])).toBeNull();
  });
});
