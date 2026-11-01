/**
 * COMPANY-MARK-SERVE-1101: a lead (or its company) the client marked Disqualified for a brand is never SERVED again for
 * that brand, on any pipe (Martian DBB 2026-11-01: "never pursue" named companies, yet colleagues at the same company
 * kept being served). The marks are lead-disqualification.ts's (lead level `lead_disqualification_marks`, company level
 * `company_disqualification_marks`, migration 0078); this module only REFUSES what they name, on the serve path:
 *
 *   - every pool, in SQL, through `reachClauses` / `dueReachClauses` (`disqualifiedClause`, scope REQUIRED);
 *   - a fresh serve, right after filing (buffer.ts, like a journalist: kept filed, the next person bought);
 *   - a named serve (`named_lead_disqualified`, final).
 *
 * Grain = the mark's own: (org, brand, offer). `offer_key ''` = every offer of the brand; a mark naming an offer refuses
 * only a serve for that offer. A serve whose campaign offer is unknown honours the brand-wide marks only.
 *
 * Company = the company KEY the mark was written on (brand-service company id, else `org:<organizations.id>`), matched
 * against EVERY key the lead's company can carry: the lead's `company_id`, its local employer row's `company_id`
 * (a fresh lead is served before the identity sweep fills its own `company_id`), and `org:<organization_id>`. Removing
 * the mark (`withdrawn_at`) serves the company again. Nothing here writes a mark or a list of its own.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import type { JournalistScope } from "./brand-journalists.js";

/** What a serve refuses beside reach: the org, its brand(s) (a `text[]` SQL expression) and the offer served for. */
export interface ServeExclusionScope extends JournalistScope {
  /** A `text` SQL expression: the campaign's offer, NULL = unknown (brand-wide marks only). */
  offerId: SQL;
}

export function serveExclusionScopeOf(orgId: string, brandIds: readonly string[], offerId: string | null): ServeExclusionScope {
  return { orgId: sql`${orgId}`, brandIds: sql`${sql.param([...brandIds])}::text[]`, offerId: sql`${offerId}::text` };
}

/** A live lead-level mark on this lead at the scope (a boolean SQL expression). */
function leadMarked(leadId: SQL, scope: ServeExclusionScope): SQL {
  return sql`EXISTS (
    SELECT 1 FROM lead_disqualification_marks ldm_x
    WHERE ldm_x.lead_id = ${leadId} AND ldm_x.org_id = ${scope.orgId} AND ldm_x.brand_id = ANY(${scope.brandIds})
      AND ldm_x.withdrawn_at IS NULL AND (ldm_x.offer_key = '' OR ldm_x.offer_key = ${scope.offerId}))`;
}

/** A live company-level mark on any key of this lead's company at the scope (a boolean SQL expression). */
function companyMarked(leadId: SQL, scope: ServeExclusionScope): SQL {
  return sql`EXISTS (
    SELECT 1 FROM leads l_x
    LEFT JOIN organizations o_x ON o_x.id = l_x.organization_id
    JOIN company_disqualification_marks cdm_x ON cdm_x.org_id = ${scope.orgId} AND cdm_x.brand_id = ANY(${scope.brandIds})
      AND cdm_x.withdrawn_at IS NULL AND (cdm_x.offer_key = '' OR cdm_x.offer_key = ${scope.offerId})
      AND cdm_x.company_key IN (l_x.company_id::text, o_x.company_id::text, 'org:' || l_x.organization_id::text)
    WHERE l_x.id = ${leadId})`;
}

/** `AND NOT ... AND NOT ...`: no live lead mark on the lead, no live company mark on its company. Every pool carries it. */
export function disqualifiedClause(leadId: SQL, scope: ServeExclusionScope): SQL {
  return sql`AND NOT ${leadMarked(leadId, scope)} AND NOT ${companyMarked(leadId, scope)}`;
}

/** Which mark, if any, refuses serving this lead for these brands (and offer) of the org. */
export async function leadServeDisqualification(
  leadId: string,
  orgId: string,
  brandIds: readonly string[],
  offerId: string | null,
): Promise<{ lead: boolean; company: boolean }> {
  const scope = serveExclusionScopeOf(orgId, brandIds, offerId);
  const id = sql`${leadId}::uuid`;
  const rows = (await db.execute(
    sql`SELECT ${leadMarked(id, scope)} AS lead, ${companyMarked(id, scope)} AS company`,
  )) as unknown as Array<{ lead: boolean; company: boolean }>;
  const r = rows[0];
  if (!r) throw new Error(`[lead-service] disqualification read returned no row for lead ${leadId}`);
  return { lead: r.lead === true, company: r.company === true };
}
