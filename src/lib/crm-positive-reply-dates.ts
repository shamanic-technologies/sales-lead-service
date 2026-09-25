import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";

/**
 * When the customer's OWN CRM evidences a positive reply to our outreach, per (brand, lead).
 *
 * The CRM evidence pass (crm-evidence-sync.ts) writes one `conversion_events` row per (brand, lead)
 * with `event = 'positive_reply'`, `source = 'crm'` and `lead_campaign_id` NULL, dated by the CRM's
 * own form submission — the earliest one strictly after our first delivered email. It is the same
 * FACT as a reply the delivery layer classified positive, so everything that counts positive replies
 * must see it. `view=compact` (and the change feed that keeps a copy of it) carries it as
 * `crmPositiveReplyAt` so a consumer computing figures over a brand's population — features-service
 * above all — counts it exactly like an email reply, per person, without re-deriving it.
 *
 * Only live, attributed rows: a statement its author withdrew, or a pairing a human denied (which
 * withdraws what it contributed), is not a reply.
 *
 * Keyed `${brandId}:${leadId}`, earliest date wins. An empty input asks nothing.
 */
export async function fetchCrmPositiveReplyDates(
  rows: readonly { leadId: string; brandIds: readonly string[] }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const leadIds = [...new Set(rows.map((r) => r.leadId))];
  const brandIds = [...new Set(rows.flatMap((r) => r.brandIds))];
  if (leadIds.length === 0 || brandIds.length === 0) return out;

  const found = await sql<Array<{ brand_id: string; lead_id: string; at: Date | string | null }>>`
    SELECT ce.brand_id, ce.matched_lead_id AS lead_id, min(ce.received_at) AS at
    FROM conversion_events ce
    WHERE ce.event = ${CRM_POSITIVE_REPLY_STEP}
      AND ce.source = 'crm'
      AND ce.attribution_status = 'attributed'
      AND ce.withdrawn_at IS NULL
      AND ce.brand_id = ANY(${brandIds}::text[])
      AND ce.matched_lead_id = ANY(${leadIds}::uuid[])
    GROUP BY ce.brand_id, ce.matched_lead_id
  `;
  for (const r of found) {
    const at = toIsoTimestamp(r.at);
    if (at) out.set(`${r.brand_id}:${r.lead_id}`, at);
  }
  return out;
}

/**
 * The CRM positive-reply date that applies to one lead row: the earliest across the row's brands.
 * Null when the customer's CRM evidences no positive reply for this person.
 */
export function crmPositiveReplyAtFor(
  dates: ReadonlyMap<string, string>,
  row: { leadId: string; brandIds: readonly string[] },
): string | null {
  let best: string | null = null;
  for (const brandId of row.brandIds) {
    const at = dates.get(`${brandId}:${row.leadId}`);
    if (at && (best === null || at < best)) best = at;
  }
  return best;
}
