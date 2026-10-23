/**
 * What the email writer is told about a served lead's company (owner 2026-10-07): every ENABLED
 * check of the campaign's offer, Hard filter (`must_pass`) or Bonus (`mention`), whatever it found
 * (yes, no, could not check), with its evidence sentence and screenshot. It is CONTEXT: the writer
 * is never told it must cite it, each template decides.
 *
 * WHEN each check is paid for:
 *   - Hard filters run BEFORE the reveal (candidate-serve.ts); here they are only READ back.
 *   - Bonus checks run HERE, once the person is served: human-service serves only a person whose
 *     email it verified deliverable, and the lead is handed to the writer next. A person nobody
 *     serves never pays for a Bonus check. Bonus never ranks nor declines anyone.
 *
 * Spend rides a `company-research` child run of the serve, which declares `company_researched` for the company
 * when it paid new research (run-outcomes.ts); each Bonus check applied is recorded (`qualification_checks`, subject
 * `lead:<id>`), which is what the offer's pass rate counts.
 */
import type { FullLead } from "./lead-shape.js";
import { listBrandCriteria, listCriteria, probeOf } from "./qualification.js";
import { probeKey } from "./qualification-probes.js";
import { readLeadQualification, runCriterionOnLeads, type LeadQualification } from "./qualification-run.js";
import type { SpendIdentity } from "./treg-client.js";
import { companyResearchedDeclaration, declareRunOutcomes } from "./run-outcomes.js";
import { createRun, updateRun } from "./runs-client.js";
import type { QualificationCriterionRow } from "../db/schema.js";

export interface WriterChecks {
  domain: string | null;
  checks: LeadQualification[];
}

/**
 * The enabled checks of the campaign's offer. Read once per serve, BEFORE anything is bought.
 * No offer resolved: no check can be named for the writer (the Hard filter side of that case
 * already refuses to serve, see mustPassCriteria). Bonus checks are context, never a gate, so a
 * serve is not refused over them: the skipped checks are logged loudly instead.
 */
export async function offerChecks(orgId: string, brandId: string, offerId: string | null): Promise<QualificationCriterionRow[]> {
  if (offerId) return (await listCriteria({ orgId, brandId, offerId })).filter((c) => c.enabled);
  const anywhere = (await listBrandCriteria(orgId, brandId)).filter((c) => c.enabled);
  if (anywhere.length) {
    console.error(
      `[lead-service] campaign offer unresolved on brand ${brandId}: the writer gets no check results, ` +
        `${anywhere.length} enabled check(s) on offer(s) ${[...new Set(anywhere.map((c) => c.offerId))].join(", ")} skipped`,
    );
  }
  return [];
}

/**
 * Run the Bonus checks on this served lead's company, then read EVERY given check back as the
 * writer will see it. Bonus checks sharing a probe run one after the other so the second reads
 * the first's observation instead of paying for it again; different probes run side by side.
 */
/**
 * The serve's child run for its Bonus research. runs-service unable to open it: the research rides the serve's own run
 * (logged loud, the serve is never failed for its bookkeeping) and nothing is declared for it.
 */
async function openResearchRun(serve: SpendIdentity): Promise<SpendIdentity> {
  try {
    const run = await createRun({
      orgId: serve.orgId,
      serviceName: "lead-service",
      taskName: "company-research",
      parentRunId: serve.runId,
      ...(serve.userId ? { userId: serve.userId } : {}),
      ...(serve.brandId ? { brandId: serve.brandId } : {}),
      ...(serve.campaignId ? { campaignId: serve.campaignId } : {}),
      ...(serve.workflowSlug ? { workflowSlug: serve.workflowSlug } : {}),
      ...(serve.featureSlug ? { featureSlug: serve.featureSlug } : {}),
    });
    return { ...serve, runId: run.id };
  } catch (err) {
    console.error(`[lead-service] company-research run not opened under serve run ${serve.runId}: research rides the serve run, undeclared:`, err);
    return serve;
  }
}

export async function checksForWriter(lead: FullLead, criteria: QualificationCriterionRow[], identity: SpendIdentity | null): Promise<WriterChecks> {
  const bonus = criteria.filter((c) => c.mode === "mention");
  if (bonus.length && !identity) throw new Error(`[lead-service] Bonus checks on lead ${lead.leadId} need the serve's run id to declare their spend`);
  const byProbe = new Map<string, QualificationCriterionRow[]>();
  for (const c of bonus) {
    const k = probeKey(probeOf(c));
    byProbe.set(k, [...(byProbe.get(k) ?? []), c]);
  }
  if (bonus.length) {
    // The research is its OWN production order (COST-ACCOUNTING-1023-P1): a child run of the serve, so its cost lands on
    // `company_researched` (the writer consumes it), never on the serve's `lead_found`.
    const research = await openResearchRun(identity!);
    const researched = new Set<string>();
    let ok = false;
    try {
      await Promise.all(
        [...byProbe.values()].map(async (group) => {
          for (const criterion of group) await runCriterionOnLeads(criterion, [lead.leadId], research, researched);
        }),
      );
      ok = true;
    } finally {
      if (research.runId !== identity!.runId) {
        if (researched.size > 0) declareRunOutcomes(companyResearchedDeclaration({ orgId: research.orgId, runId: research.runId, domains: [...researched] }));
        updateRun(research.runId, ok ? "completed" : "failed", { orgId: research.orgId, userId: research.userId ?? undefined, brandId: research.brandId ?? undefined }).catch((err) =>
          console.error(`[lead-service] company-research run ${research.runId} not closed:`, err),
        );
      }
    }
  }
  return readLeadQualification(lead, criteria);
}
