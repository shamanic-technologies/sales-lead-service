import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));
const { pickLead } = await import("../../src/lib/lead-id-resolve.js");

const cand = (key: string, leadId: string, orgId = "o1", brandIds = ["b1"]) => ({ key, leadId, orgId, brandIds });
const maps = (apollo: ReturnType<typeof cand>[] = [], email: ReturnType<typeof cand>[] = [], linkedin: ReturnType<typeof cand>[] = []) => {
  const g = (cs: ReturnType<typeof cand>[]) => {
    const m = new Map<string, ReturnType<typeof cand>[]>();
    for (const c of cs) m.set(c.key, [...(m.get(c.key) ?? []), c]);
    return m;
  };
  return { apollo: g(apollo), email: g(email), linkedin: g(linkedin) };
};

describe("pickLead", () => {
  it("apollo person id outranks email, email outranks LinkedIn", () => {
    const m = maps([cand("ap", "A")], [cand("x@y.com", "E")], [cand("h", "H")]);
    expect(pickLead({ orgId: "o1", apolloPersonId: "ap", email: "X@y.com", linkedinUrl: "https://linkedin.com/in/h" }, m)).toEqual({ leadId: "A", matchedBy: "apollo_person_id" });
    expect(pickLead({ orgId: "o1", email: " X@Y.com ", linkedinUrl: "https://linkedin.com/in/h" }, m)).toEqual({ leadId: "E", matchedBy: "email" });
    expect(pickLead({ orgId: "o1", linkedinUrl: "https://www.linkedin.com/in/H/" }, m)).toEqual({ leadId: "H", matchedBy: "linkedin_url" });
  });

  it("only a lead of the org (and of a named brand) answers", () => {
    const m = maps([cand("ap", "A", "o2")]);
    expect(pickLead({ orgId: "o1", apolloPersonId: "ap" }, m)).toEqual({ leadId: null, matchedBy: null });
    const m2 = maps([cand("ap", "A")]);
    expect(pickLead({ orgId: "o1", brandIds: ["b2"], apolloPersonId: "ap" }, m2).leadId).toBeNull();
    expect(pickLead({ orgId: "o1", brandIds: ["b2", "b1"], apolloPersonId: "ap" }, m2).leadId).toBe("A");
  });

  it("two leads on one key is no answer, never a pick", () => {
    expect(pickLead({ orgId: "o1", linkedinUrl: "https://linkedin.com/in/h" }, maps([], [], [cand("h", "A"), cand("h", "B")]))).toEqual({ leadId: null, matchedBy: null });
  });
});
