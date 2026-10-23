import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));
const { pickLead, humanKeyOf, phoneKeyOf } = await import("../../src/lib/lead-id-resolve.js");

const cand = (key: string, leadId: string, orgId = "o1", brandIds = ["b1"]) => ({ key, leadId, orgId, brandIds });
type C = ReturnType<typeof cand>;
const maps = (apollo: C[] = [], email: C[] = [], linkedin: C[] = [], human: C[] = [], phone: C[] = []) => {
  const g = (cs: ReturnType<typeof cand>[]) => {
    const m = new Map<string, ReturnType<typeof cand>[]>();
    for (const c of cs) m.set(c.key, [...(m.get(c.key) ?? []), c]);
    return m;
  };
  return { apollo: g(apollo), email: g(email), human: g(human), phone: g(phone), linkedin: g(linkedin) };
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

  it("email outranks human id, human id outranks phone, phone outranks LinkedIn", () => {
    const H = "0b8f2c4e-1a2b-4c3d-8e9f-001122334455";
    const m = maps([], [cand("x@y.com", "E")], [cand("h", "L")], [cand(H, "HU")], [cand("33612345678", "P")]);
    expect(pickLead({ orgId: "o1", email: "x@y.com", humanId: H, phone: "+33612345678" }, m).matchedBy).toBe("email");
    expect(pickLead({ orgId: "o1", humanId: H.toUpperCase(), phone: "+33612345678" }, m)).toEqual({ leadId: "HU", matchedBy: "human_id" });
    expect(pickLead({ orgId: "o1", phone: "0033 6 12 34 56 78", linkedinUrl: "https://linkedin.com/in/h" }, m)).toEqual({ leadId: "P", matchedBy: "phone" });
  });

  it("an unreadable human id or phone matches nothing, and the item's other keys still answer", () => {
    expect(humanKeyOf("not-a-uuid")).toBeNull();
    expect(phoneKeyOf("06 12 34 56 78")).toBeNull();
    expect(phoneKeyOf("+33 6 12-34.56(78)")).toBe("33612345678");
    const m = maps([], [], [cand("h", "L")]);
    expect(pickLead({ orgId: "o1", humanId: "nope", phone: "0612", linkedinUrl: "https://linkedin.com/in/h" }, m)).toEqual({ leadId: "L", matchedBy: "linkedin_url" });
  });

  it("two leads on one key is no answer, never a pick", () => {
    expect(pickLead({ orgId: "o1", linkedinUrl: "https://linkedin.com/in/h" }, maps([], [], [cand("h", "A"), cand("h", "B")]))).toEqual({ leadId: null, matchedBy: null });
  });
});
