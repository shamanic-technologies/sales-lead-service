import { sql } from "drizzle-orm";
import { sql as pgSql } from "../db/index.js";
import {
  checkDeliveryStatus,
  checkEmailStatus,
  type DeliveryStatusItem,
  type EmailCheckResult,
} from "./email-gateway-client.js";

const RACE_WINDOW_MINUTES = 60;
const BRAND_DEDUP_TTL_MONTHS = 6;

/**
 * Cross-campaign brand dedup: has this lead (by leadId / email / apolloPersonId)
 * already been served for any brand that overlaps this campaign's brandIds, within the TTL window?
 *
 * Operates on leads_campaigns (status='served') joined to lead_contact_methods (for email lookup)
 * and leads (for apollo_person_id).
 */
export async function isAlreadyServedForBrand(params: {
  orgId: string;
  brandIds: string[];
  leadId?: string | null;
  email?: string | null;
  apolloPersonId?: string | null;
}): Promise<{ blocked: boolean; reason?: string }> {
  if (params.brandIds.length === 0) return { blocked: false };

  const brandIdsArray = `{${params.brandIds.join(",")}}`;

  const conditions: string[] = [];
  const values: unknown[] = [params.orgId, brandIdsArray];
  let paramIdx = 3;

  if (params.leadId) {
    conditions.push(`lc.lead_id = $${paramIdx}`);
    values.push(params.leadId);
    paramIdx++;
  }
  if (params.email) {
    conditions.push(
      `EXISTS (SELECT 1 FROM lead_contact_methods m WHERE m.lead_id = lc.lead_id AND m.channel = 'email' AND m.value = $${paramIdx})`,
    );
    values.push(params.email);
    paramIdx++;
  }
  if (params.apolloPersonId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM leads l WHERE l.id = lc.lead_id AND l.apollo_person_id = $${paramIdx})`,
    );
    values.push(params.apolloPersonId);
    paramIdx++;
  }

  if (conditions.length === 0) return { blocked: false };

  const rows = await pgSql.unsafe(
    `SELECT lc.lead_id
     FROM leads_campaigns lc
     WHERE lc.org_id = $1
       AND lc.status = 'served'
       AND lc.brand_ids && $2::text[]
       AND lc.served_at >= now() - interval '${BRAND_DEDUP_TTL_MONTHS} months'
       AND (${conditions.join(" OR ")})
     LIMIT 1`,
    values as string[],
  );

  if (rows.length > 0) {
    return {
      blocked: true,
      reason: "already served for overlapping brand",
    };
  }
  return { blocked: false };
}

/**
 * Race window: another claim/serve for the same email + overlapping brand happened within
 * RACE_WINDOW_MINUTES. Used to avoid double-serving when concurrent pullNext run.
 */
export async function checkRaceWindow(params: {
  orgId: string;
  brandIds: string[];
  email: string;
  excludeLeadCampaignId: string;
}): Promise<boolean> {
  if (params.brandIds.length === 0) return false;
  const brandIdsArray = `{${params.brandIds.join(",")}}`;

  const rows = await pgSql.unsafe(
    `SELECT 1 FROM leads_campaigns lc
     JOIN lead_contact_methods m ON m.lead_id = lc.lead_id AND m.channel = 'email'
     WHERE lc.org_id = $1
       AND lc.brand_ids && $2::text[]
       AND m.value = $3
       AND lc.status IN ('claimed', 'served')
       AND lc.created_at >= now() - interval '${RACE_WINDOW_MINUTES} minutes'
       AND lc.id != $4
     LIMIT 1`,
    [params.orgId, brandIdsArray, params.email, params.excludeLeadCampaignId],
  );
  return rows.length > 0;
}

/**
 * email-gateway lookup: contacted/bounced/unsubscribed status per email.
 * Throws if email-gateway unreachable — fail loud, no silent fallback.
 */
export async function checkContacted(
  brandIds: string[],
  campaignId: string,
  items: DeliveryStatusItem[],
  context?: {
    orgId?: string;
    userId?: string;
    runId?: string;
    campaignId?: string;
    brandId?: string;
    workflowSlug?: string;
    featureSlug?: string;
    goal?: string;
    activeGoalId?: string;
    brandProfileId?: string;
    customerPersonaId?: string;
    customerProfileId?: string;
  },
): Promise<Map<string, EmailCheckResult>> {
  const result = new Map<string, EmailCheckResult>();

  const primaryBrandId = brandIds[0];
  if (!primaryBrandId) {
    throw new Error("[lead-service] No brand IDs provided — cannot check delivery status");
  }

  const statusResponse = await checkDeliveryStatus(primaryBrandId, campaignId, items, context);

  if (!statusResponse) {
    throw new Error("[lead-service] email-gateway unreachable — refusing to serve without delivery check");
  }

  for (const sr of statusResponse.results) {
    result.set(sr.email, checkEmailStatus(sr));
  }
  return result;
}

// Re-export sql for any callers that still want it.
export { sql };
