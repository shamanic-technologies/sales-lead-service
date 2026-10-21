/**
 * ONE-TIME re-judge of every stored screenshot verdict under the image judgment (SCREENSHOT-CHECK-QUESTION-1021).
 *
 * Why: until img1 a screenshot check judged a GENERIC description of the page (headline, offer, CTA, look), so a
 * question about anything else (a phone in the header) was answered from silence. The screenshots themselves are
 * right and stay: each live criterion's question is asked again of the SAME stored image (the old verdict's own
 * observation, no capture paid again), the new verdict lands under the img1 key the reads now ask for, and every
 * `qualification_checks` row that pointed at the old verdict is pointed at the new one (pass rates move with it).
 *
 * Spend: the judgments and evidence sentences go on ONE run of the identity given (a staff org run, never a client
 * org: this is our bug). Idempotent: a verdict already frozen under img1 for that observation is reused, nothing
 * re-paid. `dryRun` lists what would be judged and writes/spends nothing.
 *
 * Run inside the container: node -e "import('/app/dist/lib/screenshot-rejudge.js').then(m => m.runFromEnv())"
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { QualificationObservationRow } from "../db/schema.js";
import { JUDGE_VERSION, criterionKey, judge, type QualificationDeps } from "./qualification.js";
import { probeKey, type ProbeSpec } from "./qualification-probes.js";
import { createRun, updateRun } from "./runs-client.js";
import { TregMeter, type SpendIdentity } from "./treg-client.js";
import { createHash } from "node:crypto";

export interface RejudgeOutcome {
  criterionId: string;
  question: string;
  domain: string;
  oldVerdict: string;
  newVerdict: string | null;
  newEvidence: string | null;
  checksRepointed: number;
}

/** The key a criterion's screenshot verdicts were frozen under before img1. */
function legacyKey(question: string, spec: ProbeSpec): string {
  const q = question.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(`${JUDGE_VERSION}\n${q}\n${probeKey(spec)}`).digest("hex");
}

export async function rejudgeScreenshotVerdicts(params: { dryRun: boolean; identity: SpendIdentity | null }): Promise<RejudgeOutcome[]> {
  if (!params.dryRun && !params.identity) throw new Error("[lead-service] a re-judge that spends needs the identity its run hangs on");
  const criteria = (await db.execute(sql`
    SELECT id::text AS id, question, probe
    FROM qualification_criteria
    WHERE archived_at IS NULL AND probe->>'kind' = 'treg' AND probe->>'reading' = 'screenshot'
    ORDER BY created_at
  `)) as unknown as Array<{ id: string; question: string; probe: ProbeSpec }>;

  const outcomes: RejudgeOutcome[] = [];
  for (const c of criteria) {
    const oldKey = legacyKey(c.question, c.probe);
    const newKey = criterionKey(c.question, c.probe);
    // The latest old verdict per domain, with the observation it read (only an observation holding a screenshot).
    const olds = (await db.execute(sql`
      SELECT DISTINCT ON (v.domain) v.id::text AS verdict_id, v.domain, v.verdict, o.id::text AS observation_id
      FROM qualification_verdicts v
      JOIN qualification_observations o ON o.id = v.observation_id
      WHERE v.criterion_key = ${oldKey} AND o.image_url IS NOT NULL AND o.status = 'ok'
      ORDER BY v.domain, v.judged_at DESC
    `)) as unknown as Array<{ verdict_id: string; domain: string; verdict: string; observation_id: string }>;

    for (const old of olds) {
      if (params.dryRun) {
        outcomes.push({ criterionId: c.id, question: c.question, domain: old.domain, oldVerdict: old.verdict, newVerdict: null, newEvidence: null, checksRepointed: 0 });
        continue;
      }
      const [observation] = (await db.execute(sql`
        SELECT id, probe_key AS "probeKey", domain, status, reason, endpoint_id AS "endpointId", content, image_url AS "imageUrl",
               vendor_cost_micro AS "vendorCostMicro", run_id AS "runId", observed_at AS "observedAt"
        FROM qualification_observations WHERE id = ${old.observation_id}::uuid
      `)) as unknown as QualificationObservationRow[];
      const identity = params.identity!;
      const deps: QualificationDeps = { meter: new TregMeter(identity), identity };
      const subject = { domain: old.domain, websiteUrl: `https://${old.domain}`, companyName: null, companyLinkedinUrl: null };
      const { verdict } = await judge({ question: c.question, probe: c.probe }, observation, subject, deps);
      if (verdict.criterionKey !== newKey) throw new Error(`[lead-service] re-judge froze under ${verdict.criterionKey}, expected ${newKey}`);
      // Every check of THIS criterion that read the old verdict reads the new one.
      const moved = (await db.execute(sql`
        UPDATE qualification_checks SET verdict_id = ${verdict.id}::uuid, reason = ${verdict.reason}, checked_at = now()
        WHERE criterion_id = ${c.id}::uuid AND verdict_id IN (
          SELECT v.id FROM qualification_verdicts v WHERE v.criterion_key = ${oldKey} AND v.domain = ${old.domain}
        )
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      outcomes.push({ criterionId: c.id, question: c.question, domain: old.domain, oldVerdict: old.verdict, newVerdict: verdict.verdict, newEvidence: verdict.evidence, checksRepointed: moved.length });
      console.log(`[lead-service] screenshot re-judge ${old.domain} | ${c.question} | ${old.verdict} -> ${verdict.verdict} | ${verdict.evidence ?? verdict.reason}`);
    }
  }
  return outcomes;
}

/** Container entry: REJUDGE_ORG_ID + REJUDGE_USER_ID (a staff org and its user), REJUDGE_DRY_RUN=1 to preview. */
export async function runFromEnv(): Promise<void> {
  const dryRun = process.env.REJUDGE_DRY_RUN === "1";
  let identity: SpendIdentity | null = null;
  if (!dryRun) {
    const orgId = process.env.REJUDGE_ORG_ID;
    const userId = process.env.REJUDGE_USER_ID;
    if (!orgId || !userId) throw new Error("[lead-service] REJUDGE_ORG_ID and REJUDGE_USER_ID are required");
    const run = await createRun({ orgId, userId, serviceName: "lead-service", taskName: "rejudge-screenshot-checks" });
    identity = { orgId, userId, runId: run.id };
  }
  try {
    const outcomes = await rejudgeScreenshotVerdicts({ dryRun, identity });
    console.log(JSON.stringify({ dryRun, runId: identity?.runId ?? null, judged: outcomes.length, outcomes }));
    if (identity) await updateRun(identity.runId, "completed", { orgId: identity.orgId, userId: identity.userId ?? undefined });
  } catch (error) {
    if (identity) await updateRun(identity.runId, "failed", { orgId: identity.orgId, userId: identity.userId ?? undefined });
    throw error;
  }
  process.exit(0);
}
