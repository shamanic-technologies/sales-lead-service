/**
 * The engagement view of a whole scoped population: which buckets each person is in, and when
 * something last happened to them.
 *
 * This is the pass that lets the Leads page state its tab counts, open one tab, and order by
 * recency without ever holding the population. It reads the same two sources a list row reads —
 * the delivery overlay from email-gateway and this service's own outcome ledger — over the index
 * rather than over the full projection, so it costs the network calls the list already made and
 * none of the hydration, the audience resolution or the serialization.
 *
 * Fail loud in both directions: email-gateway unreachable rejects (the caller answers 502) rather
 * than reporting a bucket count of zero, which is a wrong number nothing would ever go red about.
 */
import { toIsoTimestamp } from "./basic-leads.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { DEFAULT_STATUS, type FlattenedStatus } from "./delivery-flatten.js";
import {
  bucketsForRow,
  leadActivityAt,
  zeroBucketCounts,
  type LeadBucket,
} from "./lead-buckets.js";
import { fetchOutcomesByLead, type LeadIndexRow } from "./lead-index.js";
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

/** How many emails one gateway request carries, and how many such requests run at once. */
const EMAILS_PER_REQUEST = 100;
const REQUEST_CONCURRENCY = 6;

/** Run `task` over `items` at most `limit` at a time. Rejects on the first failure, like Promise.all. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The delivery answer for every served row that has an email, keyed by email.
 *
 * Grouped by the row's primary brand exactly as the list groups it, then split into bounded
 * batches: a large brand is tens of thousands of addresses and firing one request per hundred all
 * at once would be a burst nobody asked for.
 */
async function fetchDeliveryByEmail(
  rows: readonly LeadIndexRow[],
  ctx: EngagementContext,
): Promise<Map<string, StatusResult>> {
  const byEmail = new Map<string, StatusResult>();
  if (!ctx.deliveryQueried) return byEmail;

  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status !== "served") continue;
    if (!row.email) continue;
    const brandId = row.brandIds[0] ?? "unknown";
    if (!groups.has(brandId)) groups.set(brandId, new Set());
    groups.get(brandId)!.add(row.email);
  }

  const requests: Array<{ brandId: string; emails: string[] }> = [];
  for (const [brandId, emails] of groups) {
    const list = [...emails];
    for (let i = 0; i < list.length; i += EMAILS_PER_REQUEST) {
      requests.push({ brandId, emails: list.slice(i, i + EMAILS_PER_REQUEST) });
    }
  }

  const responses = await mapWithConcurrency(requests, REQUEST_CONCURRENCY, (request) =>
    checkDeliveryStatus(
      request.brandId,
      ctx.statusCampaignId,
      request.emails.map((email) => ({ email })),
      ctx.serviceContext,
    ),
  );

  for (const response of responses) {
    for (const result of response.results) byEmail.set(result.email, result);
  }
  return byEmail;
}

/**
 * Every index row, with its buckets and its activity timestamp.
 *
 * `withEvidence: false` skips both lookups entirely — a read that only SEARCHES needs neither, and
 * paying for a population-wide gateway fan-out to answer a search would be the same waste in a
 * different place. Rows then carry no buckets and are dated by their served/created timestamp,
 * which is all the default order asks of them.
 */
export async function enrichLeadIndex(
  rows: readonly LeadIndexRow[],
  ctx: EngagementContext,
  withEvidence: boolean,
): Promise<EnrichedLeadIndexRow[]> {
  if (!withEvidence) {
    return rows.map((row) => ({
      ...row,
      buckets: new Set<LeadBucket>(),
      delivery: DEFAULT_STATUS,
      activityAt: leadActivityAt(null, null, row.servedAt, isoCreatedAt(row.createdAtText)),
    }));
  }

  const [deliveryByEmail, outcomesByLead] = await Promise.all([
    fetchDeliveryByEmail(rows, ctx),
    fetchOutcomesByLead(
      ctx.orgId,
      ctx.brandId,
      rows.map((r) => r.leadId),
    ),
  ]);

  const noOutcomes = { steps: new Set<LeadStepOutcomeName>(), latestAt: null as string | null };

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
      buckets: bucketsForRow(delivery, outcomes.steps),
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

/**
 * Add one chunk's rows to a running bucket tally.
 *
 * Incremental rather than whole-population on purpose: the counters are the ONLY thing that
 * survives a chunk, so a count over a brand of any size costs the same O(1) of this process's heap
 * (see lead-plan-store.ts for what the array form cost). Every bucket key is present in the tally
 * from the start; a bucket nobody is in stays 0, never absent.
 */
export function addBucketCounts(
  counts: Record<LeadBucket, number>,
  rows: readonly EnrichedLeadIndexRow[],
): Record<LeadBucket, number> {
  for (const row of rows) {
    for (const bucket of row.buckets) counts[bucket] += 1;
  }
  return counts;
}
