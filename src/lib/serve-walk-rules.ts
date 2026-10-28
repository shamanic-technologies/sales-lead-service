/**
 * FACTORY-RECORD-SERVE-1028: the WALK of one serve, as a record anyone can replay (pure, no IO).
 *
 * A serve looks at people in order (a pool row, a candidate offered by human-service, a found person) and decides each:
 * served, or skipped for a named reason. Each decision is a list of CHECKS, each carrying the inputs it read (a free
 * check's answer, the sender's statement, the screen's P(yes)) and whether the person passed it. Replaying the walk =
 * re-deciding every check from its inputs (`evaluateWalkCheck`) and taking the first person who passes all of theirs:
 * that must be the person the serve handed out (`replayServeWalk`). GTM Factory proves its port picks the same person
 * on real past serves this way.
 *
 * What a pool's SQL filters out never reaches the walk (reach, email policy, relationships, fresh contacts, journalist
 * scope): those are stated once, as the serve's policy, in the record's `context`. Ids only: no address, no name.
 */

/** Where a person came from in the walk. */
export const WALK_POOLS = [
  "retry_pool",
  "released",
  "contacted_prospects",
  "followup_due",
  "source_stock",
  "candidates",
  "serve_next",
  "named",
] as const;
export type WalkPool = (typeof WALK_POOLS)[number];

/** Every check a serve applies to one person, each re-decidable from its own inputs. */
export const WALK_RULES = [
  /** human-service's audience screen, judged here: `{cached: "pass"|"reject"|null, yesProbability, threshold, noTarget}`. */
  "screen",
  /** The offer's must-pass checks, in order, up to the first `no`: `{verdicts: [{criterionId, verdict}]}`. */
  "must_pass",
  /** human-service's reveal answer: `{status}` ("served" = a deliverable person came out). */
  "reveal",
  /** A journalist of the brand is never a lead: `{journalist}`. */
  "journalist",
  /** Fresh contacts only: `{window, emailedWithinWindow}`. */
  "recently_emailed",
  /** The email sender's statement on a paid-pool row (decideRetry): `{verdict, flags, servedAt, nowMs}`. */
  "retry_verdict",
  /** The non-email sender's record on a paid-pool row (decideChannelRetry): `{verdict}`. */
  "channel_retry",
  /** The atomic claim of a pool row (a concurrent run may take it first): `{claimed}`. */
  "claim",
  /** The stock's handover judge (the find still belongs to / fits its audience, still owed): `{fits, release}`. */
  "still_fits",
  /** The prospect follow-up verdict: `{owed, kind, reasons}`. */
  "prospect_followup",
  /** Filing the find under the source (another run may have taken the person first): `{filed}`. */
  "filed",
] as const;
export type WalkRule = (typeof WALK_RULES)[number];

export interface WalkCheck {
  rule: WalkRule;
  inputs: Record<string, unknown>;
  passed: boolean;
}

export type WalkOutcome = "served" | "skipped" | "not_reached";

export interface WalkCandidateStep {
  type: "candidate";
  seq: number;
  pool: WalkPool;
  /** Who, by id only: `row:<leads_campaigns id>`, `candidate:<human-service candidate id>`, `person:<id>`, `lead:<id>`. */
  ref: string;
  /** The lead this person is (null until known: a candidate before its reveal). */
  leadId: string | null;
  checks: WalkCheck[];
  /** `not_reached` = looked at but never decided (a later retryable row after the one claimed, an aborted serve). */
  outcome: WalkOutcome;
  /** The rule that skipped them (first failing check), null when served or not reached. */
  reason: string | null;
}

export interface WalkEventStep {
  type: "event";
  seq: number;
  /** What happened that is not a person (an audience answered exhausted, the sender could not be read...). */
  what: string;
  detail: Record<string, unknown>;
}

export type WalkStep = WalkCandidateStep | WalkEventStep;

function bool(inputs: Record<string, unknown>, key: string): boolean {
  const v = inputs[key];
  if (typeof v !== "boolean") throw new Error(`[serve-walk] check input ${key} is not a boolean: ${JSON.stringify(v)}`);
  return v;
}

/** Re-decide one check from its recorded inputs alone (the same rule the serve applied). Unreadable inputs THROW. */
export function evaluateWalkCheck(check: Pick<WalkCheck, "rule" | "inputs">): boolean {
  const i = check.inputs;
  switch (check.rule) {
    case "screen": {
      if (i.noTarget === true) return true;
      if (i.cached === "pass" || i.cached === "reject") return i.cached === "pass";
      if (typeof i.yesProbability !== "number" || typeof i.threshold !== "number") {
        throw new Error(`[serve-walk] screen check without a P(yes) and threshold: ${JSON.stringify(i)}`);
      }
      return i.yesProbability > i.threshold;
    }
    case "must_pass": {
      if (!Array.isArray(i.verdicts)) throw new Error(`[serve-walk] must_pass check without verdicts: ${JSON.stringify(i)}`);
      return !(i.verdicts as Array<{ verdict?: unknown }>).some((v) => v.verdict === "no");
    }
    case "reveal":
      return i.status === "served";
    case "journalist":
      return !bool(i, "journalist");
    case "recently_emailed":
      return !bool(i, "emailedWithinWindow");
    case "retry_verdict":
    case "channel_retry":
      return i.verdict === "retry";
    case "claim":
      return bool(i, "claimed");
    case "still_fits":
      return bool(i, "fits");
    case "prospect_followup":
      return bool(i, "owed");
    case "filed":
      return bool(i, "filed");
  }
}

export interface WalkReplay {
  /** The person the replay hands out: the first, in walk order, who passes every check. null = nobody. */
  servedRef: string | null;
  servedLeadId: string | null;
  /** Every decided person whose replayed outcome differs from the recorded one (empty = the record replays). */
  mismatches: Array<{ seq: number; ref: string; recorded: WalkOutcome; replayed: "served" | "skipped" }>;
}

/** Replay a recorded walk: re-decide every check from its inputs, hand out the first person passing all of theirs. */
export function replayServeWalk(steps: readonly WalkStep[]): WalkReplay {
  const candidates = steps
    .filter((s): s is WalkCandidateStep => s.type === "candidate")
    .slice()
    .sort((a, b) => a.seq - b.seq);
  let served: WalkCandidateStep | null = null;
  const mismatches: WalkReplay["mismatches"] = [];
  for (const c of candidates) {
    const passes = c.checks.every((check) => evaluateWalkCheck(check));
    if (passes && !served && c.outcome !== "not_reached") served = c;
    if (c.outcome === "not_reached") continue;
    const replayed = passes && served === c ? "served" : "skipped";
    if (replayed !== c.outcome) mismatches.push({ seq: c.seq, ref: c.ref, recorded: c.outcome, replayed });
  }
  return { servedRef: served?.ref ?? null, servedLeadId: served?.leadId ?? null, mismatches };
}

/** The reason a decided person was skipped: the first check they failed. */
export function skipReasonOf(checks: readonly WalkCheck[]): string | null {
  const failed = checks.find((c) => !c.passed);
  return failed ? failed.rule : null;
}
