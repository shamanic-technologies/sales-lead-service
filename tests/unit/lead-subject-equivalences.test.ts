import { describe, expect, it } from "vitest";
import { planEquivalences, type IdentityEdge, type LivingLead, type StatedRow } from "../../src/lib/lead-subject-equivalences.js";

const living = (entries: Array<[string, string]>) => new Map<string, LivingLead>(entries.map(([id, at]) => [id, { createdAt: at }]));

describe("planEquivalences (LEDGER-RESIDUAL-1025)", () => {
  it("states every lead of a group onto its OLDEST living lead, once", () => {
    const edges: IdentityEdge[] = [
      { fromLeadId: "x", toLeadId: "y", basis: "served_row_repaired" },
      { fromLeadId: "y", toLeadId: "x", basis: "recorded_duplicate" },
      { fromLeadId: "z", toLeadId: "y", basis: "social_fold" },
    ];
    const plan = planEquivalences(edges, living([["x", "2026-02-25 03:34:37+00"], ["y", "2026-06-06 01:03:36+00"]]), new Map());
    expect(plan.groups).toBe(1);
    expect(plan.items).toEqual([
      { leadId: "y", targetLeadId: "x", bases: ["recorded_duplicate", "served_row_repaired", "social_fold"] },
      { leadId: "z", targetLeadId: "x", bases: ["social_fold"] },
    ]);
  });

  it("a replay states nothing new", () => {
    const edges: IdentityEdge[] = [{ fromLeadId: "y", toLeadId: "x", basis: "recorded_duplicate" }];
    const stated = new Map<string, StatedRow>([["y", { targetLeadId: "x", status: "stated" }]]);
    const plan = planEquivalences(edges, living([["x", "1"], ["y", "2"]]), stated);
    expect(plan.items).toEqual([]);
    expect(plan.alreadyStated).toBe(1);
  });

  it("a group already holding a stated target keeps it, even when an older lead joins (immutable, one hop)", () => {
    const edges: IdentityEdge[] = [
      { fromLeadId: "y", toLeadId: "x", basis: "recorded_duplicate" },
      { fromLeadId: "w", toLeadId: "x", basis: "recorded_duplicate" },
    ];
    const stated = new Map<string, StatedRow>([["y", { targetLeadId: "x", status: "stated" }]]);
    const plan = planEquivalences(edges, living([["w", "0"], ["x", "1"], ["y", "2"]]), stated);
    expect(plan.items).toEqual([{ leadId: "w", targetLeadId: "x", bases: ["recorded_duplicate"] }]);
  });

  it("a deleted lead is stated onto the living one; a group with no living lead or two stated targets is skipped, never guessed", () => {
    const plan = planEquivalences(
      [
        { fromLeadId: "gone", toLeadId: "alive", basis: "social_fold" },
        { fromLeadId: "g1", toLeadId: "g2", basis: "served_row_repaired" },
        { fromLeadId: "a", toLeadId: "b", basis: "recorded_duplicate" },
      ],
      living([["alive", "1"], ["a", "1"], ["b", "2"]]),
      new Map<string, StatedRow>([
        ["p", { targetLeadId: "a", status: "stated" }],
        ["q", { targetLeadId: "b", status: "stated" }],
      ]),
    );
    expect(plan.items).toEqual([{ leadId: "gone", targetLeadId: "alive", bases: ["social_fold"] }]);
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(["no_living_lead", "several_stated_targets"]);
  });

  it("a refused statement is not sent again", () => {
    const plan = planEquivalences(
      [{ fromLeadId: "y", toLeadId: "x", basis: "recorded_duplicate" }],
      living([["x", "1"], ["y", "2"]]),
      new Map<string, StatedRow>([["y", { targetLeadId: "x", status: "refused" }]]),
    );
    expect(plan.items).toEqual([]);
  });
});
