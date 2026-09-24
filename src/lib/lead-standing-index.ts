/**
 * Where a whole scoped population STANDS: one standing per person, over the lean index, so a
 * triage board can state each column's size and open one column without holding the population.
 *
 * The board the customer's Leads page draws is partitioned by STANDING — still in play, sales
 * interest, disqualified, opted out — and this service is the only thing that can answer it: the
 * policy is authored here (lead-standing.ts), it is funnel-aware, and it reads both the delivery
 * evidence and the hand-stated statements. A consumer that pulls a page of leads and sorts the
 * cards into columns in the browser states, per column, how many of the FETCHED rows landed there
 * — which is a different number from how many people are in that state, and it is stated beside
 * the real population size on the same screen.
 *
 * So the standings are resolved the SAME way the list resolves them — `createLeadStandingResolver`,
 * one campaign-service read for the whole request, two indexed queries per chunk — over the index
 * rather than over the full projection. A count taken here and a page taken from the list therefore
 * describe the same population by construction, because they are the same rows, the same delivery
 * overlay and the same resolver.
 *
 * A row whose standing the resolver could not answer for reads as `unresolved`, exactly as it does
 * on the list. That is a stated non-answer, never a plausible default, and it is a COUNTED state:
 * a board that silently drops the leads nobody could resolve is a board whose columns do not add
 * up to the population it says it is showing.
 */
import type { FlattenedStatus } from "./delivery-flatten.js";
import type { EnrichedLeadIndexRow } from "./lead-engagement.js";
import type { LeadStandingResolver, StandingRow } from "./lead-standing-resolver.js";
import { salesInterestStage, type LeadStandingDelivery } from "./lead-standing.js";

/**
 * How many rows one resolver call covers. The resolver's two reads bind their lead ids as an
 * array, so a whole 57k-row brand in one call is one enormous bind; a bounded chunk keeps each
 * query the shape Postgres plans well, at the cost of a few more round trips.
 */
export const STANDING_RESOLVE_CHUNK_SIZE = 1_000;

/**
 * The delivery half of a standing, read off the overlay a row already carries. No second source:
 * whatever scope the engagement fields answer for, the standing answers for.
 */
export function standingDelivery(status: FlattenedStatus): LeadStandingDelivery {
  return {
    contacted: status.contacted,
    opened: status.opened,
    clicked: status.clicked,
    replied: status.replied,
    replyClassification: status.replyClassification,
    disqualified: status.disqualified,
    bounced: status.bounced,
    unsubscribed: status.unsubscribed,
    globalBounced: status.global.bounced,
    globalUnsubscribed: status.global.unsubscribed,
  };
}

/**
 * Attach a standing to every enriched index row, in bounded chunks.
 *
 * FAIL LOUD ON THE READ, not on the field: the resolver already answers `unresolved` with a reason
 * when campaign-service cannot say which funnel a campaign sells, so a genuine throw here is
 * something else entirely (the statements could not be read at all) and it propagates — a count
 * that silently reports a brand as entirely unresolved is a wrong number nothing would go red
 * about. The list read takes the opposite posture deliberately, because there a standing is one
 * field of a 57k-row walk; here it IS the answer.
 */
export async function attachLeadStandings(
  rows: EnrichedLeadIndexRow[],
  resolver: LeadStandingResolver,
): Promise<EnrichedLeadIndexRow[]> {
  for (let i = 0; i < rows.length; i += STANDING_RESOLVE_CHUNK_SIZE) {
    const slice = rows.slice(i, i + STANDING_RESOLVE_CHUNK_SIZE);
    const standingRows: StandingRow[] = slice.map((row) => ({
      id: row.id,
      leadId: row.leadId,
      campaignId: row.campaignId,
      brandIds: row.brandIds,
      status: row.status,
      delivery: standingDelivery(row.delivery),
    }));
    const resolved = await resolver.resolve(standingRows);
    for (const row of slice) {
      const standing = resolved.get(row.id)?.standing;
      row.standing = standing?.state ?? "unresolved";
      row.stage = standing ? salesInterestStage(standing) : null;
    }
  }
  return rows;
}
