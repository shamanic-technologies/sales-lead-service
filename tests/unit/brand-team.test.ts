/**
 * TEAM-PAST-EMPLOYERS-1125: the brand's own TEAM is a source of past employers beside its paying clients. Who the team
 * is (org members + relations tagged team), staff only on a staff org, team wins over paying client, the honest counts.
 */
import { describe, expect, it } from "vitest";
import {
  emptyReasonOf, groupPastEmployers, isStaffOrg, payingClientsNotTeam, teamCandidatesOf, type EmploymentRow,
} from "../../src/lib/client-past-employers.js";
import { MAX_LOOKUP_ADDRESSES, addressesToAsk } from "../../src/lib/client-past-employers-read.js";
import { foldOrgMembers } from "../../src/lib/org-members.js";

const member = (email: string | null, over: Partial<{ firstName: string; lastName: string; phone: string }> = {}) => ({
  email, emails: email ? [email] : [], firstName: over.firstName ?? null, lastName: over.lastName ?? null, phone: over.phone ?? null,
});

describe("who is a brand's team", () => {
  it("an org whose every member address is staff is ours: its staff are team", () => {
    const members = foldOrgMembers([{ email: "kevin.lourd@gmail.com" }, { email: "Kevin.Lourd+audit@gmail.com" }, { email: null }]);
    expect(isStaffOrg(members)).toBe(true);
    const team = teamCandidatesOf(members, []);
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({ source: "org_member", emails: ["kevin.lourd@gmail.com", "kevin.lourd+audit@gmail.com"] });
  });

  it("on a client org (a non-staff member), staff are nobody's team; the client's own members are", () => {
    const members = foldOrgMembers([{ email: "kevin.lourd@gmail.com" }, { email: "founder@client.com", firstName: "Ann", lastName: "Lee" }]);
    expect(isStaffOrg(members)).toBe(false);
    const team = teamCandidatesOf(members, [
      { humanId: "h-staff", name: "Kevin", emails: ["kevin@distribute.you"], phones: [] },
      { humanId: "h-cto", name: "Bob", emails: ["bob@client.com"], phones: [] },
    ]);
    expect(team.map((t) => t.emails[0])).toEqual(["founder@client.com", "bob@client.com"]);
    expect(team[0].name).toBe("Ann Lee");
    expect(team[1]).toMatchObject({ source: "team_relation", humanIds: ["h-cto"] });
  });

  it("a tagged relation sharing a member's address (or a +tag of it) is that member, not a second person", () => {
    const team = teamCandidatesOf(foldOrgMembers([{ email: "ann@client.com" }]), [
      { humanId: "h1", name: "Ann", emails: ["ann+x@client.com"], phones: [] },
    ]);
    expect(team).toHaveLength(1);
    expect(team[0].humanIds).toEqual(["h1"]);
  });

  it("an org with no address at all is not ours (no staff member is team there)", () => {
    expect(isStaffOrg(foldOrgMembers([{ email: null, phone: "+33600000000" }]))).toBe(false);
  });
});

describe("team wins over paying client", () => {
  it("a payer sharing a lead or a human with a team member is team only; other payers stay", () => {
    const humanOf = new Map<string, string | null>([["p1", "hA"], ["p2", "hB"], ["p3", null], ["t1", "hA"]]);
    const out = payingClientsNotTeam(
      [{ leadId: "p1", memberLeadIds: ["p1"] }, { leadId: "p2", memberLeadIds: ["p2"] }, { leadId: "p3", memberLeadIds: ["p3"] }],
      [{ memberLeadIds: ["t1"], humanIds: ["hB"] }],
      humanOf,
    );
    expect(out.map((c) => c.leadId)).toEqual(["p3"]);
  });
});

describe("the answer says who is who and counts honestly", () => {
  const row = (over: Partial<EmploymentRow>): EmploymentRow => ({
    clientLeadId: "a", role: "paying_client", leadId: "a", organizationId: "o", companyId: null, name: "Bain & Company", domain: null,
    logoUrl: null, linkedinUrl: null, title: null, startDate: null, endDate: null, current: false, ...over,
  });

  it("a company counts paying clients and team members apart, each trace entry naming its role", () => {
    const [bain] = groupPastEmployers([row({ clientLeadId: "client" }), row({ clientLeadId: "founder", role: "team", title: "Consultant" })]);
    expect(bain).toMatchObject({ clientCount: 2, payingClientCount: 1, teamCount: 1 });
    expect(bain.clients.find((c) => c.leadId === "founder")).toMatchObject({ role: "team", title: "Consultant" });
  });

  it("empty: nobody at all = no_paying_clients; people without a career = no_employment_history", () => {
    expect(emptyReasonOf(0, 0)).toBe("no_paying_clients");
    expect(emptyReasonOf(1, 0)).toBe("no_employment_history");
    expect(emptyReasonOf(1, 3)).toBeNull();
  });
});

describe("addressesToAsk", () => {
  it("asks the main address first, then the person's other mailboxes, one per mailbox, bounded", () => {
    expect(
      addressesToAsk({
        email: "kevin.lourd@gmail.com",
        lookupEmails: ["kevin.lourd+a@gmail.com", "K@Work.io", "kevin.lourd@gmail.com", "x@y.io", "z@w.io"],
      }),
    ).toEqual(["kevin.lourd@gmail.com", "k@work.io", "x@y.io"].slice(0, MAX_LOOKUP_ADDRESSES));
    expect(addressesToAsk({ email: "a@b.io" })).toEqual(["a@b.io"]);
  });
});
