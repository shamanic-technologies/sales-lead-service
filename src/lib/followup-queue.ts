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
 *
 * And one thing it DOES guarantee (owner 2026-10-11, Shockwavecenters): a thread handed to a PERSON
 * is never claimed by an automated responder again. Two ways in, both facts, never a time threshold:
 *
 *  - STATED: whoever hands the thread over (instantly-service: the client is asked to answer, the
 *    reply is escalated, a person already answered) sends `kind:"handed"`. Unlike a stop it is
 *    permanent: a later `scheduled` (the prospect writes again) does not re-enter the row. The ONE
 *    way out: the observer that stated it WITHDRAWS it by the reason it wrote, when its verdict was
 *    wrong (`withdrawHandover`); lifted only if every hand-over on the row names that reason.
 *  - OWED BEFORE ANY RESPONDER: a never-answered debt whose due date predates the earliest responder
 *    known on this held campaign (campaign-service `createdAt` of the acting campaign) was a
 *    human's reply to answer, because no responder existed when it arrived. The claim hands those
 *    over instead of answering them: switching a responder on answered a 5-week-old backlog,
 *    including a thread staff had promised to follow up and one the client was asked to answer.
 *
 * WHO a due date is for is decided by WHO SET IT (`followup_due_set_by_campaign_id`, migration 0071; owner
 * 2026-10-12, WA-RESPONDER-1012). Two kinds of worker share one row: an outreach that schedules its OWN
 * follow-up on its own person (cold WhatsApp: one follow-up 3 days out) and a responder that claims its
 * predecessor's queue. Every statement that sets a due date records the writer's `x-campaign-id`:
 *  - set by the holding campaign itself (the row's `campaign_id`): only the holder may claim it;
 *  - set by ANOTHER campaign (a responder's ladder on its predecessor's person): anyone BUT the holder;
 *  - set by no campaign (an observer: instantly-service's due-now on a reply, campaign-service's due-now
 *    on a trigger): anyone, the holder included.
 * `ownedByActingSql` is the one predicate; the read, the claim and the pre-responder hand-over all use it.
 *
 * The hand-over guards against a RESPONDER answering on its own initiative. It does not swallow the BRAND's
 * own explicit act (PUSHED-TRUTH-1015, prod 2026-10-15 row 035a85fe: a client pushed a new email to a
 * person whose earlier reply had been handed to its team, the due date stayed NULL, the run claimed nobody,
 * the occurrence was redelivered 6 times and never sent). A `scheduled` statement carrying `statedBy`
 * (the trigger occurrence through which the brand named this person: campaign-service) opens a GRANT
 * (`followup_stated_*`, migration 0092): on a handed row the due date stands, and the HOLDING campaign
 * (acting = the row's campaign) may claim it ONCE; the claim consumes the grant. Any other acting campaign
 * (a responder on a predecessor's queue) is refused exactly as before, and the hand-over itself (time,
 * reasons, stop reason) is untouched. A later hand-over closes an open grant. `handedClaimableSql` is
 * the one predicate, used by the read and the claim.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { followupActionInsert } from "./followup-actions.js";
import { fetchCampaign } from "./campaign-client.js";
import {
  ClaimJudgeBudget,
  ClaimRelationshipUnavailableError,
  NOT_A_LEAD_REASON,
  RELATIONSHIP_STOP_REASON,
  gateFollowupCandidate,
  type ClaimPendingReason,
  type ClaimRelationshipPolicy,
} from "./followup-relationship-gate.js";
import type { RelationshipTag } from "./relationship-tags.js";
import { loadHumanFacts } from "./human-opt-out-read.js";
import { phoneValueSql } from "./e164-phone.js";

/**
 * May the ACTING campaign take this row's current debt? See the module header: own-set = holder only,
 * set by another campaign = anyone but the holder, observer-set (NULL) = anyone. `alias` is the
 * `leads_campaigns` alias in the statement (empty = the bare table).
 */
export function ownedByActingSql(actingCampaignId: string, alias: "lc" | "" = "lc") {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`(${col("followup_due_set_by_campaign_id")} IS NULL OR (${col("followup_due_set_by_campaign_id")} = ${col("campaign_id")}) = (${col("campaign_id")} = ${actingCampaignId}))`;
}

/**
 * A handed row is claimable ONLY through an open grant (the brand stated this person through an occurrence
 * and no claim has consumed it yet), and only by the holding campaign. Unhanded rows: unchanged.
 */
/**
 * A journalist of the brand is never claimed (JOURNALISTS-NOT-LEADS-1016, brand-journalists.ts): no follow-up, no
 * reactive booking. Same predicate in the read, the claim and the owed read.
 */
export function notJournalistSql(alias: "lc" | "" = "lc") {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : `leads_campaigns.${name}`);
  return sql`NOT EXISTS (SELECT 1 FROM brand_journalists bj_f WHERE bj_f.lead_id = ${col("lead_id")} AND bj_f.journalist
    AND bj_f.org_id = ${col("org_id")} AND bj_f.brand_id = ANY(${col("brand_ids")}))`;
}

export function handedClaimableSql(actingCampaignId: string, alias: "lc" | "" = "lc") {
  const col = (name: string) => sql.raw(alias ? `${alias}.${name}` : name);
  return sql`(${col("followup_handed_at")} IS NULL OR (${col("followup_stated_event_id")} IS NOT NULL AND ${col("followup_stated_closed_at")} IS NULL AND ${col("campaign_id")} = ${actingCampaignId}))`;
}

/** Why a pre-responder debt was handed over (stored on the row, `followup_handed_reason`). */
export const OWED_BEFORE_RESPONDER_REASON = "owed_before_responder_started";

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

/**
 * Outcomes that make the person a CUSTOMER of the brand. Read on a claim stating a relationship policy, where an
 * occurrence-named row skips the booked stop (OCCURRENCE-POLICY-ADMITS-1019): the ledger's sale is customer
 * evidence the policy refuses on, even before the relationship sweep has tagged the person.
 */
export const FOLLOWUP_WON_OUTCOMES = ["sale", "purchase"] as const;

/**
 * A row a trigger occurrence named and no claim has consumed yet (the open grant `statedBy` on schedule-by-email
 * writes): the claim exists because the brand named THIS person, so under a stated relationship policy it is the
 * policy, never the follow-up loop's booked stop, that decides whether they are answered.
 */
export function openOccurrenceSql() {
  return sql`(lc.followup_stated_event_id IS NOT NULL AND lc.followup_stated_closed_at IS NULL)`;
}

/** Why a claim came back with nobody. Named, never a silent empty. */
export type FollowupEmptyReason =
  /** No row of this campaign is due right now. */
  | "nothing_due"
  /** Every due row is either claimed by another worker or was stopped during this claim. */
  | "all_claimed"
  /** Only under a stated relationship policy: a due person could not be decided yet (`pending[]`); asked again later. */
  | "relationship_pending"
  /** Only under a stated relationship policy: every due person decided was refused (`refused[]`), final. */
  | "relationship_refused";

/** A due person the claim's relationship policy refused: final for that due row (the row is stopped). */
export interface RefusedFollowup {
  leadCampaignId: string;
  leadId: string;
  campaignId: string;
  /** Null for a person known by phone only (`phone` set). */
  email: string | null;
  phone: string | null;
  reason: typeof NOT_A_LEAD_REASON;
  tags: RelationshipTag[];
  unsureTags: RelationshipTag[];
}

/** A due person the claim could not decide yet: the row stays due, nothing is settled. */
export interface PendingFollowup {
  leadCampaignId: string;
  leadId: string;
  campaignId: string;
  email: string | null;
  phone: string | null;
  reason: ClaimPendingReason;
  retryAfterSeconds: number;
}

/** What a claim stating a relationship policy reports beside the person (or nobody). */
export interface RelationshipGateReport {
  policy: ClaimRelationshipPolicy;
  refused: RefusedFollowup[];
  pending: PendingFollowup[];
}

export interface FollowupCandidate {
  /** `leads_campaigns.id` — the lifecycle row, which is what is claimed. */
  id: string;
  leadId: string;
  campaignId: string;
  /**
   * The lead's canonical email. The delivery evidence (opt-out) is keyed on it. NULL for a person known by
   * PHONE only (REPLY-PHONE-ONLY-1015, a WhatsApp writer): `phone` identifies them and the human's opt_out /
   * do_not_contact facts decide the opt-out.
   */
  email: string | null;
  /** The lead's first phone contact method (E.164 as stored), null when none. */
  phone: string | null;
  /** Which brand the delivery evidence is asked for. */
  brandId: string;
  /** Raw `timestamptz`: postgres.js hands these back as `Date` OR `string`. */
  dueAt: Date | string | null;
  followupCount: number;
  lastActionAt: Date | string | null;
  audienceId: string | null;
  /** A live sale (legacy `purchase` included) is on the ledger for this row or lead: a customer. */
  wonOnLedger: boolean;
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
  | "stopped"
  /** The thread is a PERSON's now (client asked to answer, escalated, a human answered): no
   *  automated responder ever claims it again, and unlike a stop a later "scheduled" does NOT
   *  re-enter it. `reason` says to whom / why. */
  | "handed";

export const FOLLOWUP_STATEMENT_KINDS: readonly FollowupStatementKind[] = [
  "scheduled",
  "acted",
  "stopped",
  "handed",
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
  phone: string | null;
  followup_due_at: Date | string | null;
  followup_count: number | string | null;
  followup_last_action_at: Date | string | null;
  audience_id: string | null;
  won_on_ledger: boolean | null;
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
  /** Earliest responder start on this held campaign: a never-answered debt due before it is not claimable. */
  responderStartedAtIso: string;
  /** The campaign that claims (x-campaign-id): only debts that are its to take are read. */
  actingCampaignId: string;
  /**
   * The claim states a relationship policy: a row a trigger occurrence named (open grant) is then read
   * whatever the booked-outcome stop says, and the policy decides (OCCURRENCE-POLICY-ADMITS-1019).
   */
  occurrenceAdmittedByPolicy?: boolean;
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
      EXISTS (
        SELECT 1
        FROM conversion_events cw
        WHERE cw.withdrawn_at IS NULL
          AND cw.event = ANY(${sql.param(FOLLOWUP_WON_OUTCOMES as unknown as string[])}::text[])
          AND (cw.lead_campaign_id = lc.id OR cw.matched_lead_id = lc.lead_id)
      ) AS won_on_ledger,
      lower(em.value) AS email,
      ph.value AS phone
    FROM leads_campaigns lc
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) em ON true
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'phone'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) ph ON true
    WHERE lc.org_id = ${params.orgId}
      AND lc.campaign_id = ${params.campaignId}
      AND lc.followup_due_at IS NOT NULL
      AND lc.followup_due_at <= ${now}
      AND (lc.followup_claimed_at IS NULL OR lc.followup_claimed_at < ${leaseCutoff})
      AND ${handedClaimableSql(params.actingCampaignId)}
      AND ${ownedByActingSql(params.actingCampaignId)}
      AND ${notJournalistSql()}
      AND NOT (COALESCE(lc.followup_count, 0) = 0 AND lc.followup_due_at < ${params.responderStartedAtIso}::timestamptz)
      AND (
        ${params.occurrenceAdmittedByPolicy ? sql`${openOccurrenceSql()} OR ` : sql``}NOT EXISTS (
          SELECT 1
          FROM conversion_events ce
          WHERE ce.withdrawn_at IS NULL
            AND ce.event = ANY(${sql.param(FOLLOWUP_BOOKED_OUTCOMES as unknown as string[])}::text[])
            AND (ce.lead_campaign_id = lc.id OR ce.matched_lead_id = lc.lead_id)
        )
      )
    ORDER BY lc.followup_due_at ASC, lc.id ASC
    LIMIT ${limit}
  `)) as unknown as RawCandidateRow[];

  // A person with neither an email nor a phone cannot be written to by anyone: never handed out.
  return rows
    .filter((r) => Boolean(r.email) || Boolean(r.phone))
    .map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      campaignId: r.campaign_id,
      email: r.email ?? null,
      phone: r.phone ?? null,
      brandId: r.brand_ids[0] ?? "",
      dueAt: r.followup_due_at,
      followupCount: Number(r.followup_count ?? 0),
      lastActionAt: r.followup_last_action_at,
      audienceId: r.audience_id,
      wonOnLedger: Boolean(r.won_on_ledger),
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
  actingCampaignId: string;
  /** The claiming run's workflow version (x-workflow-slug); recorded on the ledger row, null = none stated. */
  workflowSlug?: string | null;
}): Promise<boolean> {
  const now = new Date(params.nowMs).toISOString();
  const leaseCutoff = new Date(params.nowMs - FOLLOWUP_CLAIM_LEASE_MS).toISOString();

  // The ledger row is written by the SAME statement that wins the claim, so a claim can never
  // exist without the record of who took it, and a lost race writes nothing.
  const rows = (await db.execute(sql`
    WITH claimed AS (
      UPDATE leads_campaigns
         SET followup_claimed_at = ${now},
             -- An open grant is consumed by this claim: the brand's statement buys exactly one claim.
             followup_stated_closed_at = CASE
               WHEN followup_stated_event_id IS NOT NULL AND followup_stated_closed_at IS NULL THEN ${now}::timestamptz
               ELSE followup_stated_closed_at END,
             updated_at = ${now}
       WHERE id = ${params.id}
         AND followup_due_at IS NOT NULL
         AND followup_due_at <= ${now}
         AND (followup_claimed_at IS NULL OR followup_claimed_at < ${leaseCutoff})
         AND ${handedClaimableSql(params.actingCampaignId, "")}
         AND ${ownedByActingSql(params.actingCampaignId, "")}
         AND ${notJournalistSql("")}
      RETURNING id, org_id, brand_ids, lead_id, campaign_id
    ), logged AS (
      ${followupActionInsert("claimed", params.actingCampaignId, params.runId, now, sql`claimed`, params.workflowSlug ?? null)}
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

export type FollowupClaim = (
  | { claimed: FollowupCandidate }
  | { claimed: null; reason: FollowupEmptyReason }
) & {
  /** Present ONLY when the claim stated a relationship policy. */
  relationships?: RelationshipGateReport;
};

/**
 * campaign-service could not say when the acting responder started. A claim never proceeds on a
 * guess (the caller answers 502): without the start, a weeks-old backlog is indistinguishable from
 * a reply that landed a minute ago, and answering a thread a person owns cannot be taken back.
 */
export class FollowupResponderStartUnavailableError extends Error {
  constructor(message: string) {
    super(`[followup-queue] responder start unavailable: ${message}`);
    this.name = "FollowupResponderStartUnavailableError";
  }
}

/** A campaign's creation never changes, so one read per acting campaign per process. */
const responderStartCache = new Map<string, string>();

/** Test seam: forget cached starts. */
export function clearResponderStartCache(): void {
  responderStartCache.clear();
}

/**
 * When the acting responder campaign started: campaign-service's `createdAt` on its own row.
 * Read, never inferred (not from the first claim: a responder can poll empty for days first).
 */
export async function resolveResponderStartedAt(
  orgId: string,
  actingCampaignId: string,
  context: FollowupClaimContext,
): Promise<string> {
  const cached = responderStartCache.get(actingCampaignId);
  if (cached) return cached;

  let campaign: Awaited<ReturnType<typeof fetchCampaign>>;
  try {
    campaign = await fetchCampaign(actingCampaignId, orgId, {
      userId: context.userId,
      runId: context.runId,
      brandId: context.brandId,
    });
  } catch (err) {
    throw new FollowupResponderStartUnavailableError(
      `campaign-service unreachable for campaign ${actingCampaignId}: ${String(err)}`,
    );
  }
  if (!campaign) {
    throw new FollowupResponderStartUnavailableError(
      `campaign-service holds no campaign ${actingCampaignId} for org ${orgId}`,
    );
  }
  const raw = (campaign as { createdAt?: unknown }).createdAt;
  const ms = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new FollowupResponderStartUnavailableError(
      `campaign ${actingCampaignId} carries no readable createdAt (${JSON.stringify(raw)})`,
    );
  }
  const iso = new Date(ms).toISOString();
  responderStartCache.set(actingCampaignId, iso);
  return iso;
}

/**
 * Record that this responder drains this held campaign, and return the EARLIEST responder start
 * known for it. Several responders can drain one held campaign (meeting booker, instant call), and
 * a debt that arose while an elder ran is the elder's: a sibling switched on later must not hand it
 * over, so the cut is the minimum, never the acting campaign's own start.
 */
export async function recordResponder(params: {
  heldCampaignId: string;
  actingCampaignId: string;
  actingStartedAtIso: string;
}): Promise<string> {
  const rows = (await db.execute(sql`
    INSERT INTO followup_responders (held_campaign_id, first_responder_campaign_id, first_responder_started_at, updated_at)
    VALUES (${params.heldCampaignId}, ${params.actingCampaignId}, ${params.actingStartedAtIso}::timestamptz, now())
    ON CONFLICT (held_campaign_id) DO UPDATE SET
      first_responder_campaign_id = CASE
        WHEN EXCLUDED.first_responder_started_at < followup_responders.first_responder_started_at
        THEN EXCLUDED.first_responder_campaign_id
        ELSE followup_responders.first_responder_campaign_id END,
      first_responder_started_at = LEAST(followup_responders.first_responder_started_at, EXCLUDED.first_responder_started_at),
      updated_at = CASE
        WHEN EXCLUDED.first_responder_started_at < followup_responders.first_responder_started_at
        THEN now()
        ELSE followup_responders.updated_at END
    RETURNING first_responder_started_at AS started_at
  `)) as unknown as Array<{ started_at: Date | string }>;

  const iso = rows[0] ? toIso(rows[0].started_at) : null;
  if (!iso) {
    throw new FollowupResponderStartUnavailableError(
      `followup_responders returned no start for held campaign ${params.heldCampaignId}`,
    );
  }
  return iso;
}

/**
 * Hand over every never-answered debt of this held campaign that was owed BEFORE any responder
 * started: no responder existed when that reply arrived, so it was a human's to answer (the client
 * was told). Persisted, so the row reads as handed everywhere and never re-enters the queue.
 */
export async function handOverPreResponderDebts(params: {
  orgId: string;
  campaignId: string;
  responderStartedAtIso: string;
  /** Only debts the acting campaign may take are its to hand over (another campaign's own debt is not). */
  actingCampaignId: string;
  nowMs: number;
}): Promise<string[]> {
  const now = new Date(params.nowMs).toISOString();
  const rows = (await db.execute(sql`
    UPDATE leads_campaigns
       SET followup_handed_at = ${now},
           followup_handed_reason = ${OWED_BEFORE_RESPONDER_REASON},
           followup_handed_reasons = ARRAY[${OWED_BEFORE_RESPONDER_REASON}]::text[],
           followup_stopped_reason = ${OWED_BEFORE_RESPONDER_REASON},
           followup_due_at = NULL,
           followup_claimed_at = NULL,
           updated_at = ${now}
     WHERE org_id = ${params.orgId}
       AND campaign_id = ${params.campaignId}
       AND followup_handed_at IS NULL
       AND followup_due_at IS NOT NULL
       AND COALESCE(followup_count, 0) = 0
       AND followup_due_at < ${params.responderStartedAtIso}::timestamptz
       AND ${ownedByActingSql(params.actingCampaignId, "")}
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

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
  /**
   * The campaign the claiming worker was dispatched for (x-campaign-id): recorded on the ledger,
   * and its start decides which debts were ever a responder's. Required: without it a backlog
   * cannot be told from a fresh reply.
   */
  actingCampaignId: string;
  context: FollowupClaimContext;
  nowMs?: number;
  /**
   * The relationship policy the claiming workflow states (REPLY-ANY-LEAD-1015, `followup-relationship-gate.ts`).
   * Absent = today's claim, unchanged.
   */
  relationships?: ClaimRelationshipPolicy;
}): Promise<FollowupClaim> {
  const nowMs = params.nowMs ?? Date.now();

  const actingStartedAtIso = await resolveResponderStartedAt(
    params.orgId,
    params.actingCampaignId,
    params.context,
  );
  const responderStartedAtIso = await recordResponder({
    heldCampaignId: params.campaignId,
    actingCampaignId: params.actingCampaignId,
    actingStartedAtIso,
  });
  const handedIds = await handOverPreResponderDebts({
    orgId: params.orgId,
    campaignId: params.campaignId,
    responderStartedAtIso,
    actingCampaignId: params.actingCampaignId,
    nowMs,
  });
  if (handedIds.length > 0) {
    console.log(
      `[lead-service] followup handed over ${handedIds.length} debt(s) owed before the first responder started campaign=${params.campaignId} acting=${params.actingCampaignId} responderStartedAt=${responderStartedAtIso} ids=${handedIds.join(",")}`,
    );
  }

  const candidates = await loadFollowupCandidates({
    orgId: params.orgId,
    campaignId: params.campaignId,
    nowMs,
    responderStartedAtIso,
    actingCampaignId: params.actingCampaignId,
    occurrenceAdmittedByPolicy: Boolean(params.relationships),
  });
  const report: RelationshipGateReport | undefined = params.relationships
    ? { policy: params.relationships, refused: [], pending: [] }
    : undefined;
  const withReport = (claim: FollowupClaim): FollowupClaim => (report ? { ...claim, relationships: report } : claim);
  if (candidates.length === 0) return withReport({ claimed: null, reason: "nothing_due" });

  // One gateway call per brand present in the window — in practice exactly one, because a
  // campaign's rows share a brand.
  const byBrand = new Map<string, FollowupCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.email) continue; // phone-only: no email evidence to ask, the human's facts decide below
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
        bucket.map((c) => ({ email: c.email as string })),
        forwardableContext(params.context),
      );
      results = response.results;
    } catch (err) {
      throw new FollowupOptOutLookupError(err);
    }
    for (const result of results) statusByEmail.set(result.email.toLowerCase(), result);
  }

  // A person known by phone only: the email sender has nothing to say; their human's live opt_out /
  // do_not_contact fact is the opt-out (the same facts a stated filing is suppressed on).
  const phoneOnly = candidates.filter((c) => !c.email);
  const humanFacts = phoneOnly.length > 0 ? await loadHumanFacts(phoneOnly.map((c) => c.leadId)) : null;

  const optedOutIds: string[] = [];
  const answerable: FollowupCandidate[] = [];
  for (const candidate of candidates) {
    const human = candidate.email ? null : humanFacts?.get(candidate.leadId);
    const optedOut = candidate.email
      ? isOptedOut(statusByEmail.get(candidate.email), params.campaignId)
      : Boolean(human?.optedOut || human?.doNotContact);
    if (optedOut) {
      optedOutIds.push(candidate.id);
    } else {
      answerable.push(candidate);
    }
  }

  // They are owed nothing further whether or not we hand anyone back this poll, and clearing them
  // is what keeps the next poll's window (and its gateway call) small.
  await stopFollowups(optedOutIds, "opted_out", nowMs);

  const budget = report ? new ClaimJudgeBudget(params.runId) : null;
  try {
    for (const candidate of answerable) {
      if (report && budget) {
        let verdict: Awaited<ReturnType<typeof gateFollowupCandidate>>;
        try {
          // A sale on the ledger is a customer, whatever the relationship sweep has tagged yet: refused by the policy.
          verdict = candidate.wonOnLedger
            ? { kind: "refuse", reason: NOT_A_LEAD_REASON, tags: ["customer"], unsureTags: [] }
            : await gateFollowupCandidate({
            orgId: params.orgId,
            brandId: candidate.brandId,
            leadId: candidate.leadId,
            email: candidate.email,
            phone: candidate.phone,
            budget,
          });
        } catch (err) {
          throw new ClaimRelationshipUnavailableError(err);
        }
        const who = {
          leadCampaignId: candidate.id,
          leadId: candidate.leadId,
          campaignId: candidate.campaignId,
          email: candidate.email,
          phone: candidate.phone,
        };
        if (verdict.kind === "refuse") {
          // Final for this due row: stopped, so the queue never offers it again (a later `scheduled` re-decides).
          await stopFollowups([candidate.id], RELATIONSHIP_STOP_REASON, nowMs);
          report.refused.push({ ...who, reason: verdict.reason, tags: verdict.tags, unsureTags: verdict.unsureTags });
          console.log(
            `[lead-service] followup refused by relationship policy ${report.policy} campaign=${params.campaignId} leadCampaignId=${candidate.id} email=${candidate.email ?? `phone:${candidate.phone}`} tags=${verdict.tags.join("+")} unsure=${verdict.unsureTags.join("+")}`,
          );
          continue;
        }
        if (verdict.kind === "pending") {
          report.pending.push({ ...who, reason: verdict.reason, retryAfterSeconds: verdict.retryAfterSeconds });
          continue;
        }
      }
      const claimed = await claimFollowup({
        id: candidate.id,
        nowMs,
        runId: params.runId,
        actingCampaignId: params.actingCampaignId,
        workflowSlug: params.context.workflowSlug ?? null,
      });
      if (claimed) {
        console.log(
          `[lead-service] followup claimed campaign=${params.campaignId} leadCampaignId=${candidate.id} email=${candidate.email ?? `phone:${candidate.phone}`} followupCount=${candidate.followupCount} due=${candidates.length} optedOut=${optedOutIds.length}`,
        );
        return withReport({ claimed: candidate });
      }
      // Lost the race to a concurrent worker — try the next one.
    }
  } finally {
    await budget?.close();
  }

  if (report && report.pending.length > 0) return withReport({ claimed: null, reason: "relationship_pending" });
  if (report && report.refused.length > 0) return withReport({ claimed: null, reason: "relationship_refused" });
  return withReport({ claimed: null, reason: "all_claimed" });
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
  /** When the thread was handed to a person; null = an automated responder may still claim it. */
  handedAt: string | null;
  handedReason: string | null;
  /**
   * The last hand-over that was WITHDRAWN by the observer that stated it (its verdict turned out wrong),
   * kept as history; null = none ever was. A withdrawn hand-over no longer holds the row.
   */
  handoverWithdrawal: {
    withdrawnAt: string;
    reason: string | null;
    handedAt: string | null;
    handedReasons: string[];
  } | null;
  /**
   * Who set the current due date (the writer's x-campaign-id), which decides who may claim it: the row's
   * own campaign = only it; another campaign = anyone but the holder; null = an observer, anyone.
   */
  dueSetByCampaignId: string | null;
  /**
   * The last trigger occurrence through which the brand named this person and made them due
   * (`statedBy` on schedule-by-email); null = none ever did. `closedAt` = when the grant was used up (a
   * claim consumed it, or a later hand-over closed it); null = still open: on a handed row it is what lets
   * the holding campaign claim the person once.
   */
  statedOccurrence: {
    triggerEventId: string;
    triggerId: string | null;
    statedAt: string | null;
    closedAt: string | null;
  } | null;
}

/** The trigger occurrence through which the brand itself names this person (campaign-service). */
export interface FollowupOccurrenceStatement {
  triggerEventId: string;
  triggerId?: string | null;
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
  followup_handed_at?: Date | string | null;
  followup_handed_reason?: string | null;
  followup_due_set_by_campaign_id?: string | null;
  followup_handover_withdrawn_at?: Date | string | null;
  followup_handover_withdrawn_reason?: string | null;
  followup_handover_withdrawn_handed_at?: Date | string | null;
  followup_handover_withdrawn_handed_reasons?: string[] | null;
  followup_stated_event_id?: string | null;
  followup_stated_trigger_id?: string | null;
  followup_stated_at?: Date | string | null;
  followup_stated_closed_at?: Date | string | null;
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
    handedAt: toIso(row.followup_handed_at ?? null),
    handedReason: row.followup_handed_reason ?? null,
    dueSetByCampaignId: row.followup_due_set_by_campaign_id ?? null,
    handoverWithdrawal: withdrawalOf(row),
    statedOccurrence: row.followup_stated_event_id
      ? {
          triggerEventId: row.followup_stated_event_id,
          triggerId: row.followup_stated_trigger_id ?? null,
          statedAt: toIso(row.followup_stated_at ?? null),
          closedAt: toIso(row.followup_stated_closed_at ?? null),
        }
      : null,
  };
}

function withdrawalOf(row: RawStateRow): FollowupState["handoverWithdrawal"] {
  const withdrawnAt = toIso(row.followup_handover_withdrawn_at ?? null);
  if (!withdrawnAt) return null;
  return {
    withdrawnAt,
    reason: row.followup_handover_withdrawn_reason ?? null,
    handedAt: toIso(row.followup_handover_withdrawn_handed_at ?? null),
    handedReasons: row.followup_handover_withdrawn_handed_reasons ?? [],
  };
}

const STATE_COLUMNS = sql`
  id, lead_id, campaign_id, followup_due_at, followup_claimed_at,
  COALESCE(followup_count, 0) AS followup_count,
  followup_last_action_at, followup_stopped_reason,
  followup_handed_at, followup_handed_reason, followup_due_set_by_campaign_id,
  followup_handover_withdrawn_at, followup_handover_withdrawn_reason,
  followup_handover_withdrawn_handed_at, followup_handover_withdrawn_handed_reasons,
  followup_stated_event_id, followup_stated_trigger_id, followup_stated_at, followup_stated_closed_at
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
 *  - handed: the thread is a person's. No due date, the claim is released, `followup_handed_at`
 *    is stamped once (the first hand-over's time and reason are kept). Permanent: on a handed row
 *    every later statement leaves the due date NULL and the stop reason as the hand-over wrote it,
 *    and closes any open grant.
 *
 * `statedBy` (scheduled only): the brand named this person through a trigger occurrence. It opens a grant
 * (see the module header): the due date stands even on a handed row, and the holder may claim it once.
 * The hand-over's own fields and the stop reason are left exactly as they were.
 */
export async function writeFollowupStatement(params: {
  orgId: string;
  id: string;
  kind: FollowupStatementKind;
  dueAtIso: string | null;
  reason: string | null;
  nowMs: number;
  /**
   * The writer's x-campaign-id: recorded on the ledger for an 'acted' statement, and, on every statement that
   * sets a due date ('scheduled', 'acted'), as WHO SET it (`followup_due_set_by_campaign_id`), which decides
   * who may claim it. Absent = an observer (anyone may claim).
   */
  actingCampaignId?: string | null;
  runId?: string | null;
  /** The writing run's workflow version (x-workflow-slug): recorded on an 'acted' ledger row, null = none stated. */
  workflowSlug?: string | null;
  /** The occurrence through which the brand named this person (scheduled only; ignored otherwise). */
  statedBy?: FollowupOccurrenceStatement | null;
}): Promise<FollowupState | null> {
  const now = new Date(params.nowMs).toISOString();
  const acted = params.kind === "acted";
  const handed = params.kind === "handed";
  const setsDue = params.kind === "scheduled" || params.kind === "acted";
  const stated = params.kind === "scheduled" && params.statedBy ? params.statedBy : null;

  // An 'acted' statement is also a ledger row, written by the same statement: the count on the
  // lifecycle row says HOW MANY answers were sent, the ledger says WHICH campaign's worker sent each.
  const rows = (await db.execute(sql`
    WITH updated AS (
      UPDATE leads_campaigns
         SET followup_due_at = ${
               handed
                 ? sql`NULL`
                 : stated
                   ? sql`${params.dueAtIso}::timestamptz`
                   : sql`CASE WHEN followup_handed_at IS NULL THEN ${params.dueAtIso}::timestamptz ELSE NULL END`
             },
             followup_stated_event_id = ${stated ? sql`${stated.triggerEventId}` : sql`followup_stated_event_id`},
             followup_stated_trigger_id = ${stated ? sql`${stated.triggerId ?? null}` : sql`followup_stated_trigger_id`},
             followup_stated_at = ${stated ? sql`${now}::timestamptz` : sql`followup_stated_at`},
             followup_stated_closed_at = ${
               stated
                 ? sql`NULL`
                 : handed
                   ? sql`CASE WHEN followup_stated_event_id IS NOT NULL AND followup_stated_closed_at IS NULL THEN ${now}::timestamptz ELSE followup_stated_closed_at END`
                   : sql`followup_stated_closed_at`
             },
             followup_due_set_by_campaign_id = ${setsDue ? sql`${params.actingCampaignId ?? null}` : sql`followup_due_set_by_campaign_id`},
             followup_handed_at = ${handed ? sql`COALESCE(followup_handed_at, ${now}::timestamptz)` : sql`followup_handed_at`},
             followup_handed_reason = ${handed ? sql`COALESCE(followup_handed_reason, ${params.reason})` : sql`followup_handed_reason`},
             followup_handed_reasons = ${
               handed
                 ? sql`CASE WHEN followup_handed_at IS NULL THEN ARRAY[${params.reason}]::text[]
                            ELSE array_append(COALESCE(followup_handed_reasons, ARRAY[followup_handed_reason]::text[]), ${params.reason}::text) END`
                 : sql`followup_handed_reasons`
             },
             followup_claimed_at = NULL,
             followup_count = COALESCE(followup_count, 0) + ${acted ? 1 : 0},
             followup_last_action_at = ${acted ? now : sql`followup_last_action_at`},
             followup_stopped_reason = ${
               handed
                 ? sql`${params.reason}`
                 : sql`CASE WHEN followup_handed_at IS NULL THEN ${params.reason} ELSE followup_stopped_reason END`
             },
             updated_at = ${now}
       WHERE id = ${params.id} AND org_id = ${params.orgId}
      RETURNING ${STATE_COLUMNS}, org_id, brand_ids
    )${
      acted
        ? sql`, logged AS (
      ${followupActionInsert("acted", params.actingCampaignId ?? null, params.runId ?? null, now, sql`updated`, params.workflowSlug ?? null)}
    )`
        : sql``
    }
    SELECT ${STATE_COLUMNS} FROM updated
  `)) as unknown as RawStateRow[];

  return rows[0] ? toState(rows[0]) : null;
}

/**
 * Withdraw a hand-over whose verdict turned out WRONG (2026-10-13, DefiniteJobs: a positive reply was
 * judged off topic and handed over; the classifier was fixed and the reply re-judged positive).
 *
 * The caller names the hand-over it stated by the REASON it wrote. The row is lifted only when every
 * hand-over on it named exactly that reason (`followup_handed_reasons`), so a hand-over anyone else
 * stated (a person answered by hand, the client was asked, the claim's own pre-responder hand-over)
 * is never lifted by it: the Shockwavecenters guarantee holds. The pre-responder hand-over is the
 * claim's, never an observer's, and is never withdrawable by naming it.
 *
 * Lifted = the row is as if never handed (no due date, claim released, stop reason = why it was
 * withdrawn) and the lifted hand-over is kept as history; a later `scheduled` re-enters it like a
 * fresh row. Nothing re-enters the queue by itself. Anything else is a no-op, named.
 */
export type HandoverWithdrawalOutcome =
  | { outcome: "lifted"; state: FollowupState }
  | {
      outcome: "nothing_to_lift";
      /** not_handed: the row holds no hand-over. reason_mismatch: a hand-over on it names another reason. */
      cause: "not_handed" | "reason_mismatch";
      state: FollowupState;
    }
  | { outcome: "row_not_found" };

export async function withdrawHandover(params: {
  orgId: string;
  id: string;
  handedReason: string;
  reason: string;
  nowMs: number;
}): Promise<HandoverWithdrawalOutcome> {
  const now = new Date(params.nowMs).toISOString();
  const rows = (await db.execute(sql`
    UPDATE leads_campaigns
       SET followup_handover_withdrawn_at = ${now},
           followup_handover_withdrawn_reason = ${params.reason},
           followup_handover_withdrawn_handed_at = followup_handed_at,
           followup_handover_withdrawn_handed_reasons = followup_handed_reasons,
           followup_handed_at = NULL,
           followup_handed_reason = NULL,
           followup_handed_reasons = NULL,
           followup_due_at = NULL,
           followup_claimed_at = NULL,
           followup_stopped_reason = ${params.reason},
           updated_at = ${now}
     WHERE id = ${params.id} AND org_id = ${params.orgId}
       AND followup_handed_at IS NOT NULL
       AND ${params.handedReason}::text <> ${OWED_BEFORE_RESPONDER_REASON}
       AND cardinality(followup_handed_reasons) > 0
       AND ${params.handedReason}::text = ALL(followup_handed_reasons)
    RETURNING ${STATE_COLUMNS}
  `)) as unknown as RawStateRow[];
  if (rows[0]) return { outcome: "lifted", state: toState(rows[0]) };

  const state = await readFollowupState(params.orgId, params.id);
  if (!state) return { outcome: "row_not_found" };
  return { outcome: "nothing_to_lift", cause: state.handedAt ? "reason_mismatch" : "not_handed", state };
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

/**
 * From a PHONE to the row that carries the debt (REPLY-PHONE-ONLY-1015): a person known by phone only (a
 * WhatsApp writer with no email). Same exactness as the email lookup: equality on the registered `phone`
 * contact method (separators ignored on both sides, `e164-phone.ts`), scoped to org + the campaign named;
 * several rows = `ambiguous_lead`, never a pick.
 */
export type FollowupLeadPhoneLookup =
  | { ok: true; id: string; leadId: string; phone: string }
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "ambiguous_lead"; matches: Array<{ id: string; leadId: string; phone: string }> };

export async function lookupFollowupRowByPhone(params: {
  orgId: string;
  campaignId: string;
  /** E.164 (`canonicalE164`). */
  phone: string;
}): Promise<FollowupLeadPhoneLookup> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (lc.id) lc.id, lc.lead_id, cm.value AS phone
    FROM leads_campaigns lc
    JOIN lead_contact_methods cm
      ON cm.lead_id = lc.lead_id
     AND cm.channel = 'phone'
     AND ${phoneValueSql(sql`cm.value`)} = ${params.phone}
    WHERE lc.org_id = ${params.orgId}
      AND lc.campaign_id = ${params.campaignId}
    ORDER BY lc.id ASC, cm.value ASC
    LIMIT 5
  `)) as unknown as Array<{ id: string; lead_id: string; phone: string }>;

  if (rows.length === 0) return { ok: false, code: "lead_not_found" };
  if (rows.length > 1) {
    return { ok: false, code: "ambiguous_lead", matches: rows.map((r) => ({ id: r.id, leadId: r.lead_id, phone: r.phone })) };
  }
  return { ok: true, id: rows[0].id, leadId: rows[0].lead_id, phone: rows[0].phone };
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
