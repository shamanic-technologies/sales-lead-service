import { describe, expect, it } from "vitest";
import { decideLead, decideWantsBusiness } from "../../src/lib/relationship-intent.js";
import type { TagDetail } from "../../src/lib/relationship-tags.js";

const d = (tag: TagDetail["tag"], state: TagDetail["state"], basis: TagDetail["basis"]): TagDetail => ({
  tag,
  level: "lead",
  state,
  basis,
  confidence: null,
  evidence: null,
  at: "2026-10-16T00:00:00.000Z",
});

describe("decideLead", () => {
  it("is yes when prospect or customer is yes, with the strongest basis", () => {
    expect(decideLead([d("prospect", "yes", "judgment"), d("customer", "yes", "evidence")])).toEqual({ state: "yes", basis: "evidence", tags: ["prospect", "customer"] });
  });
  it("is unsure when one is unsure and none yes; no when both say no; null when nothing speaks", () => {
    expect(decideLead([d("prospect", "unsure", "judgment"), d("customer", "no", "judgment")]).state).toBe("unsure");
    expect(decideLead([d("prospect", "no", "person"), d("customer", "no", "judgment"), d("personal", "yes", "judgment")])).toEqual({ state: "no", basis: "person", tags: ["prospect", "customer"] });
    expect(decideLead([d("personal", "yes", "judgment")])).toEqual({ state: null, basis: null, tags: [] });
  });
});

describe("decideWantsBusiness", () => {
  const yes = { state: "yes" as const, basis: "evidence" as const, tags: ["prospect" as const] };
  it("asks only a lead, only of someone who wrote, person > judgment", () => {
    expect(decideWantsBusiness({ lead: { state: null, basis: null, tags: [] }, wroteToUs: true, statement: null, judgment: { p: 0.9, at: "t" } }).reason).toBe("lead_unknown");
    expect(decideWantsBusiness({ lead: { ...yes, state: "no" }, wroteToUs: true, statement: { state: "yes", at: "t" }, judgment: null }).reason).toBe("not_a_lead");
    expect(decideWantsBusiness({ lead: yes, wroteToUs: false, statement: null, judgment: null }).reason).toBe("has_not_written");
    expect(decideWantsBusiness({ lead: yes, wroteToUs: true, statement: null, judgment: null }).reason).toBe("not_judged_yet");
    expect(decideWantsBusiness({ lead: yes, wroteToUs: true, statement: { state: "no", at: "t" }, judgment: { p: 0.9, at: "t" } })).toMatchObject({ state: "no", basis: "person" });
    expect(decideWantsBusiness({ lead: yes, wroteToUs: true, statement: null, judgment: { p: 0.45, at: "t" } })).toMatchObject({ state: "unsure", basis: "judgment", confidence: 0.45 });
    expect(decideWantsBusiness({ lead: yes, wroteToUs: true, statement: null, judgment: { p: 0.39, at: "t" } }).state).toBe("no");
  });
});
