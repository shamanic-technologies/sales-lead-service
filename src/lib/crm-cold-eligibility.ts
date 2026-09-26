/**
 * The two reads the went-cold rule (`lead-cold.ts`) needs about the customer's CRM.
 *
 *   - Is the brand's CRM USABLE as evidence that a step did not happen? Read from crm-service, which
 *     owns the connection and what each pipeline stage means: connected and active, synced within
 *     CRM_SYNC_MAX_AGE_MS, its last sync not failing, and at least one stage resolved (and served as
 *     evidence) to the step whose absence the rule reads.
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
import { loadJudgments, loadRulings, rulingKey } from "./crm-pairing-store.js";
import { resolveCrmPairing } from "./crm-pairing.js";
import type { MatchConfidence, MatchMethod } from "./conversions.js";
import {
  CRM_COLD_INELIGIBLE,
  type CrmColdEligibility,
} from "./lead-cold.js";

/** A CRM not synced for longer than this is not current enough to prove an absence. */
export const CRM_SYNC_MAX_AGE_MS = 48 * 60 * 60 * 1000;

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
  const paired = (await db.execute(sql`
    SELECT 1 AS hit FROM crm_pairing_matches WHERE brand_id = ${brandId} AND org_id = ${orgId} LIMIT 1
  `)) as unknown as Array<{ hit: number }>;
  if (paired.length === 0) {
    value = CRM_COLD_INELIGIBLE("crm_never_paired");
    cache.set(key, { at: now.getTime(), value });
    return value;
  }
  try {
    const connection = await fetchCrmConnection(brandId, { orgId, brandId });
    if (!connection) value = CRM_COLD_INELIGIBLE("no_crm_connection");
    else if (connection.status !== "active") value = CRM_COLD_INELIGIBLE("crm_not_active");
    else if (!connection.synced || !connection.lastSyncedAt) value = CRM_COLD_INELIGIBLE("crm_not_synced");
    else if (connection.lastError) value = CRM_COLD_INELIGIBLE("crm_sync_failing");
    else if (now.getTime() - Date.parse(connection.lastSyncedAt) > CRM_SYNC_MAX_AGE_MS) {
      value = CRM_COLD_INELIGIBLE("crm_sync_stale");
    } else {
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
    SELECT DISTINCT org_id FROM crm_pairing_matches WHERE brand_id = ${brandId}
  `)) as unknown as Array<{ org_id: string }>;
  return rows.map((r) => r.org_id);
}

/**
 * The subset of `leadIds` that some CRM contact of `brandId` is a candidate for, with that pairing
 * still `unconfirmed` (no judgment yet, or one that could not be had).
 */
export async function loadUnconfirmedPairingLeads(
  brandId: string,
  leadIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT crm_contact_id, matched_lead_id, match_method, match_confidence, candidate_count
    FROM crm_pairing_matches
    WHERE brand_id = ${brandId}
      AND matched_lead_id = ANY(${sql.param(leadIds)}::uuid[])
  `)) as unknown as Array<{
    crm_contact_id: string;
    matched_lead_id: string;
    match_method: string | null;
    match_confidence: MatchConfidence;
    candidate_count: number;
  }>;
  if (rows.length === 0) return out;

  const contactIds = rows.map((r) => r.crm_contact_id);
  const [judgments, rulings] = await Promise.all([
    loadJudgments(brandId, contactIds),
    loadRulings(brandId, contactIds),
  ]);
  for (const r of rows) {
    const stored = judgments.get(r.crm_contact_id) ?? null;
    const verdict = resolveCrmPairing({
      signal: {
        matchedLeadId: r.matched_lead_id,
        matchMethod: r.match_method as MatchMethod,
        matchConfidence: r.match_confidence,
        candidateCount: Number(r.candidate_count) || 0,
      },
      judgment:
        stored && stored.leadId === r.matched_lead_id
          ? {
              samePersonProbability: stored.samePersonProbability,
              model: stored.model,
              judgedAt: stored.judgedAt,
            }
          : null,
      judgmentUnavailableReason: null,
      ruling: rulings.get(rulingKey(r.crm_contact_id, r.matched_lead_id)) ?? null,
    });
    if (verdict.state === "unconfirmed") out.add(r.matched_lead_id);
  }
  return out;
}
