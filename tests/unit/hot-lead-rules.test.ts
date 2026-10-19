import { describe, expect, it } from "vitest";
import { hotFireVerdict, hotLeadIdempotencyKey, hotTransition, isHot, isStaffEmail } from "../../src/lib/hot-lead-rules.js";

describe("hot lead rules (HOT-LEAD-PROPOSAL-1019)", () => {
  it("a fact is a transition into hot: never seen or cold -> hot fires, staying hot does not", () => {
    expect(hotTransition(null, true)).toBe("became_hot");
    expect(hotTransition(false, true)).toBe("became_hot");
    expect(hotTransition(true, true)).toBe("stayed_hot");
    expect(hotTransition(true, false)).toBe("cooled");
    expect(hotTransition(false, false)).toBe("stays_cold");
    expect(hotTransition(null, false)).toBe("stays_cold");
  });

  it("hot = lead yes AND wants business yes, nothing less", () => {
    expect(isHot({ lead: { state: "yes" }, wantsBusiness: { state: "yes" } })).toBe(true);
    expect(isHot({ lead: { state: "unsure" }, wantsBusiness: { state: "yes" } })).toBe(false);
    expect(isHot({ lead: { state: "yes" }, wantsBusiness: { state: "unsure" } })).toBe(false);
    expect(isHot({ lead: { state: "yes" }, wantsBusiness: { state: null } })).toBe(false);
  });

  it("never for staff nor the brand's own team (a +tag variant of a member is the member)", () => {
    const members = new Set(["marie@acme.com"]);
    expect(hotFireVerdict(["prospect@client.io"], members)).toEqual({ fire: true });
    expect(hotFireVerdict(["Marie+test@Acme.com"], members)).toEqual({ fire: false, reason: "own_team" });
    expect(hotFireVerdict(["kevin+x@pressbeat.io"], members)).toEqual({ fire: false, reason: "staff" });
    expect(hotFireVerdict(["anyone@distribute.you"], new Set())).toEqual({ fire: false, reason: "staff" });
    expect(isStaffEmail("k.lourd+probe@some-sending-domain.com")).toBe(false);
  });

  it("the idempotency key names the episode (a new fact is a new event) and stays under 200 chars", () => {
    const base = { brandId: "b".repeat(36), offerId: "o".repeat(36), humanId: "h".repeat(36), companyKey: "c".repeat(300), hash: (s: string) => `${s.length}abcdefabcdefabcdef` };
    const one = hotLeadIdempotencyKey({ ...base, episode: 1 });
    const two = hotLeadIdempotencyKey({ ...base, episode: 2 });
    expect(one).not.toBe(two);
    expect(one.length).toBeLessThanOrEqual(200);
    expect(hotLeadIdempotencyKey({ ...base, companyKey: "", episode: 1 })).toContain(":-:1");
  });
});
