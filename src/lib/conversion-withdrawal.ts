/**
 * A brand's conversion events as the brand's own user sees them, and the person's correction of one
 * (FAKE-OUTCOMES-1022): a signup/sale the website tag reported can be wrongly ATTRIBUTED (a name match, a
 * test of ours). A person withdraws it: `withdrawn_at` + `withdrawn_reason = 'wrong_attribution'` + their
 * words, the same absence every outcome read already honours (`withdrawn_at IS NULL`). Undo stands up only
 * what a person withdrew this way. A person's own step statement is withdrawn through its own route
 * (DELETE /orgs/leads/{id}/step-statements/{step}); a CRM-evidenced row is corrected by ruling on its
 * pairing (the CRM sync would stand it back up).
 */
import { sql } from "../db/index.js";

import { WRONG_ATTRIBUTION_WITHDRAWAL } from "./withdrawal-reasons.js";

export const MAX_WITHDRAWAL_NOTE = 2000;
export const MAX_CONVERSION_LIST = 200;

export interface BrandConversion {
  id: string;
  event: string;
  source: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  receivedAt: string | null;
  valueCents: number | null;
  leadId: string | null;
  matchMethod: string | null;
  matchConfidence: string;
  attributionStatus: string;
  /** Read by the outcome counts: attributed to a lead and not withdrawn. */
  counted: boolean;
  withdrawn: { at: string; byUserId: string | null; reason: string | null; note: string | null } | null;
}

interface Row {
  id: string;
  event: string;
  source: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  received_at: string | null;
  value_cents: number | null;
  matched_lead_id: string | null;
  match_method: string | null;
  match_confidence: string;
  attribution_status: string;
  withdrawn_at: string | null;
  withdrawn_by_user_id: string | null;
  withdrawn_reason: string | null;
  withdrawn_note: string | null;
}

function iso(v: string | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

function toConversion(r: Row): BrandConversion {
  return {
    id: r.id,
    event: r.event,
    source: r.source,
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    receivedAt: iso(r.received_at),
    valueCents: r.value_cents,
    leadId: r.matched_lead_id,
    matchMethod: r.match_method,
    matchConfidence: r.match_confidence,
    attributionStatus: r.attribution_status,
    counted: r.attribution_status === "attributed" && r.withdrawn_at === null,
    withdrawn:
      r.withdrawn_at === null
        ? null
        : { at: iso(r.withdrawn_at)!, byUserId: r.withdrawn_by_user_id, reason: r.withdrawn_reason, note: r.withdrawn_note },
  };
}

const columns = () => sql`
  id::text AS id, event, source, email, first_name, last_name, received_at::text AS received_at, value_cents,
  matched_lead_id::text AS matched_lead_id, match_method, match_confidence, attribution_status,
  withdrawn_at::text AS withdrawn_at, withdrawn_by_user_id, withdrawn_reason, withdrawn_note
`;

/** Newest first. `leadId` = the lead's own id; `email` matched case-folded. */
export async function listBrandConversions(p: {
  orgId: string;
  brandId: string;
  event: string | null;
  leadId: string | null;
  email: string | null;
  limit: number;
}): Promise<BrandConversion[]> {
  const rows = (await sql`
    SELECT ${columns()}
    FROM conversion_events
    WHERE org_id = ${p.orgId} AND brand_id = ${p.brandId}
      ${p.event ? sql`AND event = ${p.event}` : sql``}
      ${p.leadId ? sql`AND matched_lead_id = ${p.leadId}::uuid` : sql``}
      ${p.email ? sql`AND lower(email) = ${p.email.toLowerCase()}` : sql``}
    ORDER BY received_at DESC NULLS LAST, created_at DESC, id
    LIMIT ${p.limit}
  `) as unknown as Row[];
  return rows.map(toConversion);
}

export async function getBrandConversion(orgId: string, brandId: string, id: string): Promise<BrandConversion | null> {
  const rows = (await sql`
    SELECT ${columns()} FROM conversion_events
    WHERE id = ${id}::uuid AND org_id = ${orgId} AND brand_id = ${brandId}
  `) as unknown as Row[];
  return rows[0] ? toConversion(rows[0]) : null;
}

export type WithdrawOutcome =
  | { kind: "withdrawn"; conversion: BrandConversion }
  | { kind: "already_withdrawn"; conversion: BrandConversion }
  | { kind: "not_found" }
  | { kind: "refused"; code: "crm_evidence" | "use_step_statements"; conversion: BrandConversion };

/** Refusal per source: what a person corrects elsewhere. */
function refusalOf(c: BrandConversion): "crm_evidence" | "use_step_statements" | null {
  if (c.source === "crm") return "crm_evidence";
  if (c.source === "manual") return "use_step_statements";
  return null;
}

export async function withdrawConversion(p: {
  orgId: string;
  brandId: string;
  id: string;
  userId: string;
  note: string;
}): Promise<WithdrawOutcome> {
  const current = await getBrandConversion(p.orgId, p.brandId, p.id);
  if (!current) return { kind: "not_found" };
  const refusal = refusalOf(current);
  if (refusal) return { kind: "refused", code: refusal, conversion: current };
  const rows = (await sql`
    UPDATE conversion_events
    SET withdrawn_at = now(), withdrawn_by_user_id = ${p.userId},
        withdrawn_reason = ${WRONG_ATTRIBUTION_WITHDRAWAL}, withdrawn_note = ${p.note}
    WHERE id = ${p.id}::uuid AND org_id = ${p.orgId} AND brand_id = ${p.brandId} AND withdrawn_at IS NULL
    RETURNING id
  `) as unknown as unknown[];
  const after = (await getBrandConversion(p.orgId, p.brandId, p.id))!;
  return rows.length > 0 ? { kind: "withdrawn", conversion: after } : { kind: "already_withdrawn", conversion: after };
}

export type RestoreOutcome =
  | { kind: "restored"; conversion: BrandConversion }
  | { kind: "not_found" }
  | { kind: "not_withdrawn_by_a_person"; conversion: BrandConversion };

/**
 * Undo a person's withdrawal. Only `wrong_attribution` is a person's to undo; a staff identity or a
 * not-a-person mark sets a row aside on facts, not on a click. A lead marked since is set aside again
 * by the trigger, which the answer shows.
 */
export async function restoreConversion(p: { orgId: string; brandId: string; id: string }): Promise<RestoreOutcome> {
  const current = await getBrandConversion(p.orgId, p.brandId, p.id);
  if (!current) return { kind: "not_found" };
  if (current.withdrawn?.reason !== WRONG_ATTRIBUTION_WITHDRAWAL) {
    return { kind: "not_withdrawn_by_a_person", conversion: current };
  }
  await sql`
    UPDATE conversion_events
    SET withdrawn_at = NULL, withdrawn_by_user_id = NULL, withdrawn_reason = NULL, withdrawn_note = NULL
    WHERE id = ${p.id}::uuid AND org_id = ${p.orgId} AND brand_id = ${p.brandId}
      AND withdrawn_reason = ${WRONG_ATTRIBUTION_WITHDRAWAL}
  `;
  return { kind: "restored", conversion: (await getBrandConversion(p.orgId, p.brandId, p.id))! };
}
