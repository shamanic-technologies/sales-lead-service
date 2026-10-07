import { beforeEach, describe, expect, it, vi } from "vitest";

const nextCandidate = vi.fn();
const revealCandidate = vi.fn();
const declineCandidate = vi.fn();
vi.mock("../../src/lib/people-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    nextCandidate: (...a: unknown[]) => nextCandidate(...a),
    revealCandidate: (...a: unknown[]) => revealCandidate(...a),
    declineCandidate: (...a: unknown[]) => declineCandidate(...a),
  };
});

const judgeYesNo = vi.fn();
vi.mock("../../src/lib/qualification-judge.js", async (orig) => ({ ...((await orig()) as object), judgeYesNo: (...a: unknown[]) => judgeYesNo(...a) }));

const mustPassCriteria = vi.fn();
const recordCheck = vi.fn();
const observe = vi.fn();
const judge = vi.fn();
vi.mock("../../src/lib/qualification.js", async (orig) => ({
  ...((await orig()) as object),
  mustPassCriteria: (...a: unknown[]) => mustPassCriteria(...a),
  recordCheck: (...a: unknown[]) => recordCheck(...a),
  observe: (...a: unknown[]) => observe(...a),
  judge: (...a: unknown[]) => judge(...a),
}));

const priorScreenings: unknown[] = [];
const inserted: unknown[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => priorScreenings }) }) }),
    insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: async () => inserted.push(v) }) }),
  },
}));

const { serveThroughCandidates, decisionBasis, screenSnapshot, SCREEN_QUESTION } = await import("../../src/lib/candidate-serve.js");
const { CandidatesUnsupportedError } = await import("../../src/lib/people-client.js");

const ctx = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1", campaignId: "camp-1" };
const target = { text: "Chiropractors in Ohio", field: "target_text" };
function cand(id: string, domain: string | null = "acme.com") {
  return {
    candidateId: id,
    audienceId: "aud-1",
    providerPersonId: `p-${id}`,
    linkedinUrl: null,
    offeredAt: "2026-10-07T00:00:00Z",
    person: { name: "Ann", title: "Owner", headline: null, seniority: "owner", city: "Columbus", state: "OH", country: "US" },
    company: { name: "Acme", domain, industry: "health", employees: 5, city: null, state: null, country: "US", keywords: ["spine"] },
  };
}
const person = { email: "ann@acme.com", providerPersonId: "p-c1" };
const mustPass = { id: "crit-1", question: "Is the site slow?", probe: { kind: "company_data" }, mode: "must_pass" };

beforeEach(() => {
  vi.clearAllMocks();
  priorScreenings.length = 0;
  inserted.length = 0;
  mustPassCriteria.mockResolvedValue([]);
  observe.mockResolvedValue({ observation: { id: "o1" }, reused: false, chargedMicro: 0 });
});

describe("serveThroughCandidates", () => {
  it("an audience not served through candidates hands back to serve-next", async () => {
    nextCandidate.mockRejectedValue(new CandidatesUnsupportedError("422"));
    expect(await serveThroughCandidates("aud-1", ctx, "offer-a")).toBeNull();
  });

  it("passes exhausted and pending through unchanged", async () => {
    nextCandidate.mockResolvedValueOnce({ status: "exhausted", candidate: null, reason: "pool_exhausted", target });
    expect(await serveThroughCandidates("aud-1", ctx, "offer-a")).toEqual({ status: "exhausted", person: null });
    nextCandidate.mockResolvedValueOnce({ status: "pending", candidate: null, target });
    expect(await serveThroughCandidates("aud-1", ctx, "offer-a")).toEqual({ status: "pending", person: null });
  });

  it("screens with human-service's own question and input, declines a reject, reveals the next pass", async () => {
    nextCandidate
      .mockResolvedValueOnce({ status: "candidate", candidate: cand("c0"), target })
      .mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target });
    judgeYesNo.mockResolvedValueOnce({ probabilities: { answer: 0.2 }, model: "jev-1.13.0" }).mockResolvedValueOnce({ probabilities: { answer: 0.8 }, model: "jev-1.13.0" });
    revealCandidate.mockResolvedValue({ status: "served", person, personId: "pid-1", replayed: false });

    const r = await serveThroughCandidates("aud-1", ctx, "offer-a");
    expect(r).toEqual({ status: "served", person, personId: "pid-1" });
    const [state, questions] = judgeYesNo.mock.calls[0];
    expect(state).toEqual({ targetAudience: target.text, candidate: screenSnapshot(cand("c0")) });
    expect(questions).toEqual({ answer: { instructions: SCREEN_QUESTION } });
    expect((state as { candidate: { company: Record<string, unknown> } }).candidate.company.domain).toBeUndefined();
    expect(declineCandidate).toHaveBeenCalledWith("aud-1", "c0", expect.stringMatching(/^screen_rejected P\(yes\)=0\.200/), decisionBasis([]), ctx);
    expect(revealCandidate).toHaveBeenCalledWith("aud-1", "c1", decisionBasis([]), ctx);
    expect(inserted.map((v) => (v as { verdict: string }).verdict)).toEqual(["reject", "pass"]);
  });

  it("a person screened before (re-offered after a crash) is not judged again", async () => {
    priorScreenings.push({ verdict: "pass", reason: "P(yes)=0.9" });
    nextCandidate.mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target });
    revealCandidate.mockResolvedValue({ status: "served", person, replayed: true });
    await serveThroughCandidates("aud-1", ctx, "offer-a");
    expect(judgeYesNo).not.toHaveBeenCalled();
  });

  it("no target text: nothing to screen against, the person is not judged", async () => {
    nextCandidate.mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target: null });
    revealCandidate.mockResolvedValue({ status: "served", person });
    await serveThroughCandidates("aud-1", ctx, "offer-a");
    expect(judgeYesNo).not.toHaveBeenCalled();
    expect(revealCandidate).toHaveBeenCalled();
  });

  it("a company failing a must-pass check is declined before its reveal; an unanswerable check never declines", async () => {
    mustPassCriteria.mockResolvedValue([mustPass]);
    judgeYesNo.mockResolvedValue({ probabilities: { answer: 0.9 }, model: "jev" });
    nextCandidate
      .mockResolvedValueOnce({ status: "candidate", candidate: cand("c0"), target })
      .mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target })
      .mockResolvedValueOnce({ status: "candidate", candidate: cand("c2", null), target });
    judge.mockResolvedValueOnce({ verdict: { id: "v-no", verdict: "no", reason: null } }).mockResolvedValueOnce({ verdict: { id: "v-un", verdict: "unavailable", reason: "probe_failed" } });
    revealCandidate.mockResolvedValueOnce({ status: "not_served", person: null }).mockResolvedValueOnce({ status: "served", person });

    const r = await serveThroughCandidates("aud-1", ctx, "offer-a");
    expect(r?.status).toBe("served");
    const basis = decisionBasis([mustPass as never]);
    expect(basis).not.toBe(decisionBasis([]));
    expect(declineCandidate).toHaveBeenCalledWith("aud-1", "c0", "criterion_failed:crit-1", basis, ctx);
    // c1: the check could not answer -> revealed (not_served), c2: no domain -> not checked, revealed.
    expect(revealCandidate.mock.calls.map((c) => c[1])).toEqual(["c1", "c2"]);
    expect(mustPassCriteria).toHaveBeenCalledWith("org-1", "brand-1", "offer-a");
    expect(observe).toHaveBeenCalledTimes(2);
    // Every check applied is recorded for the pass rate, the unanswerable ones included.
    expect(recordCheck.mock.calls.map((c) => [c[0].subject, c[0].verdictId, c[0].reason])).toEqual([
      ["candidate:aud-1:p-c0", "v-no", null],
      ["candidate:aud-1:p-c1", "v-un", "probe_failed"],
      ["candidate:aud-1:p-c2", null, "no_company_domain"],
    ]);
  });

  it("an unresolvable offer on a brand with must-pass checks fails the serve, never serves unchecked", async () => {
    const { OfferUnresolvedError } = await import("../../src/lib/qualification.js");
    mustPassCriteria.mockRejectedValue(new OfferUnresolvedError("brand-1", ["offer-a"]));
    nextCandidate.mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target });
    await expect(serveThroughCandidates("aud-1", ctx, null)).rejects.toThrow(/refusing to serve unchecked/);
    expect(revealCandidate).not.toHaveBeenCalled();
  });
});
