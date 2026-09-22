import { describe, it, expect } from "vitest";
import {
  CRM_JUDGMENT_PAIR_AT,
  CRM_JUDGMENT_REJECT_AT,
  addCrmPairingCounts,
  canonicalizeOpportunityState,
  judgmentStatusOf,
  matchMethodKey,
  needsJudgment,
  resolveCrmPairing,
  signalVerdict,
  zeroCrmPairingCounts,
  type CrmPairingSignal,
} from "../../src/lib/crm-pairing.js";

const LEAD = "aaaaaaaa-0000-0000-0000-000000000001";

function signal(over: Partial<CrmPairingSignal> = {}): CrmPairingSignal {
  return {
    matchedLeadId: LEAD,
    matchMethod: "email",
    matchConfidence: "deterministic",
    candidateCount: 1,
    ...over,
  };
}

describe("signalVerdict — what a signal alone is worth", () => {
  it("pairs on a shared unique identifier", () => {
    expect(signalVerdict(signal({ matchMethod: "email", matchConfidence: "deterministic" }))).toBe(
      "paired",
    );
    expect(signalVerdict(signal({ matchMethod: "phone", matchConfidence: "deterministic" }))).toBe(
      "paired",
    );
  });

  it("pairs on domain + last name only when exactly one candidate carries it", () => {
    const strong = { matchMethod: "domain_name" as const, matchConfidence: "strong" as const };
    expect(signalVerdict(signal({ ...strong, candidateCount: 1 }))).toBe("paired");
    expect(signalVerdict(signal({ ...strong, candidateCount: 2 }))).toBe("unconfirmed");
  });

  // The whole point of the surface: measured on the first mirrored account, last name alone
  // pairs 164 people. None of them may silently become a merged status.
  it("NEVER pairs on a name, whatever the candidate count", () => {
    for (const method of ["full_name", "last_name"] as const) {
      for (const candidateCount of [1, 2, 40]) {
        expect(
          signalVerdict(signal({ matchMethod: method, matchConfidence: "probabilistic", candidateCount })),
        ).toBe("unconfirmed");
      }
    }
  });

  it("is unpaired when nothing matched", () => {
    expect(
      signalVerdict({
        matchedLeadId: null,
        matchMethod: null,
        matchConfidence: "unmatched",
        candidateCount: 0,
      }),
    ).toBe("unpaired");
  });
});

describe("needsJudgment — a judgment is only bought where the signal could not decide", () => {
  it("is false for a deterministic pairing and for nothing at all", () => {
    expect(needsJudgment(signal())).toBe(false);
    expect(
      needsJudgment({
        matchedLeadId: null,
        matchMethod: null,
        matchConfidence: "unmatched",
        candidateCount: 0,
      }),
    ).toBe(false);
  });

  it("is true for a name-only pairing and an ambiguous strong one", () => {
    expect(needsJudgment(signal({ matchMethod: "last_name", matchConfidence: "probabilistic" }))).toBe(
      true,
    );
    expect(
      needsJudgment(signal({ matchMethod: "domain_name", matchConfidence: "strong", candidateCount: 3 })),
    ).toBe(true);
  });
});

describe("judgmentStatusOf", () => {
  it("reads the bar, the floor and the hesitation between them", () => {
    expect(judgmentStatusOf(CRM_JUDGMENT_PAIR_AT)).toBe("pair");
    expect(judgmentStatusOf(0.99)).toBe("pair");
    expect(judgmentStatusOf(CRM_JUDGMENT_REJECT_AT)).toBe("reject");
    expect(judgmentStatusOf(0.01)).toBe("reject");
    expect(judgmentStatusOf(0.5)).toBe("undecided");
    expect(judgmentStatusOf(0.84)).toBe("undecided");
    expect(judgmentStatusOf(0.16)).toBe("undecided");
  });
});

describe("resolveCrmPairing — precedence is human > judgment > signal", () => {
  const nameOnly = signal({ matchMethod: "last_name", matchConfidence: "probabilistic", candidateCount: 9 });

  it("a name-only pairing with nothing else is unconfirmed and nobody decided it", () => {
    const v = resolveCrmPairing({
      signal: nameOnly,
      judgment: null,
      judgmentUnavailableReason: null,
      ruling: null,
    });
    expect(v.state).toBe("unconfirmed");
    expect(v.decidedBy).toBeNull();
    expect(v.judgmentStatus).toBe("not_asked");
  });

  it("a confident judgment pairs a name-only match", () => {
    const v = resolveCrmPairing({
      signal: nameOnly,
      judgment: { samePersonProbability: 0.94, model: "jev-1.13.0", judgedAt: "2026-09-22T00:00:00Z" },
      judgmentUnavailableReason: null,
      ruling: null,
    });
    expect(v.state).toBe("paired");
    expect(v.decidedBy).toBe("judgment");
    expect(v.judgmentStatus).toBe("pair");
  });

  it("a judgment below the floor rejects it", () => {
    const v = resolveCrmPairing({
      signal: nameOnly,
      judgment: { samePersonProbability: 0.03, model: "jev-1.13.0", judgedAt: "2026-09-22T00:00:00Z" },
      judgmentUnavailableReason: null,
      ruling: null,
    });
    expect(v.state).toBe("rejected");
    expect(v.decidedBy).toBe("judgment");
  });

  it("a hesitant judgment decides nothing and leaves the signal's answer standing", () => {
    const v = resolveCrmPairing({
      signal: nameOnly,
      judgment: { samePersonProbability: 0.5, model: "jev-1.13.0", judgedAt: "2026-09-22T00:00:00Z" },
      judgmentUnavailableReason: null,
      ruling: null,
    });
    expect(v.state).toBe("unconfirmed");
    expect(v.decidedBy).toBeNull();
    expect(v.judgmentStatus).toBe("undecided");
  });

  // The acceptance criterion the vendor's health must never be able to break.
  it("a judgment we could not get NEVER merges and NEVER rejects — it says so instead", () => {
    const v = resolveCrmPairing({
      signal: nameOnly,
      judgment: null,
      judgmentUnavailableReason: "judgment_service_unavailable",
      ruling: null,
    });
    expect(v.state).toBe("unconfirmed");
    expect(v.decidedBy).toBeNull();
    expect(v.judgmentStatus).toBe("unavailable");
    expect(v.judgmentUnavailableReason).toBe("judgment_service_unavailable");
  });

  it("a human accepting beats a rejecting judgment", () => {
    const v = resolveCrmPairing({
      signal: nameOnly,
      judgment: { samePersonProbability: 0.02, model: "jev-1.13.0", judgedAt: "2026-09-22T00:00:00Z" },
      judgmentUnavailableReason: null,
      ruling: { ruling: "accepted", note: null, statedByUserId: "u1", statedAt: "2026-09-22T00:00:00Z" },
    });
    expect(v.state).toBe("paired");
    expect(v.decidedBy).toBe("human");
  });

  it("a human rejecting beats even a deterministic email match", () => {
    const v = resolveCrmPairing({
      signal: signal(),
      judgment: null,
      judgmentUnavailableReason: null,
      ruling: { ruling: "rejected", note: "shared mailbox", statedByUserId: "u1", statedAt: "x" },
    });
    expect(v.state).toBe("rejected");
    expect(v.decidedBy).toBe("human");
  });

  it("a deterministic pairing needs no judgment and says nothing was spent", () => {
    const v = resolveCrmPairing({
      signal: signal(),
      judgment: null,
      judgmentUnavailableReason: null,
      ruling: null,
    });
    expect(v.state).toBe("paired");
    expect(v.decidedBy).toBe("signal");
    expect(v.judgmentStatus).toBe("not_needed");
  });

  it("nothing matched stays unpaired and asks for nothing", () => {
    const v = resolveCrmPairing({
      signal: {
        matchedLeadId: null,
        matchMethod: null,
        matchConfidence: "unmatched",
        candidateCount: 0,
      },
      judgment: null,
      judgmentUnavailableReason: null,
      ruling: null,
    });
    expect(v.state).toBe("unpaired");
    expect(v.decidedBy).toBeNull();
    expect(v.judgmentStatus).toBe("not_needed");
  });
});

describe("canonicalizeOpportunityState — never guessed", () => {
  it("reads the four states they actually use, case-insensitively", () => {
    expect(canonicalizeOpportunityState("open")).toBe("open");
    expect(canonicalizeOpportunityState("WON")).toBe("won");
    expect(canonicalizeOpportunityState(" abandoned ")).toBe("abandoned");
    expect(canonicalizeOpportunityState("lost")).toBe("lost");
  });

  it("answers null rather than defaulting to open", () => {
    expect(canonicalizeOpportunityState("Free Trail Client")).toBeNull();
    expect(canonicalizeOpportunityState(null)).toBeNull();
    expect(canonicalizeOpportunityState(undefined)).toBeNull();
    expect(canonicalizeOpportunityState(7)).toBeNull();
  });
});

describe("counts", () => {
  it("partition the contacts: the states sum to the contact count", () => {
    const counts = zeroCrmPairingCounts();
    const entries = [
      { state: "paired" as const, hasEmail: true, matchMethod: "email" as const },
      { state: "unconfirmed" as const, hasEmail: false, matchMethod: "last_name" as const },
      { state: "unconfirmed" as const, hasEmail: false, matchMethod: "last_name" as const },
      { state: "rejected" as const, hasEmail: true, matchMethod: "full_name" as const },
      { state: "unpaired" as const, hasEmail: false, matchMethod: null },
    ];
    for (const e of entries) {
      addCrmPairingCounts(counts, {
        ...e,
        opportunityStates: [],
        opportunityStageNames: [],
      });
    }
    expect(counts.crmContacts).toBe(5);
    expect(counts.crmContactsWithEmail).toBe(2);
    const stateTotal = Object.values(counts.byState).reduce((a, b) => a + b, 0);
    expect(stateTotal).toBe(counts.crmContacts);
    const methodTotal = Object.values(counts.byMatchMethod).reduce((a, b) => a + b, 0);
    expect(methodTotal).toBe(counts.crmContacts);
    expect(counts.byMatchMethod.none).toBe(1);
    expect(counts.byMatchMethod.last_name).toBe(2);
  });

  it("counts an opportunity state we cannot read as unrecognised, and every named stage as uncomparable", () => {
    const counts = zeroCrmPairingCounts();
    addCrmPairingCounts(counts, {
      hasEmail: true,
      state: "paired",
      matchMethod: "email",
      opportunityStates: [
        canonicalizeOpportunityState("won"),
        canonicalizeOpportunityState("open"),
        canonicalizeOpportunityState("something they invented"),
      ],
      opportunityStageNames: ["Free Trail Client", "BOOKED - NO BUY", null, "   "],
    });
    expect(counts.opportunities).toBe(3);
    expect(counts.opportunitiesByState.won).toBe(1);
    expect(counts.opportunitiesByState.open).toBe(1);
    expect(counts.opportunitiesByState.unrecognised).toBe(1);
    expect(counts.opportunitiesWithUncomparableStage).toBe(2);
  });
});

describe("matchMethodKey", () => {
  it("buckets an unmatched contact under none so the methods still partition", () => {
    expect(matchMethodKey(null)).toBe("none");
    expect(matchMethodKey("domain_name")).toBe("domain_name");
  });
});
