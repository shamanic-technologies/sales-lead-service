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

// FACTORY-P3 next outcomes: each decision on our own code is its own `candidate-decision` run; the stored-script
// switch is off here (its path is pinned in candidate-decision-script.test.ts).
const createRun = vi.fn(async (_p: unknown) => ({ id: "decision-run" }));
const updateRun = vi.fn(async () => undefined);
vi.mock("../../src/lib/runs-client.js", async (orig) => ({ ...((await orig()) as object), createRun: (p: unknown) => createRun(p), updateRun: () => updateRun() }));
const decideWithScript = vi.fn();
vi.mock("../../src/lib/candidate-decision-script.js", async (orig) => ({
  ...((await orig()) as object),
  decisionScriptSwitch: async () => ({ switched: true, dynasty: "dy_candidate_decision" }),
  decideWithScript: (...a: unknown[]) => decideWithScript(...a),
}));

const priorScreenings: unknown[] = [];
const inserted: unknown[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => priorScreenings }) }) }),
    insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: async () => inserted.push(v) }) }),
  },
}));

const { serveThroughCandidates, doorCall, SCREEN_CALL, MUST_PASS_CALL, REVEAL_CALL, DECLINE_CALL } = await import("../../src/lib/candidate-serve.js");
const { CandidatesUnsupportedError, HumanServiceStalledError } = await import("../../src/lib/people-client.js");

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


/** The stored decision, as the script runs it: through the doors only (threshold 0.5, reason strings, stall decline). */
async function scriptLike(input: { candidateId: string; hasTarget: boolean; serveRunId: string }) {
  const door = async (call: string, reason?: string) => {
    const out = await doorCall({ callerRunId: input.serveRunId, scriptRunId: "script-run", call, candidateId: input.candidateId, reason });
    if (out.status !== 200) throw new Error(`script failed: ${call}: ${String(out.body.error)}`);
    return out.body;
  };
  if (input.hasTarget) {
    const s = await door(SCREEN_CALL);
    const p = Number(s.yesProbability);
    const pass = typeof s.cached === "string" ? s.cached === "pass" : p > 0.5;
    if (!pass) {
      await door(DECLINE_CALL, `screen_rejected ${typeof s.cached === "string" ? s.reason : `P(yes)=${p.toFixed(3)} threshold>0.5`}`);
      return { runId: "script-run", scriptSlug: "lead_identified/dy_candidate_decision/v1", decision: "declined" };
    }
  }
  const m = await door(MUST_PASS_CALL);
  if (typeof m.failed === "string") {
    await door(DECLINE_CALL, m.failed);
    return { runId: "script-run", scriptSlug: "s", decision: "declined" };
  }
  const r = await door(REVEAL_CALL);
  if (r.status === "stalled") {
    await door(DECLINE_CALL, `reveal_stalled after ${String(r.timeoutMs)}ms`);
    return { runId: "script-run", scriptSlug: "s", decision: "stalled" };
  }
  return { runId: "script-run", scriptSlug: "s", decision: r.status };
}

beforeEach(() => {
  vi.clearAllMocks();
  priorScreenings.length = 0;
  inserted.length = 0;
  mustPassCriteria.mockResolvedValue([]);
  decideWithScript.mockImplementation(scriptLike);
});

describe("FACTORY-P3: the stored decision decides through our doors", () => {
  it("declines a reject, reveals the next pass; the judgment's spend hangs on the script's run, the screening record on the serve's", async () => {
    nextCandidate.mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target }).mockResolvedValueOnce({ status: "candidate", candidate: cand("c2"), target });
    judgeYesNo.mockResolvedValueOnce({ probabilities: { answer: 0.2 }, model: "jev" }).mockResolvedValueOnce({ probabilities: { answer: 0.9 }, model: "jev" });
    revealCandidate.mockResolvedValueOnce({ status: "served", person, personId: "pid-2", emailVerdict: "valid" });
    const out = await serveThroughCandidates("aud-1", ctx, null);
    expect(out).toEqual({ status: "served", person, personId: "pid-2", emailVerdict: "valid" });
    expect(declineCandidate).toHaveBeenCalledWith("aud-1", "c1", "screen_rejected P(yes)=0.200 threshold>0.5", expect.any(String), ctx, expect.any(Number));
    expect(judgeYesNo.mock.calls.map((c) => (c[2] as { runId: string }).runId)).toEqual(["script-run", "script-run"]);
    expect((inserted as Array<{ runId: string }>).map((r) => r.runId)).toEqual(["run-1", "run-1"]);
    expect(decideWithScript).toHaveBeenCalledWith(expect.objectContaining({ dynasty: "dy_candidate_decision", serveRunId: "run-1", candidateId: "c1", hasTarget: true }));
    // No decision run of ours: the script's run is the decision.
    expect(createRun).not.toHaveBeenCalled();
  });

  it("a stalled reveal whose decline fails too hands the SAME stall error to the caller", async () => {
    nextCandidate.mockResolvedValueOnce({ status: "candidate", candidate: cand("c1"), target: null });
    revealCandidate.mockRejectedValueOnce(new HumanServiceStalledError("/reveal", 90_000));
    declineCandidate.mockRejectedValueOnce(new Error("human-service down"));
    const err = await serveThroughCandidates("aud-1", ctx, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HumanServiceStalledError);
  });

  it("a door serves only a candidate in flight", async () => {
    expect((await doorCall({ callerRunId: "run-x", scriptRunId: "s", call: SCREEN_CALL, candidateId: "c9" })).status).toBe(409);
  });
});
