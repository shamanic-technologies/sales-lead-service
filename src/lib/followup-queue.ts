/**
 * Who is owed our next message, and when.
 *
 * Once a prospect has shown a sales interest we owe them an answer NOW, and, if they then go
 * quiet, further answers at increasingly spaced intervals — indefinitely, until they book, opt out,
 * or answer again. Nothing recorded that debt: a reply arrived, it was qualified, and there was no
 * record anywhere of what we owed that person or when. A worker that wants to answer the next
 * person who is due had nothing to ask.
 *
 * The debt is a property of the (lead, campaign) pair, so it lives on `leads_campaigns` beside the
 * paid-pool retry state (0030) and reuses that pattern rather than inventing a second concurrency
 * mechanism: a due date, an expiring claim lease written by a conditional UPDATE, and an attempt
 * count. Several replies land at the same moment and two workers must never answer the same person
 * twice — a read-then-write race would double-email a prospect, which is the worst failure this
 * feature can have, and unlike a wasted credit it cannot be taken back.
 *
 * Three things this deliberately does NOT do:
 *
 *  - It does not cap the number of follow-ups. The intervals grow; that is the limit.
 *  - It does not compute the interval. The next due date is CHOSEN by the worker, per lead — a
 *    prospect who writes "recontact me in January" must be honoured — so it is stored data, not a
 *    ladder here. This module only bounds it (never in the past, never absurdly far out) and
 *    refuses loudly outside those bounds rather than clamping to a number nobody asked for.
 *  - It does not guess a stop. A lead stops being due for exactly three observable reasons: they
 *    opted out (email-gateway's evidence, read at claim time), a booked meeting is on record for
 *    them, or they answered again (the observer of that reply says so, and the queue holds nothing
 *    until qualification re-decides what we owe).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { followupActionInsert } from "./followup-actions.js";

/**
 * How long a claim holds a due row before another worker may take it.
 *
 * The claim's job is that exactly one worker answers a prospect. It must also EXPIRE: a worker
 * that dies between claiming and answering would otherwise strand that person forever, by our own
 * hand — the same asymmetry the paid pool's lease is sized for. An hour comfortably exceeds an
 * answer-and-send leg while keeping a failed attempt retryable the same day.
 */
export const FOLLOWUP_CLAIM_LEASE_MS = 60 * 60 * 1000;

/**
 * How many due rows one claim looks at.
 *
 * This is what keeps the email-gateway call a fixed size whatever the backlog: one batched
 * campaign-scoped call for at most this many emails, inside the client's own 100-per-request
 * batch, so it is always exactly one HTTP call per brand. Anyone beyond the window is not lost —
 * the ordering is oldest-due-first, so the window walks forward as rows are answered.
 */
export const FOLLOWUP_CANDIDATE_BATCH_SIZE = 50;

/**
 * How far into the past a stated due date may sit before it is nonsense.
 *
 * A worker will be an LLM and will occasionally propose nonsense. "Due now" is legitimate and is
 * the common case (a reply just landed and we owe an answer immediately), so the bound cannot be
 * a strict "> now" — clock skew between the worker and this service would refuse honest requests.
 * Five minutes of slack accepts "now" from any clock and still refuses a date in the past, which
 * would make the person permanently at the head of the queue.
 */
export const FOLLOWUP_DUE_PAST_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * How far out a stated due date may sit.
 *
 * A year. Long enough for the honest far-out case (a prospect who says "we budget again in
 * January" ten months from now), short enough that a hallucinated year 2525 is refused rather than
 * silently parking a paid-for prospect past anyone's horizon.
 */
export const FOLLOWUP_DUE_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Outcomes that mean a booked meeting is on record, so nothing further is owed.
 *
 * `meeting_booked` is the stop the brief names. The two beyond it are included because they cannot
 * be true of somebody who never booked: a meeting ATTENDED and a deal CLOSED both entail the
 * booking, and continuing to chase a customer who has already bought is the same failure the stop
 * exists to prevent. A "never" statement is deliberately NOT here — it says this step will not
 * happen, which is not the same as it having happened, and the queue's job is to keep asking.
 */
export const FOLLOWUP_BOOKED_OUTCOMES = ["meeting_booked", "meeting_attended", "sale"] as const;

/** Why a claim came back with nobody. Named, never a silent empty. */
export type FollowupEmptyReason =
  /** No row of this campaign is due right now. */
  | "nothing_due"
  /** Every due row is either claimed by another worker or was stopped during this claim. */
  | "all_claimed";

export interface FollowupCandidate {
  /** `leads_campaigns.id` — the lifecycle row, which is what is claimed. */
  id: string;
  leadId: string;
  campaignId: string;
  /** The lead's canonical email. The delivery evidence (opt-out) is keyed on it. */
  email: string;
  /** Which brand the delivery evidence is asked for. */
  brandId: string;
  /** Raw `timestamptz`: postgres.js hands these back as `Date` OR `string`. */
  dueAt: Date | string | null;
  followupCount: number;
  lastActionAt: Date | string | null;
  audienceId: string | null;
}

/** What a caller states about a row's follow-up debt. */
export type FollowupStatementKind =
  /** We owe this person an action at `dueAt`. The first enqueue after qualification, and the
   *  re-enqueue after a fresh reply has been re-qualified. Does not count as an action. */
  | "scheduled"
  /** A worker acted (it answered them). `nextDueAt` says when the next answer is owed. */
  | "acted"
  /** Nothing is owed right now, and why. A later "scheduled" re-enters them; this is not a
   *  tombstone, which is what makes "they answered again" expressible: the observer of the reply
   *  stops the schedule, and qualification re-decides. */
  | "stopped";

export const FOLLOWUP_STATEMENT_KINDS: readonly FollowupStatementKind[] = [
  "scheduled",
  "acted",
  "stopped",
];

export interface DueDateBounds {
  minMs: number;
  maxMs: number;
}

export function dueDateBounds(nowMs: number): DueDateBounds {
  return {
    minMs: nowMs - FOLLOWUP_DUE_PAST_TOLERANCE_MS,
    maxMs: nowMs + FOLLOWUP_DUE_MAX_HORIZON_MS,
  };
}

export type ParsedDueDate =
  | { ok: true; iso: string; ms: number }
  | { ok: false; code: "due_date_unparseable" | "due_date_out_of_bounds" };

/**
 * Read a caller-stated due date, or refuse.
 *
 * REFUSES rather than clamps. A clamp would answer a request nobody made — the worker asked for
 * January and got tomorrow — and the caller would never learn its date was wrong, which is exactly
 * the silent-fallback shape this repo does not ship. The bounds are published on the endpoint and
 * returned in the error body, so a worker that proposes nonsense is told what the range is and can
 * state a real date.
 */
export function parseDueDate(value: unknown, nowMs: number): ParsedDueDate {
  if (typeof value !== "string") return { ok: false, code: "due_date_unparseable" };
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return { ok: false, code: "due_date_unparseable" };

  const bounds = dueDateBounds(nowMs);
  if (ms < bounds.minMs || ms > bounds.maxMs) return { ok: false, code: "due_date_out_of_bounds" };

  return { ok: true, iso: new Date(ms).toISOString(), ms };
}

interface RawCandidateRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  brand_ids: string[];
  email: string | null;
  followup_due_at: Date | string | null;
  followup_count: number | string | null;
  followup_last_action_at: Date | string | null;
  audience_id: string | null;
}

/**
 * This campaign's due rows, oldest due first.
 *
 * Oldest-due-first is what stops a backlog starving the people who have waited longest: a burst of
 * fresh replies never jumps the queue ahead of somebody owed an answer since last week.
 *
 * Two of the three stops are applied HERE, in SQL, because they are facts this service already
 * holds. A booked meeting (or anything that entails one) is read from the conversion ledger — both
 * a hand-stated row, which names the lifecycle row outright, and a tracker-reported one, which
 * carries the matched lead — filtering withdrawn statements exactly as every other read of that
 * ledger does. "They answered again" is not derived at all: the observer of the reply says so by
 * stopping the schedule, and a row with no due date is not in this result by construction. The
 * third stop, the opt-out, needs the delivery layer and is applied by `pickFollowupCandidate`.
 */
export async function loadFollowupCandidates(params: {
  orgId: string;
  campaignId: string;
  nowMs: number;
  limit?: number;
}): Promise<FollowupCandidate[]> {
  const now = new Date(params.nowMs).toISOString();
  const leaseCutoff = new Date(params.nowMs - FOLLOWUP_CLAIM_LEASE_MS).toISOString();
  const limit = params.limit ?? FOLLOWUP_CANDIDATE_BATCH_SIZE;

  const rows = (await db.execute(sql<RawCandidateRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.brand_ids, lc.audience_id,
      lc.followup_due_at, lc.followup_last_action_at,
      COALESCE(lc.followup_count, 0) AS followup_count,
      lower(em.value) AS email
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
      AND lc.followup_due_at IS NOT NULL
      AND lc.followup_due_at <= ${now}
      AND (lc.followup_claimed_at IS NULL OR lc.followup_claimed_at < ${leaseCutoff})
      AND NOT EXISTS (
        SELECT 1
        FROM conversion_events ce
        WHERE ce.withdrawn_at IS NULL
          AND ce.event = ANY(${sql.param(FOLLOWUP_BOOKED_OUTCOMES as unknown as string[])}::text[])
          AND (ce.lead_campaign_id = lc.id OR ce.matched_lead_id = lc.lead_id)
      )
    ORDER BY lc.followup_due_at ASC, lc.id ASC
    LIMIT ${limit}
  `)) as unknown as RawCandidateRow[];

  return rows
    .filter((r): r is RawCandidateRow & { email: string } => Boolean(r.email))
    .map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      campaignId: r.campaign_id,
      email: r.email,
      brandId: r.brand_ids[0] ?? "",
      dueAt: r.followup_due_at,
      followupCount: Number(r.followup_count ?? 0),
      lastActionAt: r.followup_last_action_at,
      audienceId: r.audience_id,
    }))
    .filter((c) => c.brandId.length > 0);
}

/**
 * Claim one due row for this worker, atomically.
 *
 * Two workers polling at the same moment both read the same person as due; exactly one of them may
 * answer. The conditional `UPDATE ... RETURNING` is the arbiter — the loser sees zero rows and
 * moves to the next candidate — and the predicate re-checks everything the read checked, so a row
 * stopped or claimed in the interval is refused rather than answered on stale evidence.
 */
export async function claimFollowup(params: {
  id: string;
  nowMs: number;
  runId: string | null;
  /** The campaign the claiming worker was dispatched for (x-campaign-id). Recorded, never guessed. */
  actingCampaignId?: string | null;
}): Promise<boolean> {
  const now = new Date(params.nowMs).toISOString();
  const leaseCutoff = new Date(params.nowMs - FOLLOWUP_CLAIM_LEASE_MS).toISOString();

  // The ledger row is written by the SAME statement that wins the claim, so a claim can never
  // exist without the record of who took it, and a lost race writes nothing.
  const rows = (await db.execute(sql`
    WITH claimed AS (
      UPDATE leads_campaigns
         SET followup_claimed_at = ${now},
             updated_at = ${now}
       WHERE id = ${params.id}
         AND followup_due_at IS NOT NULL
         AND followup_due_at <= ${now}
         AND (followup_claimed_at IS NULL OR followup_claimed_at < ${leaseCutoff})
      RETURNING id, org_id, brand_ids, lead_id, campaign_id
    ), logged AS (
      ${followupActionInsert("claimed", params.actingCampaignId ?? null, params.runId, now)}
    )
    SELECT id FROM claimed
  `)) as unknown as Array<{ id: string }>;

  return rows.length > 0;
}

/**
 * Take rows out of the queue, stating why.
 *
 * Used for the opt-out stop: a person who unsubscribed is owed nothing further, ever, and clearing
 * the due date is also what stops the next claim re-reading them against email-gateway.
 */
export async function stopFollowups(
  ids: string[],
  reason: string,
  nowMs: number,
): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date(nowMs).toISOString();

  await db.execute(sql`
    UPDATE leads_campaigns
       SET followup_due_at = NULL,
           followup_claimed_at = NULL,
           followup_stopped_reason = ${reason},
           updated_at = ${now}
     WHERE id = ANY(${sql.param(ids)}::uuid[])
  `);
}

/**
 * Is this person opted out, per the delivery layer, for this scope?
 *
 * An opt-out is the prospect's own act and it is absolute: nothing overrides it. Both the scoped
 * answer and the global one count — a global unsubscribe is an answer about the address itself,
 * whatever campaign asked.
 */
export function isOptedOut(result: StatusResult | undefined, campaignId: string): boolean {
  if (!result) return false;

  for (const provider of [result.broadcast, result.transactional]) {
    if (!provider) continue;
    if (provider.global?.email?.unsubscribed) return true;
    for (const scope of [provider.campaign, provider.brand, provider.byCampaign?.[campaignId]]) {
      if (scope?.unsubscribed) return true;
    }
  }

  return false;
}

/** email-gateway could not answer. A claim NEVER proceeds on a guess; the caller answers 502. */
export class FollowupOptOutLookupError extends Error {
  constructor(cause: unknown) {
    super(`[followup-queue] email-gateway status unavailable: ${String(cause)}`);
    this.name = "FollowupOptOutLookupError";
  }
}

export interface FollowupClaimContext {
  orgId?: string | null;
  userId?: string | null;
  runId?: string | null;
  campaignId?: string | null;
  brandId?: string | null;
  workflowSlug?: string | null;
  featureSlug?: string | null;
  audienceId?: string | null;
}

function forwardableContext(context: FollowupClaimContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

export type FollowupClaim =
  | { claimed: FollowupCandidate }
  | { claimed: null; reason: FollowupEmptyReason };

/**
 * Hand back the next person due for a follow-up on this campaign, or nobody.
 *
 * The opt-out stop is applied here because only the delivery layer holds that evidence. If it
 * cannot answer, this THROWS: a claim never proceeds on a guess. The failure directions are not
 * symmetric — returning nobody costs a poll, while answering a person who unsubscribed sends an
 * email to somebody who asked us to stop, which cannot be taken back — so there is no fallback
 * branch here at all, silent or otherwise.
 */
export async function pickFollowupCandidate(params: {
  orgId: string;
  campaignId: string;
  runId: string | null;
  /** The campaign the claiming worker was dispatched for (x-campaign-id), recorded on the ledger. */
  actingCampaignId?: string | null;
  context: FollowupClaimContext;
  nowMs?: number;
}): Promise<FollowupClaim> {
  const nowMs = params.nowMs ?? Date.now();

  const candidates = await loadFollowupCandidates({
    orgId: params.orgId,
    campaignId: params.campaignId,
    nowMs,
  });
  if (candidates.length === 0) return { claimed: null, reason: "nothing_due" };

  // One gateway call per brand present in the window — in practice exactly one, because a
  // campaign's rows share a brand.
  const byBrand = new Map<string, FollowupCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byBrand.get(candidate.brandId);
    if (bucket) bucket.push(candidate);
    else byBrand.set(candidate.brandId, [candidate]);
  }

  const statusByEmail = new Map<string, StatusResult>();
  for (const [brandId, bucket] of byBrand) {
    let results: StatusResult[];
    try {
      const response = await checkDeliveryStatus(
        brandId,
        params.campaignId,
        bucket.map((c) => ({ email: c.email })),
        forwardableContext(params.context),
      );
      results = response.results;
    } catch (err) {
      throw new FollowupOptOutLookupError(err);
    }
    for (const result of results) statusByEmail.set(result.email.toLowerCase(), result);
  }

  const optedOutIds: string[] = [];
  const answerable: FollowupCandidate[] = [];
  for (const candidate of candidates) {
    if (isOptedOut(statusByEmail.get(candidate.email), params.campaignId)) {
      optedOutIds.push(candidate.id);
    } else {
      answerable.push(candidate);
    }
  }

  // They are owed nothing further whether or not we hand anyone back this poll, and clearing them
  // is what keeps the next poll's window (and its gateway call) small.
  await stopFollowups(optedOutIds, "opted_out", nowMs);

  for (const candidate of answerable) {
    const claimed = await claimFollowup({
      id: candidate.id,
      nowMs,
      runId: params.runId,
      actingCampaignId: params.actingCampaignId ?? null,
    });
    if (claimed) {
      console.log(
        `[lead-service] followup claimed campaign=${params.campaignId} leadCampaignId=${candidate.id} email=${candidate.email} followupCount=${candidate.followupCount} due=${candidates.length} optedOut=${optedOutIds.length}`,
      );
      return { claimed: candidate };
    }
    // Lost the race to a concurrent worker — try the next one.
  }

  return { claimed: null, reason: "all_claimed" };
}

export interface FollowupState {
  id: string;
  leadId: string;
  campaignId: string;
  dueAt: string | null;
  claimedAt: string | null;
  followupCount: number;
  lastActionAt: string | null;
  stoppedReason: string | null;
}

interface RawStateRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  followup_due_at: Date | string | null;
  followup_claimed_at: Date | string | null;
  followup_count: number | string | null;
  followup_last_action_at: Date | string | null;
  followup_stopped_reason: string | null;
}

/**
 * Timestamps read through a raw `sql` template come back as `Date` OR `string` depending on the
 * path postgres.js took, so a bare `.toISOString()` throws the moment it is a string.
 */
function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toState(row: RawStateRow): FollowupState {
  return {
    id: row.id,
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    dueAt: toIso(row.followup_due_at),
    claimedAt: toIso(row.followup_claimed_at),
    followupCount: Number(row.followup_count ?? 0),
    lastActionAt: toIso(row.followup_last_action_at),
    stoppedReason: row.followup_stopped_reason,
  };
}

const STATE_COLUMNS = sql`
  id, lead_id, campaign_id, followup_due_at, followup_claimed_at,
  COALESCE(followup_count, 0) AS followup_count,
  followup_last_action_at, followup_stopped_reason
`;

/**
 * One row's follow-up state, or null.
 *
 * `org_id` is IN the predicate: a row belonging to another org is indistinguishable from one that
 * does not exist, never a check afterwards.
 */
export async function readFollowupState(
  orgId: string,
  id: string,
): Promise<FollowupState | null> {
  const rows = (await db.execute(sql`
    SELECT ${STATE_COLUMNS}
    FROM leads_campaigns
    WHERE id = ${id} AND org_id = ${orgId}
    LIMIT 1
  `)) as unknown as RawStateRow[];
  return rows[0] ? toState(rows[0]) : null;
}

/**
 * Write what a caller states about the debt, and read the resulting state back.
 *
 * All three kinds land on the same row in one statement, so a caller never sees a half-applied
 * state and never has to ask what its write did — the response IS the state.
 *
 *  - scheduled: the due date stands, the claim is released, the stop reason is cleared. NOT an
 *    action, so the count does not move: nobody has answered anybody yet.
 *  - acted: the count moves, `last_action_at` is stamped, the claim is released and the next due
 *    date stands. This is the only kind that increments, which is what makes the count mean
 *    "answers we sent" rather than "times somebody touched the row".
 *  - stopped: no due date, the claim is released, the reason is recorded. Not a tombstone — a
 *    later `scheduled` re-enters the person, which is exactly how "they answered again" works:
 *    whoever observes the reply stops the schedule, and qualification re-decides what we owe.
 */
export async function writeFollowupStatement(params: {
  orgId: string;
  id: string;
  kind: FollowupStatementKind;
  dueAtIso: string | null;
  reason: string | null;
  nowMs: number;
  /** Recorded on the ledger for an 'acted' statement: the campaign the worker was dispatched for. */
  actingCampaignId?: string | null;
  runId?: string | null;
}): Promise<FollowupState | null> {
  const now = new Date(params.nowMs).toISOString();
  const acted = params.kind === "acted";

  // An 'acted' statement is also a ledger row, written by the same statement: the count on the
  // lifecycle row says HOW MANY answers were sent, the ledger says WHICH campaign's worker sent each.
  const rows = (await db.execute(sql`
    WITH updated AS (
      UPDATE leads_campaigns
         SET followup_due_at = ${params.dueAtIso},
             followup_claimed_at = NULL,
             followup_count = COALESCE(followup_count, 0) + ${acted ? 1 : 0},
             followup_last_action_at = ${acted ? now : sql`followup_last_action_at`},
             followup_stopped_reason = ${params.reason},
             updated_at = ${now}
       WHERE id = ${params.id} AND org_id = ${params.orgId}
      RETURNING ${STATE_COLUMNS}, org_id, brand_ids
    )${
      acted
        ? sql`, logged AS (
      ${followupActionInsert("acted", params.actingCampaignId ?? null, params.runId ?? null, now, sql`updated`)}
    )`
        : sql``
    }
    SELECT ${STATE_COLUMNS} FROM updated
  `)) as unknown as RawStateRow[];

  return rows[0] ? toState(rows[0]) : null;
}

/**
 * From an email address to the row that carries the debt.
 *
 * The service that qualifies a reply holds the campaign and the person's EMAIL ADDRESS; it does
 * not hold this service's `leads_campaigns.id`. Something has to bridge the two, and the bridge
 * must be EXACT: the only path from an address to a claimable row today is the leads list's
 * free-text search, a substring match across several fields. That is right for a human scanning
 * results and wrong here — writing the debt onto the wrong person's row makes us email somebody
 * who never replied, which cannot be taken back. So this is an equality match on the registered
 * contact method, case-folded and nothing else: no substring, no fuzzy, no "closest lead".
 *
 * `idx_lcm_channel_value` makes one email one lead, and `idx_lc_lead_campaign` makes one lead one
 * row per campaign, so the honest answer is normally exactly one row. Case is the seam those
 * indexes do not close — they are unique on the value as STORED, so `A@x.com` and `a@x.com` can be
 * two different leads — and a case-folded match can therefore see more than one. That is stated as
 * ambiguity and refused. It is never resolved by picking one.
 *
 * The scope is the campaign id NAMED, exactly as the claim's is: the claim hands out rows of that
 * campaign, so enqueueing onto a sibling of its identity family would write a debt nothing ever
 * claims. Resolving wide and enqueueing narrow are the same bug in two directions.
 */
export type FollowupLeadLookup =
  | { ok: true; id: string; leadId: string; email: string }
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "ambiguous_lead"; matches: Array<{ id: string; leadId: string; email: string }> };

interface RawLookupRow {
  id: string;
  lead_id: string;
  email: string;
}

export async function lookupFollowupRowByEmail(params: {
  orgId: string;
  campaignId: string;
  email: string;
}): Promise<FollowupLeadLookup> {
  const email = params.email.trim().toLowerCase();

  const rows = (await db.execute(sql<RawLookupRow[]>`
    SELECT DISTINCT lc.id, lc.lead_id, cm.value AS email
    FROM leads_campaigns lc
    JOIN lead_contact_methods cm
      ON cm.lead_id = lc.lead_id
     AND cm.channel = 'email'
     AND lower(cm.value) = ${email}
    WHERE lc.org_id = ${params.orgId}
      AND lc.campaign_id = ${params.campaignId}
    ORDER BY lc.id ASC
    LIMIT 5
  `)) as unknown as RawLookupRow[];

  if (rows.length === 0) return { ok: false, code: "lead_not_found" };
  if (rows.length > 1) {
    return {
      ok: false,
      code: "ambiguous_lead",
      matches: rows.map((r) => ({ id: r.id, leadId: r.lead_id, email: r.email })),
    };
  }

  return { ok: true, id: rows[0].id, leadId: rows[0].lead_id, email: rows[0].email };
}
