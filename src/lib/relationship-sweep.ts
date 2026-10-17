/**
 * The relationship sweep (RELATIONSHIP-TAGS-1014), on the BACKGROUND thread every
 * `RELATIONSHIP_SWEEP_INTERVAL_MS`, per (org, brand) crm-service names professional people for:
 *   1. subjects: the brand's leads (human x company) = crm's `professional_to_brand` people (relationship-subjects.ts);
 *   2. evidence: signup -> prospect, payment / sale -> customer, rewritten whole;
 *   3. judgment: Jev reads each lead whose thread moved (messages first), JUDGE_PER_TICK at most;
 *   3b. intent: Jev says whether each lead who WROTE to us wants to do business with the brand (relationship-intent.ts),
 *       INTENT_PER_TICK at most, after the tags (a lead is decided by them);
 *   4. the Unibox read model: each lead's six tag dimensions (unibox-model.ts, UNIBOX-SIX-TAGS-1017).
 * "Same person?" and "which company?" are crm-service's and human-service's answers, read on the subjects; this
 * sweep asks neither (PROFESSIONAL-LEADS-1017). Jev is platform-billed (no org request starts the sweep). A brand that
 * fails is logged and retried next tick; an org out of credit is skipped until it has credit again.
 */
import { createRun, updateRun } from "./runs-client.js";
import { judgeSubject, subjectsToJudge, writeEvidence } from "./relationship-judge.js";
import { intentSubjectsToJudge, judgeIntent } from "./relationship-intent-judge.js";
import { listScopes, refreshSubjects, type Scope } from "./relationship-subjects.js";
import { recomputePolicy } from "./relationship-read.js";
import { refreshUniboxRows } from "./unibox-model.js";
import { InsufficientCreditError, type SpendIdentity } from "./treg-client.js";

export const RELATIONSHIP_SWEEP_INTERVAL_MS = 5 * 60_000;
const FIRST_DELAY_MS = 150_000;
export const JUDGE_PER_TICK = 60;
/** One short question on the newest ~3k tokens: ~760 writers fleet-wide on day one, done in about three hours. */
export const INTENT_PER_TICK = 20;
const JUDGE_CONCURRENCY = 3;
/** Consecutive-or-not judgment failures after which a brand's tick stops asking Jev (vendor down / out of credit). */
const MAX_JUDGE_FAILURES = 3;

export interface ScopeTick {
  scope: Scope;
  subjects: number;
  withoutHuman: number;
  evidenceWritten: number;
  judged: number;
  judgeFailed: number;
  intentJudged: number;
  policyChanged: number;
  unibox: { rows: number; removed: number; teamMembers: number } | null;
  error: string | null;
}

export async function sweepScope(scope: Scope, opts: { judge?: number; intent?: number } = {}): Promise<ScopeTick> {
  const tick: ScopeTick = { scope, subjects: 0, withoutHuman: 0, evidenceWritten: 0, judged: 0, judgeFailed: 0, intentJudged: 0, policyChanged: 0, unibox: null, error: null };
  const refresh = await refreshSubjects(scope);
  tick.subjects = refresh.subjects;
  tick.withoutHuman = refresh.withoutHuman;
  tick.evidenceWritten = await writeEvidence(scope);

  let run: { id: string } | null = null;
  const identity = async (): Promise<SpendIdentity> => {
    if (!run) run = await createRun({ orgId: scope.orgId, brandId: scope.brandId, serviceName: "lead-service", taskName: "relationship-sweep" });
    return { orgId: scope.orgId, userId: null, runId: run.id, brandId: scope.brandId };
  };
  let failed = false;
  try {
    const todo = await subjectsToJudge(scope, opts.judge ?? JUDGE_PER_TICK);
    if (todo.length > 0) {
      const id = await identity();
      let next = 0;
      const worker = async () => {
        while (next < todo.length) {
          const s = todo[next++];
          try {
            await judgeSubject(s, id.runId);
            tick.judged++;
          } catch (err) {
            if (err instanceof InsufficientCreditError) throw err;
            tick.judgeFailed++;
            if (tick.judgeFailed >= MAX_JUDGE_FAILURES) next = todo.length;
            console.error(`[lead-service] relationship judgment failed for human ${s.humanId} (brand ${scope.brandId}):`, err);
          }
        }
      };
      await Promise.all(Array.from({ length: JUDGE_CONCURRENCY }, worker));
    }
    if (tick.judgeFailed < MAX_JUDGE_FAILURES) {
      const intentTodo = await intentSubjectsToJudge(scope, opts.intent ?? INTENT_PER_TICK);
      for (const s of intentTodo) {
        if (tick.judgeFailed >= MAX_JUDGE_FAILURES) break;
        try {
          await judgeIntent(s, (await identity()).runId);
          tick.intentJudged++;
        } catch (err) {
          if (err instanceof InsufficientCreditError) throw err;
          tick.judgeFailed++;
          console.error(`[lead-service] intent judgment failed for human ${s.humanId} (brand ${scope.brandId}):`, err);
        }
      }
    }
    tick.policyChanged = await recomputePolicy(scope.orgId, scope.brandId);
    tick.unibox = await refreshUniboxRows(scope);
  } catch (err) {
    failed = true;
    tick.error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof InsufficientCreditError)) throw err;
    console.warn(`[lead-service] relationship sweep: org ${scope.orgId} spend refused (${tick.error}); skipped this tick`);
  } finally {
    const r = run as { id: string } | null;
    if (r) await updateRun(r.id, failed ? "failed" : "completed", { orgId: scope.orgId, brandId: scope.brandId }).catch((e) => console.error("[lead-service] relationship run close failed:", e));
  }
  return tick;
}

let sweeping = false;

export async function sweepAllOnce(): Promise<ScopeTick[]> {
  const out: ScopeTick[] = [];
  for (const scope of await listScopes()) {
    try {
      out.push(await sweepScope(scope));
    } catch (err) {
      console.error(`[lead-service] relationship sweep failed for org ${scope.orgId} brand ${scope.brandId}:`, err);
    }
  }
  return out;
}

export function startRelationshipSweepWorker(): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const results = await sweepAllOnce();
      for (const r of results) {
        if (r.judged || r.intentJudged) {
          console.log(
            `[lead-service] relationship sweep ${r.scope.brandId}: ${r.subjects} leads, judged ${r.judged}, intent ${r.intentJudged} (${r.judgeFailed} failed)`,
          );
        }
      }
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), RELATIONSHIP_SWEEP_INTERVAL_MS).unref();
}
