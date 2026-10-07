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
 * Spend rides the serve's run, exactly like the must-pass spend (treg metered here, AI through
 * chat-service); each Bonus check applied is recorded (`qualification_checks`, subject
 * `lead:<id>`), which is what the offer's pass rate counts.
 */
import type { FullLead } from "./lead-shape.js";
import { listBrandCriteria, listCriteria, probeOf } from "./qualification.js";
import { probeKey } from "./qualification-probes.js";
import { readLeadQualification, runCriterionOnLeads, type LeadQualification } from "./qualification-run.js";
import type { SpendIdentity } from "./treg-client.js";
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
export async function checksForWriter(lead: FullLead, criteria: QualificationCriterionRow[], identity: SpendIdentity | null): Promise<WriterChecks> {
  const bonus = criteria.filter((c) => c.mode === "mention");
  if (bonus.length && !identity) throw new Error(`[lead-service] Bonus checks on lead ${lead.leadId} need the serve's run id to declare their spend`);
  const byProbe = new Map<string, QualificationCriterionRow[]>();
  for (const c of bonus) {
    const k = probeKey(probeOf(c));
    byProbe.set(k, [...(byProbe.get(k) ?? []), c]);
  }
  await Promise.all(
    [...byProbe.values()].map(async (group) => {
      for (const criterion of group) await runCriterionOnLeads(criterion, [lead.leadId], identity!);
    }),
  );
  return readLeadQualification(lead, criteria);
}
