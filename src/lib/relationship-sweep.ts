/**
 * The relationship sweep (RELATIONSHIP-TAGS-1014), on the BACKGROUND thread every
 * `RELATIONSHIP_SWEEP_INTERVAL_MS`, per (org, brand) of the CRM fact feed:
 *   1. subjects: the brand's leads (human x company) rebuilt from the feed (relationship-subjects.ts);
 *   2. evidence: signup -> prospect, payment / sale -> customer, rewritten whole;
 *   3. judgment: Jev reads each lead whose thread moved (messages first), JUDGE_PER_TICK at most;
 *   4. merges: unlinked people (no email) vs known people, asked of Jev, stated in human-service;
 *   5. companies: unknown employers, free first then treg (owner-approved price ceilings).
 * Spend (Jev, treg) is billed to the org on ONE run per brand per tick of this service. A brand that
 * fails is logged and retried next tick; an org out of credit is skipped until it has credit again.
 */
import { createRun, updateRun } from "./runs-client.js";
import { lookUpCompanies } from "./relationship-company.js";
import { judgeSubject, subjectsToJudge, writeEvidence } from "./relationship-judge.js";
import { suggestMerges } from "./relationship-merges.js";
import { listScopes, refreshSubjects, type Scope } from "./relationship-subjects.js";
import { InsufficientCreditError, type SpendIdentity } from "./treg-client.js";

export const RELATIONSHIP_SWEEP_INTERVAL_MS = 5 * 60_000;
const FIRST_DELAY_MS = 150_000;
export const JUDGE_PER_TICK = 80;
const JUDGE_CONCURRENCY = 4;

export interface ScopeTick {
  scope: Scope;
  subjects: number;
  withoutHuman: number;
  evidenceWritten: number;
  judged: number;
  judgeFailed: number;
  merges: { asked: number; linked: number; open: number; rejected: number } | null;
  companies: { looked: number; free: number; treg: number; none: number; tregMicro: number } | null;
  error: string | null;
}

export async function sweepScope(scope: Scope, opts: { judge?: number; merges?: boolean; companies?: boolean } = {}): Promise<ScopeTick> {
  const tick: ScopeTick = { scope, subjects: 0, withoutHuman: 0, evidenceWritten: 0, judged: 0, judgeFailed: 0, merges: null, companies: null, error: null };
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
            await judgeSubject(s, id);
            tick.judged++;
          } catch (err) {
            if (err instanceof InsufficientCreditError) throw err;
            tick.judgeFailed++;
            console.error(`[lead-service] relationship judgment failed for human ${s.humanId} (brand ${scope.brandId}):`, err);
          }
        }
      };
      await Promise.all(Array.from({ length: JUDGE_CONCURRENCY }, worker));
    }
    if (opts.merges !== false) tick.merges = await suggestMerges(scope, await identity());
    if (opts.companies !== false) tick.companies = await lookUpCompanies(scope, await identity());
  } catch (err) {
    failed = true;
    tick.error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof InsufficientCreditError)) throw err;
    console.warn(`[lead-service] relationship sweep: org ${scope.orgId} cannot pay (${tick.error}); skipped this tick`);
  } finally {
    const r = run as { id: string } | null;
    if (r) await updateRun(r.id, failed ? "failed" : "completed").catch((e) => console.error("[lead-service] relationship run close failed:", e));
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
        if (r.judged || r.merges?.asked || r.companies?.looked) {
          console.log(
            `[lead-service] relationship sweep ${r.scope.brandId}: ${r.subjects} leads, judged ${r.judged} (${r.judgeFailed} failed), ` +
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
