/**
 * The engagement view of a scoped population: which buckets each person is in, and when something
 * last happened to them.
 *
 * It reads the same two sources a list row reads — the delivery overlay and this service's own
 * outcome ledger — over the index rather than over the full projection. The read model
 * (lead-read-model.ts) runs it when it builds or recomputes rows, so what a tab counts and what the
 * list overlays onto a row are derived by one piece of code.
 */
import { toIsoTimestamp } from "./basic-leads.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { DEFAULT_STATUS, type FlattenedStatus } from "./delivery-flatten.js";
import { bucketsForRow, leadActivityAt, type LeadBucket } from "./lead-buckets.js";
import { fetchOutcomesByLead, type LeadIndexRow, type LeadOutcomes } from "./lead-index.js";
import type { LeadStandingState } from "./lead-standing.js";
import type { LeadStepOutcomeName } from "./step-statements.js";

/** One index row plus everything derived from evidence about that person. */
export interface EnrichedLeadIndexRow extends LeadIndexRow {
  buckets: Set<LeadBucket>;
  /** Never null — see leadActivityAt. */
  activityAt: string;
  /**
   * The delivery overlay this row's buckets were read from, collapsed to the read's scope — the
   * SAME object a list row serializes. Kept on the row because where a lead STANDS is read from it
   * too (a click is the measured half of a website visit), and reading it twice would be a second
   * gateway fan-out answering a question the first one already answered.
   */
  delivery: FlattenedStatus;
  /**
   * Where this person stands on this campaign, attached AFTER enrichment by the caller that asked
   * for it (see lead-standing-index.ts). Absent when nothing asked — a standing costs a
   * campaign-service read and two indexed queries per chunk, and a read that only buckets or
   * searches must not pay for it.
   */
  standing?: LeadStandingState;
  /**
   * Where on the funnel a `sales_interest` lead stands (`salesInterestStage`), attached with the
   * standing and null for every other state.
   */
  stage?: string | null;
}

/** The identity context email-gateway is called with — the same one the list calls it with. */
export type DeliveryContext = Parameters<typeof checkDeliveryStatus>[3];

export interface EngagementContext {
  /** Identity headers forwarded to email-gateway, exactly as the list forwards them. */
  serviceContext: DeliveryContext;
  /** The campaign the delivery answer is scoped to, or undefined for brand scope. */
  statusCampaignId: string | undefined;
  /** How a gateway answer is collapsed to the read's scope — the SAME flatten the list uses. */
  flatten: (result: StatusResult) => FlattenedStatus;
  /** Whether the read named a scope at all. Unscoped ⟹ no delivery evidence is fetched, as on the list. */
  deliveryQueried: boolean;
  orgId: string;
  brandId: string | undefined;
}

/**
 * Every index row, with its buckets and its activity timestamp.
 *
 * `deliveryByEmail` is the raw email-gateway answer per address, supplied by the caller (the read
 * model reads it through the evidence cache, lead-delivery-evidence.ts) — this function decides
 * nothing about where evidence comes from or how old it may be, only what it MEANS for a row.
 *
 * `withEvidence: false` skips both sources — rows then carry no buckets and are dated by their
 * served/created timestamp.
 */
export async function enrichLeadIndex(
  rows: readonly LeadIndexRow[],
  ctx: EngagementContext,
  withEvidence: boolean,
  deliveryByEmail: ReadonlyMap<string, StatusResult> = new Map(),
): Promise<EnrichedLeadIndexRow[]> {
  if (!withEvidence) {
    return rows.map((row) => ({
      ...row,
      buckets: new Set<LeadBucket>(),
      delivery: DEFAULT_STATUS,
      activityAt: leadActivityAt(null, null, row.servedAt, isoCreatedAt(row.createdAtText)),
    }));
  }

  const outcomesByLead = await fetchOutcomesByLead(
    ctx.orgId,
    ctx.brandId,
    rows.map((r) => r.leadId),
  );

  const noOutcomes: LeadOutcomes = { steps: new Set<LeadStepOutcomeName>(), latestAt: null };

  return rows.map((row) => {
    const result = row.email ? deliveryByEmail.get(row.email) : undefined;
    // Same rule as the list: evidence only counts for a SERVED row in a named scope, so a row
    // that shows no engagement in the table is in no engagement bucket either.
    const delivery =
      ctx.deliveryQueried && row.status === "served"
        ? result
          ? ctx.flatten(result)
          : DEFAULT_STATUS
        : DEFAULT_STATUS;
    const outcomes = outcomesByLead.get(row.leadId) ?? noOutcomes;
    return {
      ...row,
      buckets: bucketsForRow(delivery, outcomes.steps, outcomes.positiveReply === true),
      delivery,
      activityAt: leadActivityAt(delivery, outcomes.latestAt, row.servedAt, isoCreatedAt(row.createdAtText)),
    };
  });
}

/**
 * `created_at::text` is Postgres's spelling of an instant; every other timestamp folded into an
 * activity position is ISO. They are compared as instants, so the fallback is normalized here
 * rather than leaving one of them in a different alphabet.
 */
function isoCreatedAt(createdAtText: string): string {
  return toIsoTimestamp(createdAtText)!;
}
