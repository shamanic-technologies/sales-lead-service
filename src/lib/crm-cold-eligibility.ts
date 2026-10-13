/**
 * The two reads the went-cold rule (`lead-cold.ts`) needs about the customer's CRM.
 *
 *   - Is the brand's CRM USABLE as evidence that a step did not happen? Read from crm-service, which
 *     owns the connection and what each pipeline stage means: not paused, its last SUCCESSFUL sync
 *     within CRM_SYNC_MAX_AGE_MS, and at least one stage resolved (and served as evidence) to the step
 *     whose absence the rule reads. The question is whether the evidence we HOLD is fresh, not whether
 *     the latest ATTEMPT succeeded: crm-service writes `lastSyncedAt` only when a pass succeeds (a
 *     failed pass sets `status: "error"` + `lastError` and leaves it alone), so one timed-out pass
 *     while the last good data is minutes old must not suspend the rule — that made a client's ROI
 *     flip between two numbers on every transient hiccup. A CRM that stays broken (auth revoked,
 *     disconnected upstream) stops succeeding, ages past the window and is suspended, loud.
 *   - Which of these leads have a CRM candidate whose pairing is still UNDECIDED? Decided by the SAME
 *     `resolveCrmPairing` over the same frozen match, judgment and human ruling every pairing read
 *     uses. Such a lead's CRM evidence does not flow to it yet, so its silence proves nothing.
 *
 * An unreadable CRM is the owner's stated case — nothing goes cold, everything reads as it did —
 * and it is LOUD: the reason rides on the answer (`crm_unreadable`) and the cause is logged. It is
 * never cached, so the next read asks again.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fetchCrmConnection, fetchCrmStageMeanings } from "./crm-client.js";
import {
  CRM_COLD_INELIGIBLE,
  type CrmColdEligibility,
} from "./lead-cold.js";

/**
 * A CRM whose last SUCCESSFUL sync is older than this is not current enough to prove an absence.
 * crm-service syncs every 15 minutes, so this tolerates ~24 consecutive failed passes; past it a
 * step the CRM would have shown could be missing from what we hold.
 */
export const CRM_SYNC_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** How long a READABLE answer is reused in-process. A connection's state moves on a sync's cadence. */
const ELIGIBILITY_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; value: CrmColdEligibility }>();

/** Test hook. */
export function clearCrmColdEligibilityCache(): void {
  cache.clear();
}

export async function loadCrmColdEligibility(
  orgId: string,
  brandId: string,
  now: Date = new Date(),
): Promise<CrmColdEligibility> {
  const key = `${orgId}:${brandId}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < ELIGIBILITY_TTL_MS) return hit.value;

  let value: CrmColdEligibility;
  // A cheap local gate first, so a brand without a CRM costs no network call: with no CRM contact
  // ever paired against our leads, no CRM evidence can reach any of them.
  // Pairing is by human-service's humanId on the brand's CRM facts (crm-matching.ts): a brand whose
  // CRM never stated a person cannot pair anyone.
  const paired = (await db.execute(sql`
    SELECT 1 AS hit FROM crm_facts WHERE brand_id = ${brandId} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as Array<{ hit: number }>;
  if (paired.length === 0) {
    value = CRM_COLD_INELIGIBLE("crm_never_paired");
    cache.set(key, { at: now.getTime(), value });
    return value;
  }
  try {
    const connection = await fetchCrmConnection(brandId, { orgId, brandId });
    if (!connection) value = CRM_COLD_INELIGIBLE("no_crm_connection");
    // `error` is a status crm-service writes on a FAILED ATTEMPT, not a state of the data; only a
    // connection someone paused (or any status we do not know) is not a live CRM.
    else if (connection.status !== "active" && connection.status !== "error") {
      value = CRM_COLD_INELIGIBLE("crm_not_active");
    } else if (!connection.synced || !connection.lastSyncedAt) value = CRM_COLD_INELIGIBLE("crm_not_synced");
    else if (!(now.getTime() - Date.parse(connection.lastSyncedAt) <= CRM_SYNC_MAX_AGE_MS)) {
      // Stale (or an unreadable date). Name WHY: still failing, or simply not synced lately.
      value = CRM_COLD_INELIGIBLE(connection.lastError ? "crm_sync_failing" : "crm_sync_stale");
      console.warn(
        `[lead-cold] brand ${brandId}'s CRM last synced successfully at ${connection.lastSyncedAt}, ` +
          `older than ${CRM_SYNC_MAX_AGE_MS / 3_600_000}h, so no lead of it goes cold` +
          (connection.lastError ? `; its sync is failing: ${connection.lastError}` : ""),
      );
    } else {
      if (connection.lastError) {
        console.warn(
          `[lead-cold] brand ${brandId}'s last CRM sync attempt failed (${connection.lastError}); the ` +
            `rule still applies on the data synced at ${connection.lastSyncedAt}, inside the ` +
            `${CRM_SYNC_MAX_AGE_MS / 3_600_000}h window`,
        );
      }
      const meanings = await fetchCrmStageMeanings(brandId, { orgId, brandId });
      const served = new Set(meanings.filter((m) => m.servedAsEvidence).map((m) => m.meaning));
      value = {
        eligible: true,
        reason: null,
        evidences: {
          meeting_booked: served.has("meeting_booked"),
          meeting_attended: served.has("meeting_attended") || served.has("meeting_not_held"),
        },
      };
    }
  } catch (error) {
    console.error(
      `[lead-cold] crm-service could not say whether brand ${brandId}'s CRM is usable, so no lead ` +
        `of it goes cold on this read: ${(error as Error).message}`,
    );
    return CRM_COLD_INELIGIBLE("crm_unreadable");
  }
  cache.set(key, { at: now.getTime(), value });
  return value;
}

/** The orgs whose CRM was ever paired against this brand's leads. */
export async function crmPairedOrgs(brandId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id FROM crm_facts WHERE brand_id = ${brandId}
  `)) as unknown as Array<{ org_id: string }>;
  return rows.map((r) => r.org_id);
}

/**
 * The subset of `leadIds` with a CRM pairing still waiting on a decision. Since pairing is
 * human-service's humanId (deterministic or nothing; LEAD-REFONTE-1013) no pairing waits: always
 * empty. Kept as the resolver's seam; the frozen matcher rows it used to read are records only.
 */
export async function loadUnconfirmedPairingLeads(
  _brandId: string,
  _leadIds: string[],
): Promise<Set<string>> {
  return new Set();
}
