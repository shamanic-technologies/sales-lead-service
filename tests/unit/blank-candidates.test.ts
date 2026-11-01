import { describe, expect, it } from "vitest";
import { blankCandidatesCheckRun, isBlankCandidate } from "../../src/lib/blank-candidates.js";

const empty = {
  candidateId: "c1",
  audienceId: "aud-1",
  providerPersonId: "p1",
  linkedinUrl: "http://www.linkedin.com/in/dr-jace-buzek-9b487314",
  offeredAt: "2026-11-01T00:00:00Z",
  person: { name: null, title: null, headline: null, seniority: null, city: null, state: null, country: null },
  company: { name: "", domain: "wellsetdenver.com", industry: null, employees: null, city: null, state: null, country: null, keywords: [] },
};

describe("isBlankCandidate (BLANK-CANDIDATES-1101)", () => {
  it("an empty teaser is blank, a domain, a LinkedIn url or a name alone change nothing", () => {
    expect(isBlankCandidate(empty)).toBe(true);
    expect(isBlankCandidate({ ...empty, person: { ...empty.person, name: "Dr Jace Buzek" } })).toBe(true);
    expect(isBlankCandidate({ ...empty, company: { ...empty.company, name: "  ", keywords: ["", " "] } })).toBe(true);
  });

  it("any one field the screen reads makes it judgeable", () => {
    expect(isBlankCandidate({ ...empty, person: { ...empty.person, title: "Chiropractor" } })).toBe(false);
    expect(isBlankCandidate({ ...empty, person: { ...empty.person, state: "CO" } })).toBe(false);
    expect(isBlankCandidate({ ...empty, company: { ...empty.company, name: "Wellset Denver" } })).toBe(false);
    expect(isBlankCandidate({ ...empty, company: { ...empty.company, employees: 4 } })).toBe(false);
    expect(isBlankCandidate({ ...empty, company: { ...empty.company, keywords: ["chiropractic"] } })).toBe(false);
  });
});

describe("blankCandidatesCheckRun", () => {
  const now = new Date("2026-11-01T15:00:00Z");
  it("is red only while blank candidates arrive", () => {
    const red = blankCandidatesCheckRun({ lastWindow: 3, last24h: 106, byAudience: [] }, now);
    expect(red).toMatchObject({ check: "blank-candidates", ok: false, value: 106 });
    expect(String(red.reason)).toContain("3 candidates");
    expect(blankCandidatesCheckRun({ lastWindow: 0, last24h: 106, byAudience: [] }, now)).toMatchObject({ ok: true });
    expect(blankCandidatesCheckRun({ lastWindow: 0, last24h: 0, byAudience: [] }, now)).toMatchObject({ ok: true, value: 0 });
  });
});
