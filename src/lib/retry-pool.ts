import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { RecentlyEmailedScope } from "./recently-emailed-sql.js";
import { readBuyingSignal, type BuyingSignal } from "./buying-signal.js";
import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { channelSendKey, fetchChannelSendsBatch, type ChannelSend } from "./channel-send-client.js";
import type { ReachMethod } from "./people-client.js";
import { reachClauses, type RelationshipScope } from "./reach-sql.js";
import type { PoolEmailPolicy } from "./email-policy.js";

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

/**
 * The batch for a pool whose sender is crm-service (channel-send-client.ts): one `sends/query` call per pull for at most
 * this many people. A person found sent leaves the pool for good, so the window still walks forward.
 */
export const CHANNEL_RETRY_CANDIDATE_BATCH_SIZE = 10;

/**
 * WHO states whether a served person was contacted, by the channel the campaign's pipe writes on
 * (WA-RESERVE-LOOP-1014). `email` = email-gateway's `/orgs/status` (every email pipe, and any pipe whose channel states
 * no contact method: today's behaviour, byte-identical). `channel` = the non-email sender's own send record
 * (crm-service), for a pipe whose channel does not write by email: email-gateway never sees those sends.
 */
export type PoolSender = "email" | "channel";

/** PURE: the pool's sender from the channel's own contact methods (src/lib/channel-reach.ts). */
export function poolSenderOf(channelMethods: readonly string[] | null): PoolSender {
  if (!channelMethods || channelMethods.length === 0 || channelMethods.includes("email")) return "email";
  return "channel";
}

/** What the non-email sender's record says about one candidate, for THIS campaign. */
export type ChannelVerdict =
  | { verdict: "channel_sent"; sentAt: string; sendId: string }
  | { verdict: "in_vendor_queue" }
  | { verdict: "retry" };

/**
 * PURE. Only sends carrying THIS campaign's id count (another campaign writing to the person is the brand-level
 * suppression's business, as on the email side).
 *
 *   | a `sent` send of this campaign     | channel_sent (terminal, never re-served, counts as contacted) |
 *   | else a `sending` one               | in_vendor_queue (the sender is on it; leave it alone)          |
 *   | else (none, `failed`, `refused`)   | retry (nothing went out)                                      |
 *
 * A refusal about the CHANNEL (no phone, not on WhatsApp) is already set aside by the workflow's channel-refusals call
 * (released-pool.ts: `send_refused_*`, the row never reaches this read). The sender's word is never re-graded here.
 */
export function decideChannelRetry(
  sends: readonly ChannelSend[] | undefined,
  campaignId: string,
  nowMs: number,
): ChannelVerdict {
  const mine = (sends ?? []).filter((s) => s.campaignId === campaignId);
  const sent = mine
    .filter((s) => s.status === "sent")
    .map((s) => {
      const stated = s.sentAt ?? s.createdAt;
      const ms = stated === null ? Number.NaN : Date.parse(stated);
      // A send stated `sent` with no readable date is still sent: dated by when we read it, never re-served.
      return { sendId: s.sendId, ms: Number.isNaN(ms) ? nowMs : ms };
    })
    .sort((a, b) => a.ms - b.ms);
  if (sent.length > 0) return { verdict: "channel_sent", sentAt: new Date(sent[0].ms).toISOString(), sendId: sent[0].sendId };
  if (mine.some((s) => s.status === "sending")) return { verdict: "in_vendor_queue" };
  return { verdict: "retry" };
}

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
  | "terminal"
  /**
   * The sender says it is finished with this person in this campaign WITHOUT sending, and
   * will answer any further hand-off as a duplicate that sends nothing. Re-serving them can
   * never produce an email — it only burns the slot that would buy somebody new. Out of the
   * pool for good, never queried again. Not `terminal`: nothing was sent.
   */
  | "sender_closed"
  /**
   * The sender REFUSES to send to this person (it says so on its status read: emailed for
   * this brand inside its re-contact window, opted out, ...). Handing them back can only fail
   * the run again, so they leave the pool for as long as the sender says the refusal stands,
   * and the campaign moves on to somebody new. Not `terminal`, not `sender_closed`: nothing
   * was sent, and a refusal with an end date is not the end of the person.
   */
  | "sender_refuses";

/**
 * The sender's own statement that it will NOT send to this person, as it states it.
 *
 * `code` is the sender's word, stored verbatim and never interpreted here (no refusal kind
 * is named in this service). `until` is when the sender says the refusal lapses; `null` =
 * it never does (an opt-out). Which kinds exist and how long each lasts is the sender's
 * policy, never re-derived here from send dates or windows.
 */
export interface SendRefusal {
  code: string;
  until: string | null;
}

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
  /**
   * The sender's own statement that it is FINISHED with this person in this campaign: it
   * holds their claim, has nothing left to send, and a further send would send nothing.
   * `null` = the sender stated nothing — never read as `false`, and never inferred from
   * age or from how many times the person was handed out.
   */
  finished: boolean | null;
  /**
   * The sender's statement that it refuses to send to this person. `null`/absent = it stated
   * no refusal (today's payload, or none stands).
   */
  refusal?: SendRefusal | null;
}

export interface RetryCandidate {
  /** `leads_campaigns.id` — the lifecycle row, which is what gets claimed. */
  id: string;
  leadId: string;
  email: string;
  /** Raw `timestamptz`: postgres.js hands these back as `Date` OR `string`. */
  servedAt: Date | string | null;
  audienceId: string | null;
  /** The buying signal stored on the ORIGINAL serve (null when it carried none). */
  buyingSignal: BuyingSignal | null;
  /** The human-service person stored on the ORIGINAL serve (null when it carried none). */
  personId: string | null;
  goal: string | null;
  retryCount: number;
}

/**
 * Decide what to do with one candidate.
 *
 *   | sent | queued | finished | contacted | age since served_at | verdict          |
 *   |------|--------|----------|-----------|---------------------|------------------|
 *   | true | —      | —        | —         | any                 | terminal         |
 *   | false| true   | —        | —         | any                 | in_vendor_queue  |
 *   | false| not true (refusal stated)        | any                 | sender_refuses   |
 *   | false| false  | true     | —         | any                 | sender_closed    |
 *   | false| null   | —        | —         | any                 | unknown          |
 *   | false| false  | not true | false     | any                 | retry            |
 *   | false| false  | not true | true      | < TTL               | in_vendor_queue  |
 *   | false| false  | not true | true      | >= TTL              | retry            |
 *
 * `sent` is checked first: it is terminal regardless of anything else. Then the sender's
 * own `queued` statement: while it holds the person, age means nothing — a backlogged
 * queue is still a queue. A sender that stated nothing (or no status at all for the
 * email) is `unknown` and is NOT retried: without its word we cannot tell a stranded
 * person from a queued one, and only one of those mistakes sends a second email. A sender
 * that says it is FINISHED with the person in this campaign closes them for good: its claim
 * on (campaign, email) makes every later hand-off a duplicate that sends nothing, so no
 * amount of re-serving can reach them (campaign 3922c8e1: one person handed out 104
 * times, zero emails). A queued statement outranks it — a person still in the queue will
 * be sent, whatever else is on file. Only
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
  // The sender says it will not send to this person: handing them back can only fail the
  // run again (RECONTACT-LOOP-1011: 7 refused people froze a paying campaign for hours).
  if (flags.refusal) return "sender_refuses";
  if (flags.finished === true) return "sender_closed";
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
  let finished: boolean | null = null;
  let refusal: SendRefusal | null = null;

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
      if (provider === result.broadcast && typeof scope.finished === "boolean") {
        finished = finished === true || scope.finished;
      }
      if (provider === result.broadcast && scope.sendRefusal != null) {
        refusal = laterRefusal(refusal, readSendRefusal(scope.sendRefusal));
      }
    }
  }

  return { contacted, sent, queued, finished, refusal };
}

/**
 * Read the sender's refusal statement, or THROW on one it cannot read.
 *
 * A malformed statement is not "no refusal": reading it as absent would hand the person
 * back into the same refusal. The caller turns the throw into `unknown` for that person
 * (not retried), which is the safe direction.
 */
export function readSendRefusal(raw: unknown): SendRefusal {
  if (!raw || typeof raw !== "object") {
    throw new Error(`[retry-pool] unreadable sendRefusal: ${JSON.stringify(raw)}`);
  }
  const { code, until } = raw as { code?: unknown; until?: unknown };
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error(`[retry-pool] sendRefusal without a code: ${JSON.stringify(raw)}`);
  }
  if (until === null) return { code, until: null };
  if (typeof until !== "string" || Number.isNaN(Date.parse(until))) {
    throw new Error(`[retry-pool] sendRefusal with an unreadable until: ${JSON.stringify(raw)}`);
  }
  return { code, until: new Date(until).toISOString() };
}

/** Two statements for one person: the one that lasts longer wins (never = longest). */
function laterRefusal(a: SendRefusal | null, b: SendRefusal): SendRefusal {
  if (!a) return b;
  if (a.until === null) return a;
  if (b.until === null) return b;
  return Date.parse(b.until) > Date.parse(a.until) ? b : a;
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
  buying_signal: unknown;
  person_id: string | null;
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
  /**
   * The channel(s) the campaign's pipe writes on (src/lib/channel-reach.ts): a person missing one is never handed
   * back (owner 2026-10-12: a WhatsApp campaign re-served an email-only person from this pool). Absent = email only.
   */
  reachableBy?: readonly ReachMethod[] | null;
  /** The pipe's email policy (src/lib/email-policy.ts): absent = valid only, a catch-all person is never handed back. */
  acceptedEmails?: PoolEmailPolicy | null;
  /** The pipe's relationship policy (src/lib/relationship-tags.ts, RELATIONSHIP-TAGS-1014): absent = nothing asked. */
  relationships?: RelationshipScope | null;
  /** Tactic "Fresh contacts only" (src/lib/recently-emailed.ts): absent = nothing asked. */
  recentlyEmailed?: RecentlyEmailedScope | null;
}): Promise<RetryCandidate[]> {
  const leaseCutoff = new Date(params.nowMs - RETRY_CLAIM_LEASE_MS).toISOString();
  const nowIso = new Date(params.nowMs).toISOString();
  const limit = params.limit ?? RETRY_CANDIDATE_BATCH_SIZE;

  const rows = (await db.execute(sql<RawCandidateRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.served_at, lc.audience_id, lc.buying_signal, lc.person_id, lc.goal,
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
      AND lc.sender_closed_at IS NULL
      AND lc.channel_sent_at IS NULL
      AND (lc.send_refused_at IS NULL OR (lc.send_refused_until IS NOT NULL AND lc.send_refused_until <= ${nowIso}))
      AND (lc.retry_claimed_at IS NULL OR lc.retry_claimed_at < ${leaseCutoff})
      ${reachClauses(sql`lc.lead_id`, params.reachableBy, params.acceptedEmails, params.relationships, params.recentlyEmailed)}
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
      buyingSignal: readBuyingSignal(r.buying_signal),
      personId: r.person_id ?? null,
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
 * Take a candidate out of the pool because the sender is finished with them here.
 *
 * Nothing was sent, so this is NOT `sent_at` — the lead history reads that column as an
 * email that went out. Like `sent_at`, it is written once and the row is never re-queried.
 */
export async function markSenderClosedCandidates(ids: string[], nowMs: number): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date(nowMs);
  await db
    .update(leadsCampaigns)
    .set({ senderClosedAt: now, updatedAt: now })
    .where(and(inArray(leadsCampaigns.id, ids), isNull(leadsCampaigns.senderClosedAt)));
}

/**
 * Take a candidate out of the pool because the NON-EMAIL sender states it wrote to them for this campaign.
 *
 * Its own column, not `sent_at` (the lead history reads that as the email hand-off). Written once from the sender's
 * record (its sentAt and send id); the row is never re-asked and its overlay reads contacted (withChannelSend).
 */
export async function markChannelSentCandidates(
  sent: Array<{ id: string; sentAt: string; sendId: string }>,
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs);
  for (const s of sent) {
    await db
      .update(leadsCampaigns)
      .set({ channelSentAt: new Date(s.sentAt), channelSendId: s.sendId, updatedAt: now })
      .where(and(eq(leadsCampaigns.id, s.id), isNull(leadsCampaigns.channelSentAt)));
  }
}

/**
 * Take a candidate out of the pool because the sender refuses to send to them.
 *
 * Written from the sender's statement only, verbatim: its code and when it lapses (NULL =
 * never). A later statement overwrites an earlier one (the row re-enters the pool when a
 * window lapses, and the sender is asked again).
 */
export async function markSendRefusedCandidates(
  refused: Array<{ id: string; refusal: SendRefusal }>,
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs);
  for (const { id, refusal } of refused) {
    await db
      .update(leadsCampaigns)
      .set({
        sendRefusedAt: now,
        sendRefusalCode: refusal.code,
        sendRefusedUntil: refusal.until === null ? null : new Date(refusal.until),
        updatedAt: now,
      })
      .where(eq(leadsCampaigns.id, id));
  }
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
       AND sender_closed_at IS NULL
       AND channel_sent_at IS NULL
       AND (send_refused_at IS NULL OR (send_refused_until IS NOT NULL AND send_refused_until <= ${now}))
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
  reachableBy?: readonly ReachMethod[] | null;
  acceptedEmails?: PoolEmailPolicy | null;
  /** The pipe's relationship policy (src/lib/relationship-tags.ts, RELATIONSHIP-TAGS-1014): absent = nothing asked. */
  relationships?: RelationshipScope | null;
  /** Tactic "Fresh contacts only" (src/lib/recently-emailed.ts): absent = nothing asked. */
  recentlyEmailed?: RecentlyEmailedScope | null;
  /** Who states whether a person was contacted (poolSenderOf). Absent = email-gateway (today). */
  sender?: PoolSender;
}): Promise<RetryCandidate | null> {
  const nowMs = params.nowMs ?? Date.now();
  const sender: PoolSender = params.sender ?? "email";

  const candidates = await loadRetryCandidates({
    orgId: params.orgId,
    campaignId: params.campaignId,
    nowMs,
    reachableBy: params.reachableBy ?? null,
    acceptedEmails: params.acceptedEmails ?? null,
    relationships: params.relationships ?? null,
    recentlyEmailed: params.recentlyEmailed ?? null,
    ...(sender === "channel" ? { limit: CHANNEL_RETRY_CANDIDATE_BATCH_SIZE } : {}),
  });
  if (candidates.length === 0) return null;

  if (sender === "channel") return pickChannelCandidate(params, candidates, nowMs);

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
  const closedIds: string[] = [];
  const refused: Array<{ id: string; refusal: SendRefusal }> = [];
  const retryable: RetryCandidate[] = [];
  let queuedCount = 0;
  let unknownCount = 0;

  for (const candidate of candidates) {
    let flags: CandidateStatusFlags | null;
    try {
      flags = campaignScopeFlags(byEmail.get(candidate.email.toLowerCase()), params.campaignId);
    } catch (err) {
      // An unreadable refusal statement: never read as "no refusal" (that re-serves the person
      // into the same refusal). Not retried; loud.
      console.error(
        `[lead-service] retry-pool: unreadable sender status campaign=${params.campaignId} leadId=${candidate.leadId}:`,
        err,
      );
      flags = null;
    }
    const verdict = decideRetry(flags, candidate.servedAt, nowMs);
    if (verdict === "terminal") terminalIds.push(candidate.id);
    else if (verdict === "sender_closed") closedIds.push(candidate.id);
    else if (verdict === "sender_refuses") refused.push({ id: candidate.id, refusal: flags!.refusal! });
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
  // Same for people the sender is finished with here: re-serving them can never send.
  await markSenderClosedCandidates(closedIds, nowMs);
  // And people the sender refuses: out of the pool while the refusal stands, so the run
  // takes somebody new instead of failing on them again.
  await markSendRefusedCandidates(refused, nowMs);
  if (refused.length > 0) {
    console.log(
      `[lead-service] retry-pool set aside ${refused.length} candidate(s) the sender refuses campaign=${params.campaignId} ${refused
        .map((r) => `${r.id}:${r.refusal.code}:${r.refusal.until ?? "never"}`)
        .join(",")}`,
    );
  }
  if (closedIds.length > 0) {
    console.log(
      `[lead-service] retry-pool closed ${closedIds.length} candidate(s) the sender is finished with campaign=${params.campaignId}`,
    );
  }

  for (const candidate of retryable) {
    const claimed = await claimCandidate({
      id: candidate.id,
      nowMs,
      runId: params.runId,
      parentRunId: params.parentRunId,
    });
    if (claimed) {
      console.log(
        `[lead-service] retry-pool claimed campaign=${params.campaignId} leadId=${candidate.leadId} email=${candidate.email} attempt=${candidate.retryCount + 1} candidates=${candidates.length} terminal=${terminalIds.length} closed=${closedIds.length} refused=${refused.length} queued=${queuedCount} unknown=${unknownCount}`,
      );
      return candidate;
    }
    // Lost the race to a concurrent pull — try the next one.
  }

  return null;
}

/**
 * The pool for a pipe that does not write by email (WA-RESERVE-LOOP-1014): the non-email sender's own record decides.
 * Same claim, same fail-closed posture as the email path: crm-service unreadable = nobody re-served this pull.
 */
async function pickChannelCandidate(
  params: { orgId: string; campaignId: string; brandId: string; runId: string | null; parentRunId: string | null; context: RetryPoolContext },
  candidates: RetryCandidate[],
  nowMs: number,
): Promise<RetryCandidate | null> {
  let sendsByEmail: Map<string, ChannelSend[]>;
  try {
    sendsByEmail = await fetchChannelSendsBatch(
      params.brandId,
      params.campaignId,
      candidates.map((c) => c.email),
      { orgId: params.orgId, userId: params.context.userId ?? null, runId: params.context.runId ?? null },
    );
  } catch (err) {
    console.warn(
      `[lead-service] retry-pool skipped: channel sender (crm-service) sends unavailable campaign=${params.campaignId} candidates=${candidates.length}:`,
      err,
    );
    return null;
  }

  const sent: Array<{ id: string; sentAt: string; sendId: string }> = [];
  const retryable: RetryCandidate[] = [];
  let queuedCount = 0;
  for (const candidate of candidates) {
    const decided = decideChannelRetry(sendsByEmail.get(channelSendKey(candidate.email)), params.campaignId, nowMs);
    if (decided.verdict === "channel_sent") sent.push({ id: candidate.id, sentAt: decided.sentAt, sendId: decided.sendId });
    else if (decided.verdict === "retry") retryable.push(candidate);
    else queuedCount += 1;
  }

  // Written to leave the pool for good whether or not anybody is returned this run.
  await markChannelSentCandidates(sent, nowMs);
  if (sent.length > 0) {
    console.log(
      `[lead-service] retry-pool: ${sent.length} candidate(s) already written to on the campaign's channel, out of the pool campaign=${params.campaignId}`,
    );
  }

  for (const candidate of retryable) {
    const claimed = await claimCandidate({ id: candidate.id, nowMs, runId: params.runId, parentRunId: params.parentRunId });
    if (claimed) {
      console.log(
        `[lead-service] retry-pool claimed (channel sender) campaign=${params.campaignId} leadId=${candidate.leadId} attempt=${candidate.retryCount + 1} candidates=${candidates.length} channelSent=${sent.length} sending=${queuedCount}`,
      );
      return candidate;
    }
  }
  return null;
}
