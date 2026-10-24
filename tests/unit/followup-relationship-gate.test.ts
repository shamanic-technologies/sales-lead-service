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

describe("decideClientGate (current_client)", async () => {
  const { decideClientGate } = await import("../../src/lib/followup-client-gate.js");
  const facts = (over: Partial<Parameters<typeof decideClientGate>[0]> = {}) => ({
    block: block({}),
    emails: ["ana@client.test"],
    paid: true,
    memberKeys: new Set<string>(),
    ...over,
  });

  it("a paying professional is admitted", () => {
    expect(decideClientGate(facts())).toEqual({ kind: "admit" });
  });
  it("no sale = not_a_client", () => {
    expect(decideClientGate(facts({ paid: false }))).toMatchObject({ kind: "refuse", reason: "not_a_client" });
  });
  it("staff and test users are refused even with a sale", () => {
    expect(decideClientGate(facts({ emails: ["Kevin.Lourd@gmail.com"] }))).toMatchObject({ kind: "refuse", reason: "staff" });
    expect(decideClientGate(facts({ emails: ["kevin@pressbeat.io"] }))).toMatchObject({ kind: "refuse", reason: "staff" });
  });
  it("an org member or a team tag (yes or unsure) is refused even with a sale", () => {
    expect(decideClientGate(facts({ emails: ["bob+x@org.test"], memberKeys: new Set(["bob@org.test"]) }))).toMatchObject({ reason: "team_member" });
    expect(decideClientGate(facts({ block: block({ unsureTags: ["team"] }) }))).toEqual({ kind: "refuse", reason: "team_member", tags: [], unsureTags: ["team"] });
  });
  it("a personal contact (yes or unsure) is refused", () => {
    expect(decideClientGate(facts({ block: block({ tags: ["personal", "customer"] }) }))).toEqual({ kind: "refuse", reason: "personal", tags: ["personal"], unsureTags: [] });
    expect(decideClientGate(facts({ block: block({ unsureTags: ["personal"] }) }))).toMatchObject({ reason: "personal" });
  });
  it("a payer with no human yet is pending, never a client", () => {
    expect(decideClientGate(facts({ block: EMPTY_RELATIONSHIP }))).toEqual({ kind: "pending", reason: "human_unknown" });
  });
});
