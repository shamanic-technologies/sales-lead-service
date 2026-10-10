/**
 * WHO was handed to a rep on a booking call — the `booking_call` bucket's evidence.
 *
 * AI Instant Call (leg `conversation_to_booking_call`) rings the brand's rep the moment a reply is
 * qualified as a sales interest. instantly-service places the call and records the act here
 * through the by-email door (followup-actions.ts `recordActedByEmail`): an `acted` row in the
 * follow-up ledger, `acting_campaign_id` = the AI Instant Call campaign. That row IS the fact "a
 * booking call was placed with this person"; nothing else in the fleet holds it per person.
 *
 * Which acting campaigns place booking calls is read off campaign-service's `legKey`, never off the
 * ledger row's `source` (the by-email door is a door, not a leg; a backfilled ring carries another
 * source) and never off the campaign's feature slug. campaign-service is asked only when at least
 * one of the people holds an `acted` row at all, so a brand that never ran the leg costs one
 * indexed query and no network call.
 *
 * A person, not a row: membership keys on the lead at the org (and brand when the read names one),
 * like every outcome bucket. FAIL LOUD: campaign-service unreachable throws
 * (`CampaignLegsUnavailableError`), never "nobody got a call".
 */
import { sql } from "../db/index.js";
import { fetchOrgCampaignLegs } from "./campaign-leg-client.js";

/** The leg whose act is a booking call placed with the person. Compared whole, never parsed. */
export const BOOKING_CALL_LEG_KEY = "conversation_to_booking_call";

export async function fetchBookingCallLeadIds(
  orgId: string,
  brandId: string | undefined,
  leadIds: readonly string[],
): Promise<Set<string>> {
  const called = new Set<string>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return called;

  const rows = await sql<Array<{ lead_id: string; acting_campaign_id: string }>>`
    SELECT DISTINCT fa.lead_id::text AS lead_id, fa.acting_campaign_id
    FROM followup_actions fa
    WHERE fa.org_id = ${orgId}
      AND fa.action = 'acted'
      AND fa.acting_campaign_id IS NOT NULL
      AND fa.lead_id = ANY(${ids}::uuid[])
      ${brandId ? sql`AND fa.brand_ids @> ARRAY[${brandId}]::text[]` : sql``}
  `;
  if (rows.length === 0) return called;

  const legs = await fetchOrgCampaignLegs({ orgId });
  for (const row of rows) {
    if (legs.get(row.acting_campaign_id) === BOOKING_CALL_LEG_KEY) called.add(row.lead_id);
  }
  return called;
}
