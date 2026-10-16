/**
 * The relationship sweep (RELATIONSHIP-TAGS-1014), on the BACKGROUND thread every
 * `RELATIONSHIP_SWEEP_INTERVAL_MS`, per (org, brand) of the CRM fact feed:
 *   1. subjects: the brand's leads (human x company) rebuilt from the feed (relationship-subjects.ts);
 *   2. evidence: signup -> prospect, payment / sale -> customer, rewritten whole;
 *   3. judgment: Jev reads each lead whose thread moved (messages first), JUDGE_PER_TICK at most;
 *   3b. intent: Jev says whether each lead who WROTE to us wants to do business with the brand (relationship-intent.ts),
 *       INTENT_PER_TICK at most, after the tags (a lead is decided by them);
 *   4. merges: unlinked people (no email) vs known people, asked of Jev, stated in human-service;
 *   5. companies: unknown employers, free first then treg (owner-approved price ceilings).
 * Jev is platform-billed (no org request starts the sweep); treg lookups are metered to the org on ONE run per
 * brand per tick of this service. A brand that
 * fails is logged and retried next tick; an org out of credit is skipped until it has credit again.
 */
import { closePlatformRun, createPlatformRun, createRun, updateRun } from "./runs-client.js";
import { lookUpCompanies } from "./relationship-company.js";
import { judgeSubject, subjectsToJudge, writeEvidence } from "./relationship-judge.js";
import { intentSubjectsToJudge, judgeIntent } from "./relationship-intent-judge.js";
import { suggestMerges, type MergeTick } from "./relationship-merges.js";
import { listScopes, refreshSubjects, type Scope } from "./relationship-subjects.js";
import { recomputePolicy } from "./relationship-read.js";
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
  merges: MergeTick | null;
  companies: { looked: number; free: number; treg: number; none: number; tregMicro: number } | null;
  policyChanged: number;
  error: string | null;
}

export async function sweepScope(scope: Scope, opts: { judge?: number; intent?: number; merges?: boolean; companies?: boolean } = {}): Promise<ScopeTick> {
  const tick: ScopeTick = { scope, subjects: 0, withoutHuman: 0, evidenceWritten: 0, judged: 0, judgeFailed: 0, intentJudged: 0, merges: null, companies: null, policyChanged: 0, error: null };
  const refresh = await refreshSubjects(scope);
  tick.subjects = refresh.subjects;
  tick.withoutHuman = refresh.withoutHuman;
  tick.evidenceWritten = await writeEvidence(scope);

  let run: { id: string } | null = null;
  const identity = async (): Promise<SpendIdentity> => {
    if (!run) run = await createRun({ orgId: scope.orgId, brandId: scope.brandId, serviceName: "lead-service", taskName: "relationship-sweep" });
    return { orgId: scope.orgId, userId: null, runId: run.id, brandId: scope.brandId };
  };
  let platformRun: { id: string } | null = null;
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
    if (opts.merges !== false && tick.judgeFailed < MAX_JUDGE_FAILURES) tick.merges = await suggestMerges(scope, (await identity()).runId);
    if (opts.companies !== false) {
      tick.companies = await lookUpCompanies(scope, async () => {
        if (!platformRun) platformRun = await createPlatformRun("relationship-company-lookup");
        return platformRun.id;
      });
    }
    tick.policyChanged = await recomputePolicy(scope.orgId, scope.brandId);
  } catch (err) {
    failed = true;
    tick.error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof InsufficientCreditError)) throw err;
    console.warn(`[lead-service] relationship sweep: org ${scope.orgId} spend refused (${tick.error}); skipped this tick`);
  } finally {
    const r = run as { id: string } | null;
    if (r) await updateRun(r.id, failed ? "failed" : "completed", { orgId: scope.orgId, brandId: scope.brandId }).catch((e) => console.error("[lead-service] relationship run close failed:", e));
    const pr = platformRun as { id: string } | null;
    if (pr) await closePlatformRun(pr.id, failed ? "failed" : "completed").catch((e) => console.error("[lead-service] relationship platform run close failed:", e));
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
        if (r.judged || r.intentJudged || r.merges?.asked || r.merges?.settled || r.companies?.looked) {
          console.log(
            `[lead-service] relationship sweep ${r.scope.brandId}: ${r.subjects} leads, judged ${r.judged}, intent ${r.intentJudged} (${r.judgeFailed} failed), ` +
              `merges ${JSON.stringify(r.merges)}, companies ${JSON.stringify(r.companies)}`,
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
