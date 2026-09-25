import { describe, expect, it } from "vitest";
import {
  needsFirstDelivery,
  outcomeCauseRule,
  ruleIsSettled,
} from "../../src/lib/outcome-cause.js";

const LEAD = "11111111-1111-1111-1111-111111111111";
const DELIVERED = "2026-05-10T00:00:00.000Z";

describe("outcomeCauseRule — the owner's whose-win rule, for any source", () => {
  it("answers ours when the outcome happened after our first delivered email", () => {
    const r = outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-05-20T00:00:00.000Z" }, DELIVERED);
    expect(r).toMatchObject({ causedByOutreach: true, reason: "after_first_delivery", leadId: LEAD });
  });

  it("answers not ours when it happened before, or at the same instant", () => {
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-05-01T00:00:00.000Z" }, DELIVERED)
      .causedByOutreach).toBe(false);
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: DELIVERED }, DELIVERED).causedByOutreach).toBe(false);
  });

  it("never defaults to ours: unmatched, undated and never-delivered stay undecided", () => {
    expect(outcomeCauseRule({ leadId: null, occurredAt: "2026-05-20T00:00:00.000Z" }, DELIVERED))
      .toMatchObject({ causedByOutreach: null, reason: "not_matched", firstDeliveredAt: null });
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: null }, DELIVERED))
      .toMatchObject({ causedByOutreach: null, reason: "event_undated" });
    expect(outcomeCauseRule({ leadId: LEAD, occurredAt: "2026-05-20T00:00:00.000Z" }, null))
      .toMatchObject({ causedByOutreach: null, reason: "never_delivered" });
  });

  it("asks for a first delivery only for an attributed, dated outcome", () => {
    expect(needsFirstDelivery({ leadId: LEAD, occurredAt: "2026-05-20T00:00:00.000Z" })).toBe(true);
    expect(needsFirstDelivery({ leadId: null, occurredAt: "2026-05-20T00:00:00.000Z" })).toBe(false);
    expect(needsFirstDelivery({ leadId: LEAD, occurredAt: null })).toBe(false);
  });
});

describe("ruleIsSettled", () => {
  const at = "2026-05-20T00:00:00.000Z";
  const settled = outcomeCauseRule({ leadId: LEAD, occurredAt: at }, DELIVERED);

  it("keeps a final answer whose inputs did not move", () => {
    expect(ruleIsSettled({ id: "x", leadId: LEAD, occurredAt: at, causedByOutreach: true, causeRule: settled })).toBe(true);
  });

  it("re-evaluates an answer that can still move, or whose inputs moved", () => {
    const never = outcomeCauseRule({ leadId: LEAD, occurredAt: at }, null);
    expect(ruleIsSettled({ id: "x", leadId: LEAD, occurredAt: at, causedByOutreach: null, causeRule: never })).toBe(false);
    expect(ruleIsSettled({ id: "x", leadId: LEAD, occurredAt: "2026-06-01T00:00:00.000Z", causedByOutreach: true, causeRule: settled })).toBe(false);
    expect(ruleIsSettled({ id: "x", leadId: null, occurredAt: at, causedByOutreach: true, causeRule: settled })).toBe(false);
    expect(ruleIsSettled({ id: "x", leadId: LEAD, occurredAt: at, causedByOutreach: null, causeRule: settled })).toBe(false);
    expect(ruleIsSettled({ id: "x", leadId: LEAD, occurredAt: at, causedByOutreach: null, causeRule: null })).toBe(false);
  });
});
