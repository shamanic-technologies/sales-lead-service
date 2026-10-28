import { describe, expect, it } from "vitest";
import { evaluateWalkCheck, replayServeWalk, WALK_RULES, type WalkCandidateStep, type WalkCheck, type WalkStep } from "../../src/lib/serve-walk-rules.js";

function cand(seq: number, ref: string, checks: WalkCheck[], outcome: WalkCandidateStep["outcome"], leadId: string | null = ref): WalkCandidateStep {
  return { type: "candidate", seq, pool: "candidates", ref, leadId, checks, outcome, reason: outcome === "skipped" ? checks.find((c) => !c.passed)?.rule ?? null : null };
}

describe("evaluateWalkCheck: each rule re-decided from its inputs alone", () => {
  const cases: Array<[WalkCheck["rule"], Record<string, unknown>, boolean]> = [
    ["screen", { cached: null, yesProbability: 0.51, threshold: 0.5 }, true],
    ["screen", { cached: null, yesProbability: 0.5, threshold: 0.5 }, false],
    ["screen", { cached: "reject", yesProbability: 0.9, threshold: 0.5 }, false],
    ["screen", { cached: "pass", yesProbability: null, threshold: 0.5 }, true],
    ["screen", { noTarget: true }, true],
    ["must_pass", { verdicts: [{ criterionId: "a", verdict: "yes" }, { criterionId: "b", verdict: "unavailable" }] }, true],
    ["must_pass", { verdicts: [{ criterionId: "a", verdict: "yes" }, { criterionId: "b", verdict: "no" }] }, false],
    ["reveal", { status: "served" }, true],
    ["reveal", { status: "not_served" }, false],
    ["reveal", { status: "reveal_stalled" }, false],
    ["journalist", { journalist: true }, false],
    ["journalist", { journalist: false }, true],
    ["recently_emailed", { window: "3_months", emailedWithinWindow: true }, false],
    ["recently_emailed", { window: "3_months", emailedWithinWindow: false }, true],
    ["retry_verdict", { verdict: "retry" }, true],
    ["retry_verdict", { verdict: "in_vendor_queue" }, false],
    ["retry_verdict", { verdict: "sender_refuses" }, false],
    ["channel_retry", { verdict: "channel_sent" }, false],
    ["claim", { claimed: false }, false],
    ["still_fits", { fits: false }, false],
    ["prospect_followup", { owed: false, kind: "stop", reasons: ["opted_out"] }, false],
    ["filed", { filed: true }, true],
  ];
  it.each(cases)("%s %j -> %s", (rule, inputs, expected) => {
    expect(evaluateWalkCheck({ rule, inputs })).toBe(expected);
  });

  it("covers every rule", () => {
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(WALK_RULES));
  });

  it("an unreadable input throws, never a guessed decision", () => {
    expect(() => evaluateWalkCheck({ rule: "journalist", inputs: {} })).toThrow(/journalist/);
    expect(() => evaluateWalkCheck({ rule: "screen", inputs: { cached: null } })).toThrow(/P\(yes\)/);
  });
});

describe("replayServeWalk", () => {
  const screenNo: WalkCheck = { rule: "screen", inputs: { cached: null, yesProbability: 0.2, threshold: 0.5 }, passed: false };
  const screenYes: WalkCheck = { rule: "screen", inputs: { cached: null, yesProbability: 0.8, threshold: 0.5 }, passed: true };
  const revealOk: WalkCheck = { rule: "reveal", inputs: { status: "served" }, passed: true };

  it("hands out the first person passing every check: the one the serve handed out", () => {
    const steps: WalkStep[] = [
      { type: "event", seq: 1, what: "audience_answer", detail: { answer: "exhausted" } },
      cand(2, "candidate:a", [screenNo], "skipped", null),
      cand(3, "candidate:b", [screenYes, { rule: "must_pass", inputs: { verdicts: [{ criterionId: "x", verdict: "no" }] }, passed: false }], "skipped", null),
      cand(4, "candidate:c", [screenYes, revealOk, { rule: "journalist", inputs: { journalist: true }, passed: false }], "skipped", "lead-c"),
      cand(5, "candidate:d", [screenYes, revealOk, { rule: "journalist", inputs: { journalist: false }, passed: true }], "served", "lead-d"),
    ];
    expect(replayServeWalk(steps)).toEqual({ servedRef: "candidate:d", servedLeadId: "lead-d", mismatches: [] });
  });

  it("names a recorded decision its inputs do not support", () => {
    const steps: WalkStep[] = [cand(1, "candidate:a", [{ ...screenNo, passed: true }], "served", "lead-a")];
    expect(replayServeWalk(steps).mismatches).toEqual([{ seq: 1, ref: "candidate:a", recorded: "served", replayed: "skipped" }]);
    expect(replayServeWalk(steps).servedLeadId).toBeNull();
  });

  it("ignores people looked at but never decided (a retryable row after the one claimed)", () => {
    const retry: WalkCheck = { rule: "retry_verdict", inputs: { verdict: "retry" }, passed: true };
    const steps: WalkStep[] = [
      cand(1, "row:1", [retry, { rule: "claim", inputs: { claimed: false }, passed: false }], "skipped", "l1"),
      cand(2, "row:2", [retry, { rule: "claim", inputs: { claimed: true }, passed: true }], "served", "l2"),
      cand(3, "row:3", [retry], "not_reached", "l3"),
    ];
    expect(replayServeWalk(steps)).toEqual({ servedRef: "row:2", servedLeadId: "l2", mismatches: [] });
  });

  it("an empty serve replays to nobody", () => {
    expect(replayServeWalk([cand(1, "candidate:a", [screenNo], "skipped", null)])).toEqual({ servedRef: null, servedLeadId: null, mismatches: [] });
  });
});
