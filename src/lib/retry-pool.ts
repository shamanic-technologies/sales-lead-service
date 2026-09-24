import { and, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";

/**
 * Drain the already-paid pool before buying more people.
 *
 * A person served by this service has been paid for (apollo/apify enrichment) and is
 * immediately suppressed for three months in human-service, which is correct: that
 * suppression is a PRE-payment guard, it stops us re-buying a person we already own.
 * So when a step AFTER the serve fails — email generation, the vendor push, anything —
 * the person is never contacted, never retried, and never comes back through
 * `serveNext`. The brand paid for a prospect it can no longer reach. Measured once on
 * 2026-08-25: 155 served, 22 handed to the vendor, 133 stranded, $18.41 of apollo
 * credit spent on people nobody emailed. It was the second occurrence of the shape.
 *
 * The gap is on THIS side, so the fix is here: before asking human-service for someone
 * new, look at this campaign's own non-terminal serves, ask email-gateway whether they
 * ever reached the vendor, and hand back one we already paid for.
 *
 * Four verdicts, three flags, one TTL — see `decideRetry` for the table.
 *
 * The SENDER is the only one who knows whether it still holds a lead. Until 2026-09 it
 * did not say, so this pool guessed from age: contacted, not sent, older than the TTL ⟹
 * lost. That guess was wrong exactly when it mattered: instantly-service's send queue
 * backlogged past five days, every lead in it read as lost, and each was re-served —
 * straight into an idempotent duplicate on the vendor side that sent nothing. One
 * campaign made 1,643 send attempts over 145 people in a day (one person re-served 38
 * times) and new-lead serves fell from ~400/day to ~50, because every re-serve takes the
 * run slot that would have bought someone new. The sender now states `queued`; that
 * statement decides, and the age guess only applies where the sender says it holds
 * nothing.
 */

/**
 * How long the vendor may legitimately sit on a queued lead before we call it lost.
 *
 * Five days, not three. The `/status` response carries booleans and no timestamps, so
 * the clock runs from our own `served_at`. A lead queued Friday 18:00 leaves Monday
 * 08:00 inside the vendor's business-hours window (~62h) and a bank-holiday Monday
 * pushes that past three days. The error is asymmetric: too long strands a lead, which
 * is recoverable; too short sends a SECOND email to a human who is still queued, which
 * is not, and costs deliverability and the customer's brand. Round up.
 */
export const RETRY_QUEUE_TTL_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * How long a claim holds a row before another run may take it.
 *
 * The claim exists so two concurrent pulls cannot hand the same person to two runs. It
 * must also EXPIRE: the whole point of this pool is that the step after the serve can
 * fail, and a claim that never released would strand the person a second time — this
 * time permanently and by our own hand. An hour comfortably exceeds the downstream
 * generate-and-push leg while keeping a failed run's person retryable the same day.
 */
export const RETRY_CLAIM_LEASE_MS = 60 * 60 * 1000;

/**
 * How many of the campaign's oldest non-terminal serves we look at per pull.
 *
 * This is what keeps the email-gateway call a fixed size whatever the campaign's age:
 * one batched campaign-scoped call for at most this many emails, which is inside the
 * client's own 100-per-request batch, so it is always exactly one HTTP call. Anyone
 * beyond the batch is not lost — `sent` rows leave the pool for good and the ordering
 * moves a repeatedly-failing person to the back, so the window walks forward.
 */
export const RETRY_CANDIDATE_BATCH_SIZE = 50;

/** What the two email-gateway flags say we should do with a candidate. */
export type RetryVerdict =
  /** Paid for, never handed to the vendor (or the vendor lost it). Serve this person again. */
  | "retry"
  /** The vendor holds it inside its own sending window. Leave it alone. */
  | "in_vendor_queue"
  /**
   * We cannot tell whether the sender still holds this person (it stated nothing, or it
   * did not answer). Leave it alone: guessing "lost" is how a lead gets re-served on top
   * of a queued one, and a person nobody re-serves today is still here tomorrow.
   */
  | "unknown"
  /** An email went out. This person is done — mark locally, never query again. */
  | "terminal";

/** The two flags email-gateway already serves per scope, for one candidate. */
export interface CandidateStatusFlags {
  /** Broadcast-side `contacted` means the lead was pushed to the vendor, i.e. queued. */
  contacted: boolean;
  /** An email actually went out. Terminal. */
  sent: boolean;
  /**
   * The sender's own statement that it still holds this person in its send queue.
   * `null` = the sender stated nothing (no broadcast answer, or a payload without the
   * field) — never read as `false`.
   */
  queued: boolean | null;
}

export interface RetryCandidate {
  /** `leads_campaigns.id` — the lifecycle row, which is what gets claimed. */
  id: string;
  leadId: string;
  email: string;
  /** Raw `timestamptz`: postgres.js hands these back as `Date` OR `string`. */
  servedAt: Date | string | null;
  audienceId: string | null;
  goal: string | null;
  retryCount: number;
}

/**
 * Decide what to do with one candidate.
 *
 *   | sent | queued | contacted | age since served_at | verdict          |
 *   |------|--------|-----------|---------------------|------------------|
 *   | true | —      | —         | any                 | terminal         |
 *   | false| true   | —         | any                 | in_vendor_queue  |
 *   | false| null   | —         | any                 | unknown          |
 *   | false| false  | false     | any                 | retry            |
 *   | false| false  | true      | < TTL               | in_vendor_queue  |
 *   | false| false  | true      | >= TTL              | retry            |
 *
 * `sent` is checked first: it is terminal regardless of anything else. Then the sender's
 * own `queued` statement: while it holds the person, age means nothing — a backlogged
 * queue is still a queue. A sender that stated nothing (or no status at all for the
 * email) is `unknown` and is NOT retried: without its word we cannot tell a stranded
 * person from a queued one, and only one of those mistakes sends a second email. Only
 * where the sender says it holds nothing does the old table apply — never handed over ⟹
 * retry; handed over and older than the TTL ⟹ lost, retry. An unknown age (a served row
 * with no timestamp at all) counts as still queued rather than lost.
 */
export function decideRetry(
  flags: CandidateStatusFlags | null,
  servedAt: Date | string | null,
  nowMs: number,
): RetryVerdict {
  if (!flags) return "unknown";
  if (flags.sent) return "terminal";
  if (flags.queued === true) return "in_vendor_queue";
  if (flags.queued === null) return "unknown";
  if (!flags.contacted) return "retry";

  const servedAtMs = toMillis(servedAt);
  if (servedAtMs === null) return "in_vendor_queue";
  return nowMs - servedAtMs >= RETRY_QUEUE_TTL_MS ? "retry" : "in_vendor_queue";
}

/**
 * Read the campaign-scoped `contacted` / `sent` / `queued` flags out of one email-gateway
 * result.
 *
 * `queued` is the BROADCAST provider's statement (it owns the send queue): true if any
 * of its scopes for this campaign says so, false only if a scope states false and none
 * states true, null when the broadcast side is absent (the gateway answers 200 with
 * only the transactional half when instantly-service fails) or carries no `queued`.
 *
 * The call is campaign-scoped, so `campaign` is the populated scope; `byCampaign` is
 * read as well because the gateway populates it in brand mode and an extra source of
 * TRUE here can only ever stop a second email. Whether a person contacted by a sibling
 * campaign of the same brand may be contacted by this one is human-service's
 * brand-level suppression policy, not this pool's — so brand scope is deliberately not
 * consulted.
 */
export function campaignScopeFlags(
  result: StatusResult | undefined,
  campaignId: string,
): CandidateStatusFlags | null {
  if (!result) return null;

  let contacted = false;
  let sent = false;
  let queued: boolean | null = null;

  for (const provider of [result.broadcast, result.transactional]) {
    if (!provider) continue;
    const scopes = [provider.campaign, provider.byCampaign?.[campaignId]];
    for (const scope of scopes) {
      if (!scope) continue;
      if (scope.contacted) contacted = true;
      if (scope.sent) sent = true;
      if (provider === result.broadcast && typeof scope.queued === "boolean") {
        queued = queued === true || scope.queued;
      }
    }
  }

  return { contacted, sent, queued };
}

function toMillis(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

interface RawCandidateRow {
  id: string;
  lead_id: string;
  email: string | null;
  served_at: Date | string | null;
  audience_id: string | null;
  goal: string | null;
  retry_count: number | string | null;
}

/**
 * The campaign's oldest non-terminal serves, oldest first.
 *
 * `sent_at IS NOT NULL` leaves the pool for good — that marker is what stops the batch
 * from growing with the campaign's whole history and re-querying people who left three
 * months ago. A live claim is skipped until its lease expires.
 *
 * Ordering is `COALESCE(retry_claimed_at, served_at, created_at)`: oldest SERVE first,
 * and a person we have already tried and failed sorts by that attempt instead, so they
 * move to the back of the queue rather than blocking the campaign's head forever.
 */
export async function loadRetryCandidates(params: {
  orgId: string;
  campaignId: string;
  nowMs: number;
  limit?: number;
}): Promise<RetryCandidate[]> {
  const leaseCutoff = new Date(params.nowMs - RETRY_CLAIM_LEASE_MS).toISOString();
  const limit = params.limit ?? RETRY_CANDIDATE_BATCH_SIZE;

  const rows = (await db.execute(sql<RawCandidateRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.served_at, lc.audience_id, lc.goal,
      COALESCE(lc.retry_count, 0) AS retry_count,
      em.value AS email
    FROM leads_campaigns lc
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) em ON true
    WHERE lc.org_id = ${params.orgId}
      AND lc.campaign_id = ${params.campaignId}
      AND lc.status = 'served'
      AND lc.sent_at IS NULL
      AND (lc.retry_claimed_at IS NULL OR lc.retry_claimed_at < ${leaseCutoff})
    ORDER BY COALESCE(lc.retry_claimed_at, lc.served_at, lc.created_at) ASC, lc.id ASC
    LIMIT ${limit}
  `)) as unknown as RawCandidateRow[];

  return rows
    .filter((r): r is RawCandidateRow & { email: string } => Boolean(r.email))
    .map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      email: r.email,
      servedAt: r.served_at,
      audienceId: r.audience_id,
      goal: r.goal,
      retryCount: Number(r.retry_count ?? 0),
    }));
}

/**
 * Take a candidate out of the pool for good.
 *
 * An email went out, so nothing here may ever return this person again — and, just as
 * importantly, no later pull re-queries them against email-gateway.
 */
export async function markSentCandidates(ids: string[], nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date(nowMs);
  // Built through the query builder rather than a raw `= ANY(${ids}::text[])`. The driver
  // renders a bare JS array parameter as a ROW, so hand-casting it to an array type fails
  // at runtime with `cannot cast type record to text[]` — which is what shipped, and what
  // took a live campaign's serve down every minute until this was corrected. The builder
  // owns the parameter's type, so there is nothing left to cast by hand.
  await db
    .update(leadsCampaigns)
    .set({ sentAt: now, updatedAt: now })
    .where(and(inArray(leadsCampaigns.id, ids), isNull(leadsCampaigns.sentAt)));
}

/**
 * Claim one candidate for this run, atomically.
 *
 * Two runs pulling at the same time both read `contacted = false` for the same person;
 * exactly one of them may hand that person to a workflow. The conditional
 * `UPDATE ... RETURNING` is the arbiter: the loser sees zero rows and moves to the next
 * candidate. The row's run ids are re-pointed at the claiming run, because that is the
 * run which will now try to contact this person; `served_at` is NOT touched — the paid
 * serve happened once, and the read paths order on it.
 */
export async function claimCandidate(params: {
  id: string;
  nowMs: number;
  runId: string | null;
  parentRunId: string | null;
}): Promise<boolean> {
  const now = new Date(params.nowMs).toISOString();
  const leaseCutoff = new Date(params.nowMs - RETRY_CLAIM_LEASE_MS).toISOString();

  const rows = (await db.execute(sql`
    UPDATE leads_campaigns
       SET retry_claimed_at = ${now},
           retry_count = COALESCE(retry_count, 0) + 1,
           run_id = ${params.runId},
           push_run_id = ${params.runId},
           parent_run_id = ${params.parentRunId},
           updated_at = ${now}
     WHERE id = ${params.id}
       AND status = 'served'
       AND sent_at IS NULL
       AND (retry_claimed_at IS NULL OR retry_claimed_at < ${leaseCutoff})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  return rows.length > 0;
}

/**
 * The serve's identity headers, forwarded to email-gateway.
 *
 * Nullable per field because that is the shape the serve path already carries
 * (`ServiceContext` in people-client) — a null is dropped rather than sent as the string
 * "null".
 */
export interface RetryPoolContext {
  orgId?: string | null;
  userId?: string | null;
  runId?: string | null;
  campaignId?: string | null;
  brandId?: string | null;
  workflowSlug?: string | null;
  featureSlug?: string | null;
  goal?: string | null;
  activeGoalId?: string | null;
  brandProfileId?: string | null;
  audienceId?: string | null;
}

function forwardableContext(context: RetryPoolContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Hand back a person this campaign already paid for and never contacted, or null.
 *
 * Null means the pool had nobody retryable, and the caller falls through to
 * `serveNext` on human-service exactly as before. email-gateway being unreachable is
 * also null — FAIL-CLOSED: without its answer we cannot tell a stranded person from one
 * sitting in the vendor's queue, and the two failure modes are not symmetric. Falling
 * through buys new stock, which costs money; guessing sends a second email to a human,
 * which cannot be taken back.
 */
export async function pickRetryCandidate(params: {
  orgId: string;
  campaignId: string;
  brandId: string;
  runId: string | null;
  parentRunId: string | null;
  context: RetryPoolContext;
  nowMs?: number;
}): Promise<RetryCandidate | null> {
  const nowMs = params.nowMs ?? Date.now();

  const candidates = await loadRetryCandidates({
    orgId: params.orgId,
    campaignId: params.campaignId,
    nowMs,
  });
  if (candidates.length === 0) return null;

  let statuses: StatusResult[];
  try {
    const response = await checkDeliveryStatus(
      params.brandId,
      params.campaignId,
      candidates.map((c) => ({ email: c.email })),
      forwardableContext(params.context),
    );
    statuses = response.results;
  } catch (err) {
    // Fail-closed: no evidence ⟹ no retry. Today's behaviour, minus one wasted call.
    console.warn(
      `[lead-service] retry-pool skipped: email-gateway status unavailable campaign=${params.campaignId} candidates=${candidates.length}:`,
      err,
    );
    return null;
  }

  const byEmail = new Map<string, StatusResult>();
  for (const result of statuses) byEmail.set(result.email.toLowerCase(), result);

  const terminalIds: string[] = [];
  const retryable: RetryCandidate[] = [];
  let queuedCount = 0;
  let unknownCount = 0;

  for (const candidate of candidates) {
    const flags = campaignScopeFlags(byEmail.get(candidate.email.toLowerCase()), params.campaignId);
    const verdict = decideRetry(flags, candidate.servedAt, nowMs);
    if (verdict === "terminal") terminalIds.push(candidate.id);
    else if (verdict === "retry") retryable.push(candidate);
    else if (verdict === "in_vendor_queue") queuedCount += 1;
    else unknownCount += 1;
  }

  // Loud, not silent: a pool whose candidates the sender never states anything about is
  // a pool that has stopped retrying, and that must be visible in the logs.
  if (unknownCount > 0) {
    console.warn(
      `[lead-service] retry-pool: sender stated no queue state for ${unknownCount}/${candidates.length} candidates campaign=${params.campaignId} — not retried`,
    );
  }

  // Sent people leave the pool whether or not we return anyone this run — that is what
  // keeps the next pull's batch small.
  await markSentCandidates(terminalIds, nowMs);

  for (const candidate of retryable) {
    const claimed = await claimCandidate({
      id: candidate.id,
      nowMs,
      runId: params.runId,
      parentRunId: params.parentRunId,
    });
    if (claimed) {
      console.log(
        `[lead-service] retry-pool claimed campaign=${params.campaignId} leadId=${candidate.leadId} email=${candidate.email} attempt=${candidate.retryCount + 1} candidates=${candidates.length} terminal=${terminalIds.length} queued=${queuedCount} unknown=${unknownCount}`,
      );
      return candidate;
    }
    // Lost the race to a concurrent pull — try the next one.
  }

  return null;
}
