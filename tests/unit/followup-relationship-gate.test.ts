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

  it("a judged subject with no excluded tag on any relation, held back by the policy, stays pending (logged loud)", () => {
    expect(decideClaimGate(block({ subject: true, judgedAt: "2026-10-15T00:00:00Z" }), false)).toMatchObject({
      kind: "pending",
      reason: "same_person_question_open",
    });
  });

  // DOCDINNERS-RELATIONSHIP-PENDING-1028: dev@ at a client writes from their work address (relation at the company,
  // judged prospect unsure) and is a customer on their gmail relation; the per-human block shows the work relation's
  // tags and the AND-ed policy false. Before: pending forever, the occurrence dropped after 6 redeliveries.
  it("a customer on ANY relation refuses final, even when the latest-active relation shows no excluded tag", () => {
    const judged = "2026-10-27T17:18:54Z";
    const work = block({ subject: true, judgedAt: judged, unsureTags: ["prospect"], policies: { business_only: true, pure_prospect: true } });
    const gmail = block({ subject: true, judgedAt: judged, tags: ["customer"], unsureTags: ["prospect"], policies: { business_only: true, pure_prospect: false } });
    const perHuman = { ...work, policies: { business_only: true, pure_prospect: false } };
    expect(decideClaimGate(perHuman, false, [work, gmail])).toEqual({ kind: "refuse", reason: "not_a_lead", tags: ["customer"], unsureTags: [] });
  });

  it("a sure tag on one relation and the same tag unsure on another is listed once, as sure", () => {
    const a = block({ subject: true, judgedAt: "x", tags: ["customer"] });
    const b = block({ subject: true, judgedAt: "x", unsureTags: ["customer", "partner"] });
    expect(decideClaimGate({ ...a, policies: { business_only: false, pure_prospect: false } }, false, [a, b])).toEqual({
      kind: "refuse",
      reason: "not_a_lead",
      tags: ["customer"],
      unsureTags: ["partner"],
    });
  });

  it("an unjudged OTHER relation asks for a judgment, never an open question", () => {
    const latest = block({ subject: true, judgedAt: "2026-10-27T00:00:00Z" });
    const other = block({ subject: true, judgedAt: null });
    expect(decideClaimGate(latest, false, [latest, other])).toEqual({ kind: "judge" });
  });

  it("a not-the-brand's-lead verdict on another relation refuses", () => {
    const latest = block({ subject: true, judgedAt: "x" });
    const other = block({ subject: true, judgedAt: "x", notBrandLead: "judged_not_a_lead" });
    expect(decideClaimGate(latest, false, [latest, other])).toMatchObject({ kind: "refuse", reason: "not_a_lead" });
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

describe("decideNeverALead (pure_prospect, LEAD-EVENT-LEADS-ONLY-1024)", async () => {
  const { decideNeverALead, decideClientGate } = await import("../../src/lib/followup-client-gate.js");
  const f = (over: Partial<Parameters<typeof decideNeverALead>[0]> = {}) => ({ emails: ["ana@lead.test"], paid: false, memberKeys: new Set<string>(), ...over });

  it("a never-paid outsider goes on to the relationship gate", () => {
    expect(decideNeverALead(f())).toBeNull();
  });
  it("staff and test users are refused staff", () => {
    expect(decideNeverALead(f({ emails: ["kevin.lourd+probe@gmail.com"] }))).toMatchObject({ reason: "staff" });
    expect(decideNeverALead(f({ emails: ["x@distribute.you"] }))).toMatchObject({ reason: "staff" });
  });
  it("an org member is refused team_member", () => {
    expect(decideNeverALead(f({ emails: ["bob+x@org.test"], memberKeys: new Set(["bob@org.test"]) }))).toMatchObject({ reason: "team_member" });
  });
  it("a payer is refused not_a_lead as a customer", () => {
    expect(decideNeverALead(f({ paid: true }))).toEqual({ kind: "refuse", reason: "not_a_lead", tags: ["customer"], unsureTags: [] });
  });
  it("never both: whoever current_client admits, pure_prospect refuses", () => {
    for (const paid of [true, false]) {
      for (const emails of [["ana@lead.test"], ["kevin@pressbeat.io"]]) {
        const client = decideClientGate({ block: block({}), emails, paid, memberKeys: new Set() });
        const never = decideNeverALead({ emails, paid, memberKeys: new Set() });
        if (client.kind === "admit") expect(never?.kind).toBe("refuse");
        if (never === null) expect(client.kind).not.toBe("admit");
      }
    }
  });
});

describe("decideTeamGate (own_team, ONE-AI-CONVERSES-1029)", async () => {
  const { decideTeamGate, decideClientGate, decideNeverALead } = await import("../../src/lib/followup-client-gate.js");
  const f = (over: Partial<Parameters<typeof decideTeamGate>[0]> = {}) => ({ block: block({}), emails: ["ana@lead.test"], memberKeys: new Set<string>(), ...over });

  it("staff and test users are admitted (our own staff test on any brand's line)", () => {
    expect(decideTeamGate(f({ emails: ["kevin.lourd+probe@gmail.com"] }))).toEqual({ kind: "admit" });
    expect(decideTeamGate(f({ emails: ["x@distribute.you"] }))).toEqual({ kind: "admit" });
  });
  it("an org member or a team tag (yes or unsure) is admitted, even with no human yet", () => {
    expect(decideTeamGate(f({ emails: ["bob+x@org.test"], memberKeys: new Set(["bob@org.test"]) }))).toEqual({ kind: "admit" });
    expect(decideTeamGate(f({ block: block({ tags: ["team"] }) }))).toEqual({ kind: "admit" });
    expect(decideTeamGate(f({ block: block({ unsureTags: ["team"] }) }))).toEqual({ kind: "admit" });
    expect(decideTeamGate(f({ block: EMPTY_RELATIONSHIP, emails: ["x@distribute.you"] }))).toEqual({ kind: "admit" });
  });
  it("a lead, a client or a personal contact is refused not_team", () => {
    expect(decideTeamGate(f())).toEqual({ kind: "refuse", reason: "not_team", tags: [], unsureTags: [] });
    expect(decideTeamGate(f({ block: block({ tags: ["customer"] }) }))).toMatchObject({ reason: "not_team" });
    expect(decideTeamGate(f({ block: block({ tags: ["personal"] }) }))).toMatchObject({ reason: "not_team" });
  });
  it("never two audiences: whoever own_team admits, current_client and the never-a-lead check refuse", () => {
    const cases = [
      { block: block({}), emails: ["kevin@pressbeat.io"], members: new Set<string>() },
      { block: block({}), emails: ["bob@org.test"], members: new Set(["bob@org.test"]) },
      { block: block({ unsureTags: ["team"] }), emails: ["ana@lead.test"], members: new Set<string>() },
    ];
    for (const c of cases) {
      expect(decideTeamGate({ block: c.block, emails: c.emails, memberKeys: c.members }).kind).toBe("admit");
      for (const paid of [true, false]) {
        expect(decideClientGate({ block: c.block, emails: c.emails, paid, memberKeys: c.members }).kind).toBe("refuse");
      }
    }
    // The never-a-lead check refuses staff and members outright; a team tag is refused by the relationship gate (not_a_lead).
    expect(decideNeverALead({ emails: ["kevin@pressbeat.io"], paid: false, memberKeys: new Set() })?.kind).toBe("refuse");
    expect(decideNeverALead({ emails: ["bob@org.test"], paid: false, memberKeys: new Set(["bob@org.test"]) })?.kind).toBe("refuse");
  });
});
