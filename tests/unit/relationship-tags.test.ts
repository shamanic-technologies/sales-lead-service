import { describe, expect, it } from "vitest";
import { decideTags, judgedState, policyAllows, tagsIn, type RelationshipTag } from "../../src/lib/relationship-tags.js";
import { bestName } from "../../src/lib/relationship-subjects.js";

const at = "2026-10-14T00:00:00.000Z";

describe("decideTags", () => {
  it("a person's word outranks evidence and judgment; evidence outranks judgment", () => {
    const d = decideTags({
      statements: new Map<RelationshipTag, { state: "yes" | "no"; at: string }>([["customer", { state: "no", at }]]),
      evidence: new Map([
        ["customer", { evidence: "payment", at }],
        ["prospect", { evidence: "signup", at }],
      ]),
      judgment: { probabilities: { prospect: 0.1, personal: 0.9, investor: 0.45, team: 0.1 }, at },
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
    expect(judgedState(0.5)).toBe("yes");
    expect(judgedState(0.59)).toBe("yes");
    expect(judgedState(0.4)).toBe("unsure");
    expect(judgedState(0.49)).toBe("unsure");
    expect(judgedState(0.39)).toBe("no");
  });
});

describe("policyAllows business_only", () => {
  const base = { subject: true, hasDirect: true, tags: [] as RelationshipTag[], unsureTags: [] as RelationshipTag[], judgedAt: at };
  it("not a subject, or a direct conversation never judged = held back (never assume a stranger)", () => {
    expect(policyAllows("business_only", { ...base, subject: false })).toBe(false);
    expect(policyAllows("business_only", { ...base, judgedAt: null })).toBe(false);
  });
  it("a subject known only by our outreach and the brand's tools needs no judgment (PROFESSIONAL-LEADS-1017)", () => {
    expect(policyAllows("business_only", { ...base, hasDirect: false, judgedAt: null })).toBe(true);
    expect(policyAllows("business_only", { ...base, hasDirect: false, judgedAt: null, tags: ["personal"] })).toBe(false);
  });
  it("personal yes or unsure = held back; customer + prospect pass", () => {
    expect(policyAllows("business_only", { ...base, tags: ["personal", "customer"] })).toBe(false);
    expect(policyAllows("business_only", { ...base, unsureTags: ["advisor"] })).toBe(false);
    expect(policyAllows("business_only", { ...base, tags: ["customer", "prospect"] })).toBe(true);
    expect(policyAllows("business_only", { ...base, tags: ["other_professional"] })).toBe(true);
  });
});

describe("the pipe's relationship policy on the wire", () => {
  it("serve-next carries `relationships` only when the pipe states it", async () => {
    const { serveBody } = await import("../../src/lib/people-client.js");
    expect(serveBody({ orgId: "o" } as never)).toEqual({});
    expect(serveBody({ orgId: "o", relationships: "business_only" } as never)).toEqual({ relationships: "business_only" });
  });
});
