/**
 * Keeps every CRM-paired brand's evidence current, on an in-process interval.
 *
 * `CRM_EVIDENCE_SYNC_INTERVAL_MS` IS the bound on how stale a lead's CRM-evidenced steps can be:
 * a deal marked won in their CRM reaches the lead within one interval of crm-service mirroring it.
 * It is an interval armed after boot, not a GitHub cron, because a declared cron is best-effort and
 * routinely skips hours.
 *
 * The mutex lives INSIDE the sweep, per brand, so the interval and the on-demand route
 * (`POST /orgs/leads/crm-evidence/sync`) can never run the same brand twice at once. A brand that
 * fails is logged loudly and the sweep carries on: one customer's CRM being unreadable is not a
 * reason to leave every other customer's stale.
 */
import { listCrmBrands, syncCrmEvidence, type CrmEvidenceSyncResult } from "./crm-evidence-sync.js";

export const CRM_EVIDENCE_SYNC_INTERVAL_MS = 10 * 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;

const inFlight = new Map<string, Promise<CrmEvidenceSyncResult>>();

/** Sync one brand, joining a sync of the same brand already running rather than starting a second. */
export function syncBrandOnce(orgId: string, brandId: string): Promise<CrmEvidenceSyncResult> {
  const key = `${orgId}:${brandId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = syncCrmEvidence(orgId, brandId).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * Sync one brand AFTER anything already running for it — for a change the running pass may have
 * read around (a person's ruling), where joining it would answer with the state before the change.
 */
export async function resyncBrand(orgId: string, brandId: string): Promise<CrmEvidenceSyncResult> {
  const running = inFlight.get(`${orgId}:${brandId}`);
  if (running) await running.catch(() => undefined);
  return await syncBrandOnce(orgId, brandId);
}

let sweeping = false;

export async function sweepCrmEvidence(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const brands = await listCrmBrands();
    for (const { orgId, brandId } of brands) {
      try {
        const r = await syncBrandOnce(orgId, brandId);
        console.log(
          `[crm-evidence] brand=${brandId} walked=${r.judging.contacts} judged=${r.judging.judged} ` +
            `judgmentFailed=${r.judging.judgmentFailed} deferred=${r.judging.deferred} ` +
            `withoutLead=${r.judging.withoutLead} contactsWithEvents=${r.contactsWithEvents} ` +
            `paired=${r.pairedContacts} leads=${r.leads} outcomes=${r.outcomes} nevers=${r.nevers} ` +
            `setAside=${r.withdrawnOutcomes}/${r.withdrawnNevers}`,
        );
      } catch (error) {
        console.error(
          `[crm-evidence] brand=${brandId} org=${orgId} could not be synced, so its CRM evidence ` +
            `stays as it was: ${(error as Error).message}`,
        );
      }
    }
  } finally {
    sweeping = false;
  }
}

export function startCrmEvidenceWorker(): void {
  const tick = () => {
    sweepCrmEvidence().catch((error) => console.error("[crm-evidence] sweep failed:", error));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, CRM_EVIDENCE_SYNC_INTERVAL_MS).unref();
}
