import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));

const { decideClaimGate } = await import("../../src/lib/followup-relationship-gate.js");
const { EMPTY_RELATIONSHIP } = await import("../../src/lib/relationship-read.js");

const block = (over: Partial<typeof EMPTY_RELATIONSHIP>) => ({ ...EMPTY_RELATIONSHIP, humanId: "h-1", ...over });

describe("decideClaimGate (pure_prospect)", () => {
  it("no human yet = pending, never a lead", () => {
    expect(decideClaimGate(EMPTY_RELATIONSHIP, false)).toMatchObject({ kind: "pending", reason: "human_unknown" });
  });

  it("a non-subject nobody of the org knows = admitted", () => {
    expect(decideClaimGate(block({ policies: { business_only: false, pure_prospect: true } }), false)).toEqual({ kind: "admit" });
  });

  it("a non-subject the CRM copy knows = pending until the sweep builds them", () => {
    expect(decideClaimGate(block({ policies: { business_only: false, pure_prospect: true } }), true)).toMatchObject({
      kind: "pending",
      reason: "relationship_not_built",
    });
  });

  it("any tag but prospect, yes or unsure, refuses whatever else is unknown", () => {
    expect(decideClaimGate(block({ subject: true, tags: ["prospect", "customer"], unsureTags: ["team"] }), true)).toEqual({
      kind: "refuse",
      reason: "not_a_lead",
      tags: ["customer"],
      unsureTags: ["team"],
    });
  });

  it("a subject never judged asks for a judgment", () => {
    expect(decideClaimGate(block({ subject: true, judgedAt: null }), false)).toEqual({ kind: "judge" });
  });

  it("a judged subject with no excluded tag held back by the policy = an open same-person question", () => {
    expect(decideClaimGate(block({ subject: true, judgedAt: "2026-10-15T00:00:00Z" }), false)).toMatchObject({
      kind: "pending",
      reason: "same_person_question_open",
    });
  });
});
