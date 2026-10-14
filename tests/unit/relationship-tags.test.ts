import { describe, expect, it } from "vitest";
import { decideTags, judgedState, policyAllows, tagsIn, type RelationshipTag } from "../../src/lib/relationship-tags.js";
import { candidatesFor, nameTokens, pairScore, skeleton, unlinkedCandidatesFor } from "../../src/lib/relationship-names.js";
import { bestName } from "../../src/lib/relationship-subjects.js";
import { companyOfEnrich } from "../../src/lib/relationship-company.js";

const at = "2026-10-14T00:00:00.000Z";

describe("decideTags", () => {
  it("a person's word outranks evidence and judgment; evidence outranks judgment", () => {
    const d = decideTags({
      statements: new Map<RelationshipTag, { state: "yes" | "no"; at: string }>([["customer", { state: "no", at }]]),
      evidence: new Map([
        ["customer", { evidence: "payment", at }],
        ["prospect", { evidence: "signup", at }],
      ]),
      judgment: { probabilities: { prospect: 0.1, personal: 0.9, investor: 0.5, team: 0.1 }, at },
    });
    const by = new Map(d.map((x) => [x.tag, x]));
    expect(by.get("customer")).toMatchObject({ state: "no", basis: "person" });
    expect(by.get("prospect")).toMatchObject({ state: "yes", basis: "evidence", evidence: "signup" });
    expect(by.get("personal")).toMatchObject({ state: "yes", basis: "judgment", level: "human", confidence: 0.9 });
    expect(by.get("investor")?.state).toBe("unsure");
    expect(by.get("team")?.state).toBe("no");
    expect(tagsIn(d, "yes").sort()).toEqual(["personal", "prospect"]);
  });

  it("thresholds", () => {
    expect(judgedState(0.75)).toBe("yes");
    expect(judgedState(0.35)).toBe("no");
    expect(judgedState(0.5)).toBe("unsure");
  });
});

describe("policyAllows business_only", () => {
  const base = { tags: [] as RelationshipTag[], unsureTags: [] as RelationshipTag[], judgedAt: at };
  it("never judged = held back (never assume a stranger)", () => {
    expect(policyAllows("business_only", { ...base, judgedAt: null })).toBe(false);
  });
  it("personal yes or unsure = held back; customer + prospect pass", () => {
    expect(policyAllows("business_only", { ...base, tags: ["personal", "customer"] })).toBe(false);
    expect(policyAllows("business_only", { ...base, unsureTags: ["advisor"] })).toBe(false);
    expect(policyAllows("business_only", { ...base, tags: ["customer", "prospect"] })).toBe(true);
    expect(policyAllows("business_only", { ...base, tags: ["other_professional"] })).toBe(true);
  });
  it("an unanswered same-person question holds them back", () => {
    expect(policyAllows("business_only", { ...base, tags: ["customer"], openMerge: true })).toBe(false);
  });
});

describe("merge blocking across spellings and alphabets", () => {
  it("Yulia (WA) is a candidate for Yuliia Siletska (lusenko.julija@gmail.com)", () => {
    expect(nameTokens("Yulia (WA)")).toEqual(["yulia"]);
    expect(skeleton("yulia")).toBe(skeleton("yuliia"));
    expect(skeleton("julija")).toBe(skeleton("yulia"));
    expect(nameTokens("Юля")).toEqual(["yulya"]);
    expect(pairScore({ humanId: "u", name: "Yulia (WA)", emails: [] }, { humanId: "k", name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"] })).toBeGreaterThan(0);
  });
  it("Dima is a candidate for Dmytro; Anne Dimon is not one for Yulia", () => {
    expect(pairScore({ humanId: "u", name: "Dima", emails: [] }, { humanId: "k", name: "Dmytro Burda", emails: ["dmytroburda@gmail.com"] })).toBeGreaterThan(0);
    expect(pairScore({ humanId: "u", name: "Yulia (WA)", emails: [] }, { humanId: "k", name: "Anne Dimon", emails: ["adimon@traveltowellness.com"] })).toBe(0);
  });
  it("from the known side, a lone matching first name beats a name with an extra unmatched token", () => {
    const pool = ["Julia Smith", "Yulia (WA)", "Bob"].map((name, i) => ({ person: { humanId: `u${i}`, name, emails: [] }, tokens: nameTokens(name) }));
    const c = unlinkedCandidatesFor({ humanId: "k", name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"] }, pool, 3);
    expect(c.map((x) => x.person.name)).toEqual(["Yulia (WA)", "Julia Smith"]);
  });
  it("a last name match ranks first", () => {
    const c = candidatesFor({ humanId: "u", name: "Yulia Siletska", emails: [] }, [
      { humanId: "a", name: "Yulia Other", emails: [] },
      { humanId: "b", name: "Yuliia Siletska", emails: [] },
    ]);
    expect(c[0].person.humanId).toBe("b");
  });
});

describe("bestName", () => {
  it("prefers a real name over a channel label", () => {
    expect(bestName(["Yulia (WA)", "Yuliia Siletska"])).toBe("Yuliia Siletska");
    expect(bestName(["+33612345678 (WA)"])).toBe("+33612345678 (WA)");
    expect(bestName([])).toBeNull();
  });
});

describe("companyOfEnrich", () => {
  it("reads the company the provider names, found = a person came back", () => {
    expect(companyOfEnrich({ output: { full_name: "A B", company_name: "Acme", company_domain: "https://www.acme.com/x" } })).toEqual({
      found: true,
      company: { name: "Acme", domain: "acme.com", source: "treg_enrich" },
      linkedinUrl: null,
    });
    expect(companyOfEnrich({ output: { full_name: null } }).found).toBe(false);
    expect(companyOfEnrich({ output: { full_name: "X", company: { name: "Co", website: "co.io" } } }).company).toEqual({ name: "Co", domain: "co.io", source: "treg_enrich" });
  });
});

describe("the pipe's relationship policy on the wire", () => {
  it("serve-next carries `relationships` only when the pipe states it", async () => {
    const { serveBody } = await import("../../src/lib/people-client.js");
    expect(serveBody({ orgId: "o" } as never)).toEqual({});
    expect(serveBody({ orgId: "o", relationships: "business_only" } as never)).toEqual({ relationships: "business_only" });
  });
});
