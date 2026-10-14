import { describe, expect, it } from "vitest";
import { outcomesCreditedAfterReach } from "../../src/lib/campaign-outcome-credit.js";
import type { LeadOutcomes } from "../../src/lib/lead-index.js";

function held(stepAt: Record<string, string | null>, positiveReplyAt?: string | null): LeadOutcomes {
  const o: LeadOutcomes = {
    steps: new Set(Object.keys(stepAt) as never[]),
    latestAt: null,
    stepAt: new Map(Object.entries(stepAt)) as LeadOutcomes["stepAt"],
  };
  if (positiveReplyAt !== undefined) {
    o.positiveReply = true;
    o.positiveReplyAt = positiveReplyAt;
  }
  return o;
}

describe("outcomesCreditedAfterReach (VALUED-ATTRIBUTION-1014)", () => {
  it("drops a signup and a sale the person made before the campaign's first message (Valued)", () => {
    const out = outcomesCreditedAfterReach(
      held({ signup: "2026-06-24T03:23:00.000Z", sale: "2026-06-24T03:30:00.000Z" }),
      "2026-10-12T14:42:17.562Z",
    );
    expect([...out.steps]).toEqual([]);
    expect(out.latestAt).toBeNull();
  });

  it("keeps an outcome dated strictly after the first send, and dates activity by it", () => {
    const out = outcomesCreditedAfterReach(
      held({ signup: "2026-10-01T00:00:00.000Z", sale: "2026-10-20T00:00:00.000Z" }),
      "2026-10-12T00:00:00Z",
    );
    expect([...out.steps]).toEqual(["sale"]);
    expect(out.latestAt).toBe("2026-10-20T00:00:00.000Z");
  });

  it("credits nothing at the same instant as the send, nothing undated, nothing to a person never sent", () => {
    expect([...outcomesCreditedAfterReach(held({ sale: "2026-10-12T00:00:00.000Z" }), "2026-10-12T00:00:00.000Z").steps]).toEqual([]);
    expect([...outcomesCreditedAfterReach(held({ sale: null }), "2026-10-12T00:00:00.000Z").steps]).toEqual([]);
    expect([...outcomesCreditedAfterReach(held({ sale: "2026-10-20T00:00:00.000Z" }), null).steps]).toEqual([]);
  });

  it("applies the same rule to a ledger positive reply", () => {
    expect(outcomesCreditedAfterReach(held({}, "2026-10-01T00:00:00.000Z"), "2026-10-12T00:00:00Z").positiveReply).toBeUndefined();
    expect(outcomesCreditedAfterReach(held({}, "2026-10-13T00:00:00.000Z"), "2026-10-12T00:00:00Z").positiveReply).toBe(true);
  });
});
