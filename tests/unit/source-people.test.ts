import { describe, expect, it } from "vitest";
import { computeSourcePeople, type SourcePeopleInput, type SourceServeRow } from "../../src/lib/source-people.js";
import type { BrandMembership } from "../../src/lib/audience-client.js";

const OFFER = "offer-1";
const OUTREACH = "outreach-1";
const SIGNALS_AUD = "aud-signals";
const LINKEDIN_AUD = "aud-linkedin";
const COLD_AUD = "aud-cold";

const m = (audienceId: string, list: string, provenance: "served" | "found_taken", joinedAt: string, offerId: string | null = OFFER): BrandMembership => ({
  audienceId,
  offerId,
  list,
  provenance,
  joinedAt,
});

const serve = (over: Partial<SourceServeRow> & { leadId: string }): SourceServeRow => ({
  campaignId: OUTREACH,
  audienceId: null,
  status: "served",
  at: "2026-10-10T10:00:00.000Z",
  buyingSignal: null,
  apolloPersonId: null,
  emails: [`${over.leadId}@x.com`],
  companyDomain: `${over.leadId}.com`,
  companyName: null,
  sourceFound: false,
  sourceHanded: false,
  setAsideReason: null,
  ...over,
});

function input(over: Partial<SourcePeopleInput>): SourcePeopleInput {
  return {
    offerId: OFFER,
    lists: new Set(["apollo_buying_signal"]),
    outreachCampaignIds: new Set([OUTREACH]),
    serves: [],
    membershipsByEmail: new Map(),
    screenings: [],
    checkDeclines: [],
    ...over,
  };
}

describe("computeSourcePeople", () => {
  // Alice: served by the buying-signals source, then found again by LinkedIn while already taken.
  const alice = serve({
    leadId: "alice",
    audienceId: SIGNALS_AUD,
    at: "2026-10-10T09:00:00.000Z",
    apolloPersonId: "ap-alice",
    buyingSignal: { type: "job_change", occurredOn: "2026-10-01", fact: "New role.", source: "apollo:job_change", sourceUrl: null },
  });
  const memberships = new Map<string, BrandMembership[]>([
    ["alice@x.com", [m(SIGNALS_AUD, "apollo_buying_signal", "served", "2026-10-10T09:00:00.000Z"), m(LINKEDIN_AUD, "linkedin_engagement", "found_taken", "2026-10-11T08:00:00.000Z")]],
    ["bob@x.com", [m(LINKEDIN_AUD, "linkedin_engagement", "served", "2026-10-09T12:00:00.000Z")]],
    ["carol@x.com", [m(COLD_AUD, "apollo_search", "served", "2026-09-28T12:00:00.000Z")]],
  ]);
  const bob = serve({ leadId: "bob", audienceId: LINKEDIN_AUD, at: "2026-10-09T12:00:00.000Z" });
  const carol = serve({ leadId: "carol", audienceId: COLD_AUD, at: "2026-09-28T12:00:00.000Z" });

  it("counts a person found by two sources in EACH source, never first-found", () => {
    const base = { serves: [alice, bob, carol], membershipsByEmail: memberships };
    const signals = computeSourcePeople(input({ ...base, lists: new Set(["apollo_buying_signal"]) }));
    const linkedin = computeSourcePeople(input({ ...base, lists: new Set(["linkedin_engagement"]) }));

    expect(signals.found.people).toBe(1);
    expect(signals.kept).toMatchObject({ people: 1, byThisSource: 1, viaAnotherSource: 0 });
    expect(signals.keptAlsoFoundByOtherSources).toBe(1);

    expect(linkedin.found.people).toBe(2); // bob (served) + alice (found while taken)
    expect(linkedin.kept).toMatchObject({ people: 2, byThisSource: 1, viaAnotherSource: 1 });
    // Alice is kept for LinkedIn on the day LinkedIn found her, not the day she was served.
    expect(linkedin.daily).toEqual([
      { day: "2026-10-09", found: 1, kept: 1 },
      { day: "2026-10-11", found: 1, kept: 1 },
    ]);
  });

  it("breaks the kept people down per buying signal of the source's own serve", () => {
    const r = computeSourcePeople(input({ serves: [alice, bob, carol], membershipsByEmail: memberships }));
    expect(r.bySignal).toEqual([{ type: "job_change", source: "apollo:job_change", competitorPage: null, postUrl: null, people: 1 }]);
    expect(r.keptWithoutSignal).toBe(0);
    expect(r.byAudience).toEqual([{ audienceId: SIGNALS_AUD, list: "apollo_buying_signal", found: 1, kept: 1, screenedOut: 0 }]);
  });

  it("counts screened-out candidates and must-pass declines as found, not kept, with their companies", () => {
    const r = computeSourcePeople(
      input({
        serves: [alice],
        membershipsByEmail: memberships,
        screenings: [
          { audienceId: SIGNALS_AUD, providerPersonId: "ap-alice", verdict: "pass", at: "2026-10-10T08:59:00.000Z", companyDomain: "alice.com", companyName: null },
          { audienceId: SIGNALS_AUD, providerPersonId: "ap-dan", verdict: "reject", at: "2026-10-10T08:00:00.000Z", companyDomain: "dan.com", companyName: null },
          { audienceId: SIGNALS_AUD, providerPersonId: "ap-eve", verdict: "pass", at: "2026-10-10T08:30:00.000Z", companyDomain: null, companyName: null },
        ],
        checkDeclines: [{ audienceId: SIGNALS_AUD, providerPersonId: "ap-eve", at: "2026-10-10T08:31:00.000Z", domain: "eve.com" }],
      }),
    );
    expect(r.found).toEqual({ people: 3, companies: 3, peopleWithoutCompany: 0 });
    expect(r.kept.people).toBe(1);
    expect(r.notKept).toEqual({ screened_out: 1, failed_qualification_check: 1, no_longer_fits: 0, kept_by_another_offer: 0, in_stock: 0, not_served: 0 });
    expect(r.found.people).toBe(r.kept.people + Object.values(r.notKept).reduce((a, b) => a + b, 0));
    expect(r.byAudience[0]).toMatchObject({ found: 3, kept: 1, screenedOut: 1 });
    // Alice was screened here: her rejected peers are in `found`, so no qualified_before_us gap.
    expect(r.gaps.find((g) => g.reason === "qualified_before_us")?.people).toBe(0);
  });

  it("serves unattributable history as gap counts with a reason, never on a source", () => {
    const r = computeSourcePeople(
      input({
        serves: [
          alice,
          serve({ leadId: "noaud", audienceId: null }),
          serve({ leadId: "unknown", audienceId: "aud-nobody-describes" }),
          serve({ leadId: "other-offer", audienceId: SIGNALS_AUD, campaignId: "outreach-of-another-offer" }),
        ],
        membershipsByEmail: memberships,
        screenings: [{ audienceId: "aud-unknown", providerPersonId: "ap-x", verdict: "reject", at: "2026-10-10T08:00:00.000Z", companyDomain: null, companyName: null }],
      }),
    );
    const gap = (reason: string) => r.gaps.find((g) => g.reason === reason)?.people;
    expect(gap("no_audience")).toBe(1);
    expect(gap("audience_unattributed")).toBe(1);
    expect(gap("screened_audience_unknown")).toBe(1);
    // Served by this source's audience but only under another offer's outreach: found, not kept here.
    expect(r.notKept.kept_by_another_offer).toBe(1);
    expect(r.found.people).toBe(2);
  });

  it("a source's own-run finds are never serves: waiting = in_stock, set aside at handover = no_longer_fits with the owner's reason", () => {
    const SOURCE = "source-unit";
    const find = (leadId: string, over: Partial<SourceServeRow> = {}) =>
      serve({ leadId, campaignId: SOURCE, audienceId: SIGNALS_AUD, at: "2026-10-12T13:34:00.000Z", sourceFound: true, ...over });
    const ms = new Map<string, BrandMembership[]>(
      ["waiting", "answered", "handed"].map((id) => [`${id}@x.com`, [m(SIGNALS_AUD, "apollo_buying_signal", "served", "2026-10-12T13:34:00.000Z")]]),
    );
    const r = computeSourcePeople(
      input({
        serves: [
          find("waiting"),
          find("answered", { setAsideReason: "Answered on WhatsApp since being found" }),
          find("handed", { sourceHanded: true }),
          serve({ leadId: "handed", audienceId: SIGNALS_AUD, at: "2026-10-12T15:00:00.000Z" }),
        ],
        membershipsByEmail: ms,
      }),
    );
    expect(r.found.people).toBe(3);
    expect(r.kept.people).toBe(1);
    expect(r.notKept).toMatchObject({ in_stock: 1, no_longer_fits: 1, kept_by_another_offer: 0, not_served: 0 });
    expect(r.noLongerFits).toEqual([{ reason: "Answered on WhatsApp since being found", people: 1 }]);
    expect(r.found.people).toBe(r.kept.people + Object.values(r.notKept).reduce((a, b) => a + b, 0));
  });

  it("flags the source's kept people that human-service qualified before handing them to us", () => {
    const r = computeSourcePeople(input({ serves: [alice], membershipsByEmail: memberships }));
    expect(r.gaps.find((g) => g.reason === "qualified_before_us")).toEqual({ reason: "qualified_before_us", people: 1, scope: "source" });
  });

  it("ignores an audience of another offer even when its list kind matches", () => {
    const r = computeSourcePeople(
      input({
        serves: [alice],
        membershipsByEmail: new Map([["alice@x.com", [m(SIGNALS_AUD, "apollo_buying_signal", "served", "2026-10-10T09:00:00.000Z", "offer-2")]]]),
      }),
    );
    expect(r.found.people).toBe(0);
  });
});
