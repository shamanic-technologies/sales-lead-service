/**
 * The engagement BUCKETS a leads list is read through, and the one timestamp that dates a lead.
 *
 * The customer's Leads page offers a tab per bucket, states each tab's count, and lets somebody
 * open one bucket at a time. It used to compute all of that in the browser from the whole
 * population, which is why the page could not exist without a 44 MB response. A bucket is
 * therefore not a display concept: it is a question about a person that only this service can
 * answer, because answering it needs BOTH the delivery evidence (email-gateway, keyed on the
 * lead's registered email) and the outcome ledger (`conversion_events`, keyed on the matched lead)
 * — and this service is the only thing holding both.
 *
 * Two families, deliberately kept apart:
 *
 *  - `contacted`, `website_visit` and `positive_reply` are DELIVERY facts. They come off the same
 *    overlay a list row already carries, at the same scope the read is about, so a bucket count and
 *    the rows the bucket returns can never disagree with the row the table renders.
 *  - the five terminal outcomes (`signup`, `meeting_booked`, `meeting_attended`, `form_submission`,
 *    `sale`) are LEDGER facts — a live, attributed `conversion_events` row, whether the website
 *    tracker reported it or a human stated it. Withdrawn statements are excluded exactly as every
 *    other outcome read excludes them.
 *
 * `website_visit` is the one step measured BOTH ways (see measured-visits.ts): a click the delivery
 * layer measured, and a visit a human stated. Here the two are UNIONED per person rather than
 * summed — this is a population, not a total, so somebody known both ways is one person in the
 * bucket, which is the same guarantee the outcome counts get from suppression.
 *
 * Membership is NOT exclusive: a person who bought was also contacted, and appears in both. The
 * tabs are lenses over one population, not a partition of it.
 */
import type { FlattenedStatus } from "./delivery-flatten.js";
import { LEAD_STEP_OUTCOMES, type LeadStepOutcomeName } from "./step-statements.js";

export const LEAD_BUCKETS = [
  "contacted",
  "website_visit",
  "positive_reply",
  "signup",
  "meeting_booked",
  "meeting_attended",
  "form_submission",
  "sale",
] as const;

export type LeadBucket = (typeof LEAD_BUCKETS)[number];

/** The buckets that are answered from the outcome ledger rather than from delivery evidence. */
export const OUTCOME_BUCKETS: readonly LeadBucket[] = [
  "signup",
  "meeting_booked",
  "meeting_attended",
  "form_submission",
  "sale",
];

/**
 * Resolve the `bucket` query param. Absent → null (no bucket filter; the read is what it is
 * today). Anything not a bucket is a 400 (throws) — never a silent "no filter", which would answer
 * a whole brand to a caller that asked for one tab.
 */
export function parseLeadBucket(raw: unknown): LeadBucket | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") throw new Error("bucket must be a single bucket name");
  const trimmed = raw.trim();
  if ((LEAD_BUCKETS as readonly string[]).includes(trimmed)) return trimmed as LeadBucket;
  throw new Error(`Unknown bucket '${raw}'. Valid: ${LEAD_BUCKETS.join(", ")}`);
}

/** A count per bucket, every key always present — a bucket nobody is in is 0, never absent. */
export function zeroBucketCounts(): Record<LeadBucket, number> {
  return Object.fromEntries(LEAD_BUCKETS.map((b) => [b, 0])) as Record<LeadBucket, number>;
}

/** The live, attributed outcomes one lead holds, as the bucket names they answer to. */
export function outcomeBucketsOf(outcomes: ReadonlySet<LeadStepOutcomeName>): LeadBucket[] {
  return OUTCOME_BUCKETS.filter((b) => outcomes.has(b as LeadStepOutcomeName));
}

/**
 * Every bucket one row belongs to.
 *
 * `delivery` is the row's overlay at the read's scope — all-false for a row that was never served
 * or for a read with no brand/campaign scope, exactly as the list serializes it, so a row that
 * shows no engagement in the table is in no engagement bucket either.
 */
export function bucketsForRow(
  delivery: FlattenedStatus | null,
  outcomes: ReadonlySet<LeadStepOutcomeName>,
  /** A positive reply the outcome ledger holds (their CRM's form submission). Unioned per person. */
  ledgerPositiveReply = false,
): Set<LeadBucket> {
  const buckets = new Set<LeadBucket>();
  if (delivery?.contacted) buckets.add("contacted");
  // The automatic half of a website visit is a CLICK on the email we sent; the hand-stated half is
  // a `website_visit` outcome. One person known both ways is one person in this bucket.
  if (delivery?.clicked || outcomes.has("website_visit")) buckets.add("website_visit");
  if ((delivery?.replied && delivery.replyClassification === "positive") || ledgerPositiveReply) {
    buckets.add("positive_reply");
  }
  for (const b of outcomeBucketsOf(outcomes)) buckets.add(b);
  return buckets;
}

/**
 * WHEN a lead last got as far as it has got — the timestamp that dates its most advanced status.
 *
 * This is what `sort=activity` orders on, newest first: the page shows the people something most
 * recently happened to, and each one is dated by the thing that happened rather than by when we
 * first put them in a buffer. Precedence runs down the funnel, most advanced first: an outcome
 * somebody recorded, then a reply, then a click, then an open, then the send, then the moment the
 * lead was served, and finally the moment the membership row was written.
 *
 * It is NEVER null. A row with no evidence at all still has a `created_at`, so every row has a
 * position and the order over `(activityAt, id)` is total — which is what lets two consecutive
 * page reads neither repeat a lead nor skip one.
 */
export function leadActivityAt(
  delivery: FlattenedStatus | null,
  latestOutcomeAt: string | null,
  servedAt: string | null,
  createdAt: string,
): string {
  return (
    latestOutcomeAt ??
    delivery?.firstRepliedAt ??
    delivery?.firstClickedAt ??
    delivery?.firstOpenedAt ??
    delivery?.firstSentAt ??
    delivery?.firstContactedAt ??
    servedAt ??
    createdAt
  );
}

/** Guard: the bucket vocabulary's outcome half must stay a subset of the outcome vocabulary. */
export function outcomeBucketsAreStepOutcomes(): boolean {
  return OUTCOME_BUCKETS.every((b) =>
    (LEAD_STEP_OUTCOMES as readonly string[]).includes(b as string),
  );
}
