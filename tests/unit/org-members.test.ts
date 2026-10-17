/**
 * TEAM-OUT-OF-UNIBOX-1017: who is a member of an org, read from client-service's FULL member list (`allMembers=true`,
 * opt-in there), and which addresses are the same person (a +tag variant of a member's address).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let respond: (url: string) => Response = () => new Response("{}", { status: 500 });
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    calls.push(String(url));
    return respond(String(url));
  },
}));

const { memberAddressKey, isMemberAddress, anyMemberAddress, loadOrgMemberKeys, clearOrgMembersCache, OrgMembersUnavailableError } = await import(
  "../../src/lib/org-members.js"
);

const ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("member address folding", () => {
  const members = new Set([memberAddressKey("Kevin.Lourd@gmail.com")!]);

  it("a member's own address is a member, whatever its case", () => {
    expect(isMemberAddress("kevin.lourd@gmail.com", members)).toBe(true);
    expect(isMemberAddress(" KEVIN.LOURD@GMAIL.COM ", members)).toBe(true);
  });

  it("a +tag variant of a member's address is the member", () => {
    expect(isMemberAddress("kevin.lourd+dougs@gmail.com", members)).toBe(true);
    expect(isMemberAddress("kevin.lourd+e2eclient1014@gmail.com", members)).toBe(true);
  });

  it("a similar address is someone else", () => {
    expect(isMemberAddress("kevin.lourdes@gmail.com", members)).toBe(false);
    expect(isMemberAddress("kevin.lourd@gmail.co", members)).toBe(false);
    expect(isMemberAddress("kevin.lourd@smartdistribute.com", members)).toBe(false);
    expect(isMemberAddress("+dougs@gmail.com", members)).toBe(false);
    expect(isMemberAddress("not-an-address", members)).toBe(false);
    expect(isMemberAddress(null, members)).toBe(false);
  });

  it("any of a person's addresses", () => {
    expect(anyMemberAddress(["ana@x.io", "kevin.lourd+t@gmail.com"], members)).toBe(true);
    expect(anyMemberAddress(["ana@x.io"], members)).toBe(false);
    expect(anyMemberAddress([], new Set())).toBe(false);
  });
});

describe("loadOrgMemberKeys", () => {
  beforeEach(() => {
    calls.length = 0;
    clearOrgMembersCache();
  });

  it("reads the org's FULL member list (allMembers=true), every page, and caches it", async () => {
    respond = (url) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      if (offset === 0) return json({ users: [...Array.from({ length: 499 }, (_, i) => ({ email: `p${i}@x.io` })), { email: null }], total: 501 });
      return json({ users: [{ email: "Kevin.Lourd@gmail.com" }], total: 501 });
    };
    const keys = await loadOrgMemberKeys(ORG);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const u = new URL(c);
      expect(u.pathname).toBe("/internal/users");
      expect(u.searchParams.get("orgId")).toBe(ORG);
      expect(u.searchParams.get("allMembers")).toBe("true");
    }
    expect(keys.has("kevin.lourd@gmail.com")).toBe(true);
    expect(keys.size).toBe(500);
    await loadOrgMemberKeys(ORG);
    expect(calls).toHaveLength(2);
  });

  it("client-service failing is loud, never an empty team", async () => {
    respond = () => json({ error: "boom" }, 502);
    await expect(loadOrgMemberKeys(ORG)).rejects.toBeInstanceOf(OrgMembersUnavailableError);
    respond = () => json({ nope: true });
    await expect(loadOrgMemberKeys(ORG)).rejects.toBeInstanceOf(OrgMembersUnavailableError);
  });
});
