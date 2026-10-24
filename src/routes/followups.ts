/**
 * The follow-up debt, on the wire.
 *
 * Three operations, and they are deliberately the whole surface: a worker CLAIMS the next person
 * due on a campaign (at most one, exactly once), RECORDS what it did and when the next action is
 * owed, and anyone can READ one row's state back. See `src/lib/followup-queue.ts` for why the
 * claim is a conditional UPDATE and why the interval is the worker's choice rather than a ladder.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { canonicalE164 } from "../lib/e164-phone.js";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import {
  FOLLOWUP_DUE_MAX_HORIZON_MS,
  FOLLOWUP_DUE_PAST_TOLERANCE_MS,
  FollowupOptOutLookupError,
  FollowupResponderStartUnavailableError,
  dueDateBounds,
  lookupFollowupRowByEmail,
  lookupFollowupRowByPhone,
  parseDueDate,
  claimPersonKeys,
  pickFollowupCandidate,
  readFollowupState,
  withdrawHandover,
  writeFollowupStatement,
} from "../lib/followup-queue.js";
import { readFollowupActions, recordActedByEmail } from "../lib/followup-actions.js";
import { readFollowupOwed } from "../lib/followup-owed.js";
import {
  CLAIM_RELATIONSHIP_POLICIES,
  ClaimRelationshipUnavailableError,
  isClaimRelationshipPolicy,
} from "../lib/followup-relationship-gate.js";
import type { FollowupEmptyReason, RelationshipGateReport } from "../lib/followup-queue.js";

const router = Router();

// Express 4 does not forward async handler rejections to the error middleware — an unguarded
// throw hangs the caller's socket instead of answering. Wrap so a DB error is a clean 500.
function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

/** Which "nobody" says the most when several held campaigns answered empty (the highest wins). */
const EMPTY_REASON_RANK: Record<FollowupEmptyReason, number> = {
  nothing_due: 0,
  all_claimed: 1,
  relationship_refused: 2,
  relationship_pending: 3,
};

/** `leads_campaigns.id` is a uuid column, so anything else is a caller error, not a miss. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The LLM alias a run wrote one message with (BEST-TPL-LLM-1022-LS), stored on the `acted` ledger row and served
 * on the sent-messages read. Stated by the acting run, never derived here.
 */
const LlmAliasSchema = z.string().trim().min(1).max(200);

const FollowupStatementBodySchema = z.object({
  kind: z.enum(["scheduled", "acted", "stopped", "handed"]),
  dueAt: z.string().optional(),
  nextDueAt: z.string().optional(),
  reason: z.string().optional(),
  llmAlias: LlmAliasSchema.optional(),
});

const WithdrawHandoverBodySchema = z.object({
  handedReason: z.string(),
  reason: z.string(),
});

const ActedByEmailBodySchema = z.object({
  email: z.string().trim().min(3).max(320),
  llmAlias: LlmAliasSchema.optional(),
});

// `email` identifies the person whenever present (byte-identical). Without it, `phone` (E.164) identifies them
// (REPLY-PHONE-ONLY-1015: a WhatsApp writer known by phone only).
type FailedLookup =
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "ambiguous_lead"; matches: Array<Record<string, string>> };

const ScheduleByEmailBodySchema = z
  .object({
  email: z.string().trim().min(3).max(320).nullish(),
  phone: z.string().trim().min(3).max(50).nullish(),
  dueAt: z.string(),
  // The trigger occurrence through which the BRAND names this person (campaign-service, same object as on
  // the filing): opens a grant the holding campaign may claim once, even on a handed row.
  statedBy: z
    .object({
      triggerEventId: z.string().trim().min(1).max(200),
      triggerId: z.string().trim().min(1).max(200).nullish(),
    })
    .nullish(),
  })
  .superRefine((body, ctx) => {
    if (body.email) return;
    if (!body.phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "email or phone (E.164) is required" });
    } else if (!canonicalE164(body.phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "with no email, phone identifies the person and must be E.164 (e.g. +33612345678)",
      });
    }
  });

/**
 * Why a schedule-by-email statement left the person NOT due, in words a caller can hand to its client.
 * Only a hand-over without the brand's statement leaves the due date NULL after a `scheduled` today; any
 * other cause is named generically rather than answered as success.
 */
function notMadeDueOf(state: { dueAt: string | null; handedAt: string | null; handedReason: string | null; stoppedReason: string | null }) {
  if (state.dueAt) return null;
  if (state.handedAt) {
    return {
      code: "handed" as const,
      reason:
        "This person's conversation was handed to the brand's team, so no automated workflow writes to them on its own. " +
        `Hand-over: ${state.stoppedReason ?? state.handedReason ?? "no reason recorded"}`,
    };
  }
  return {
    code: "not_due" as const,
    reason: state.stoppedReason ?? "The follow-up schedule was left empty.",
  };
}

function boundsPayload(nowMs: number) {
  const bounds = dueDateBounds(nowMs);
  return {
    earliest: new Date(bounds.minMs).toISOString(),
    latest: new Date(bounds.maxMs).toISOString(),
    pastToleranceMs: FOLLOWUP_DUE_PAST_TOLERANCE_MS,
    maxHorizonMs: FOLLOWUP_DUE_MAX_HORIZON_MS,
  };
}

/**
 * Claim the next person due for a follow-up on this campaign.
 *
 * At most one, exactly once: the claim is an atomic conditional UPDATE, so two workers polling in
 * the same instant get different people or one gets nobody — never the same person twice.
 *
 * The scope is the campaign id the caller names, not its identity family. A campaign-scoped READ
 * of this service answers for the whole family because it TOTALS a population; this claims a
 * single row whose due date some worker wrote while naming that exact campaign, so widening it
 * would hand a worker somebody another campaign's schedule owns.
 *
 * `alsoCampaignIds` (optional body) names MORE held campaigns, each exactly, tried in order after
 * the path one; the first person claimed wins. A responder whose preceding leg runs on several
 * campaigns at once (cold email AND cold WhatsApp opening conversations for one offer) answers the
 * people of each in one run, instead of the run failing because it cannot pick one (campaign
 * 67a0eb30, 2026-10-12). Every campaign is still claimed on its own exact id.
 */
router.post(
  "/orgs/campaigns/:campaignId/followups/claim-next",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    if (!campaignId) {
      res.status(400).json({ error: "campaignId required" });
      return;
    }
    // Which responder is claiming decides which debts were ever a responder's (a reply owed before
    // any responder started was a human's). Without it a weeks-old backlog reads like a fresh reply,
    // so the claim is refused rather than made on a guess.
    if (!req.campaignId) {
      res.status(400).json({
        error: "x-campaign-id (the responder campaign that claims) is required",
        code: "acting_campaign_required",
      });
      return;
    }

    const also: unknown = req.body?.alsoCampaignIds;
    if (also !== undefined && also !== null && (!Array.isArray(also) || also.some((id) => typeof id !== "string" || id.length === 0))) {
      res.status(400).json({ error: "alsoCampaignIds must be an array of campaign ids", code: "invalid_also_campaign_ids" });
      return;
    }
    const heldCampaignIds = [...new Set([campaignId, ...((also as string[] | null | undefined) ?? [])])];

    // The relationship policy of the claiming pipe's strategy (REPLY-ANY-LEAD-1015). Absent = today's claim.
    const relationships: unknown = req.body?.relationships;
    if (relationships !== undefined && relationships !== null && !isClaimRelationshipPolicy(relationships)) {
      res.status(400).json({
        error: `relationships must be one of: ${CLAIM_RELATIONSHIP_POLICIES.join(", ")}`,
        code: "unknown_relationship_policy",
      });
      return;
    }
    const policy = isClaimRelationshipPolicy(relationships) ? relationships : undefined;

    // The person the run's trigger occurrence names (CLAIM-OCCURRENCE-PERSON-1025): only their row is claimed.
    const rawPerson: unknown = req.body?.person;
    if (rawPerson !== undefined && rawPerson !== null && typeof rawPerson !== "object") {
      res.status(400).json({ error: "person must be an object {email?, phone?, leadId?}", code: "invalid_person" });
      return;
    }
    const person = claimPersonKeys(rawPerson);
    const report: RelationshipGateReport | undefined = policy ? { policy, refused: [], pending: [] } : undefined;

    try {
      let result: Awaited<ReturnType<typeof pickFollowupCandidate>> | null = null;
      let reasonNobody: FollowupEmptyReason | undefined;
      for (const heldCampaignId of heldCampaignIds) {
        const attempt = await pickFollowupCandidate({
          orgId: req.orgId as string,
          campaignId: heldCampaignId,
          runId: req.runId ?? null,
          // The campaign this worker was DISPATCHED for. For an internal leg it is not the campaign
          // named in the path (that one holds the person), and it is what the ledger attributes to.
          actingCampaignId: req.campaignId,
          context: {
            orgId: req.orgId,
            userId: req.userId,
            runId: req.runId,
            campaignId: heldCampaignId,
            brandId: req.brandId,
            workflowSlug: req.workflowSlug,
            featureSlug: req.featureSlug,
            audienceId: req.audienceId,
          },
          ...(policy ? { relationships: policy } : {}),
          ...(person ? { person } : {}),
        });
        if (report && attempt.relationships) {
          report.refused.push(...attempt.relationships.refused);
          report.pending.push(...attempt.relationships.pending);
        }
        if (attempt.claimed) {
          result = attempt;
          break;
        }
        // "Someone was due but taken" says more than "nobody was due", whichever queue said it; a person
        // still undecided says more than one refused (they are still owed, the caller asks again).
        if (reasonNobody === undefined || EMPTY_REASON_RANK[attempt.reason] > EMPTY_REASON_RANK[reasonNobody]) reasonNobody = attempt.reason;
      }

      if (!result?.claimed) {
        res.json({ found: false, reason: reasonNobody, ...(report ? { relationships: report } : {}) });
        return;
      }

      const candidate = result.claimed;
      res.json({
        found: true,
        followup: {
          id: candidate.id,
          leadId: candidate.leadId,
          campaignId: candidate.campaignId,
          brandId: candidate.brandId,
          email: candidate.email,
          phone: candidate.phone,
          audienceId: candidate.audienceId,
          dueAt: candidate.dueAt instanceof Date ? candidate.dueAt.toISOString() : candidate.dueAt,
          followupCount: candidate.followupCount,
          lastActionAt:
            candidate.lastActionAt instanceof Date
              ? candidate.lastActionAt.toISOString()
              : candidate.lastActionAt,
        },
        ...(report ? { relationships: report } : {}),
      });
    } catch (err) {
      if (err instanceof ClaimRelationshipUnavailableError) {
        // Fail loud: never answer a person whose relationship to the brand could not be read.
        console.error(`[lead-service] followup claim failed campaign=${campaignId}:`, err);
        res.status(502).json({
          error: "Who this person is to the brand could not be read, so the relationship policy cannot be honoured",
          code: "relationships_unavailable",
        });
        return;
      }
      if (err instanceof FollowupOptOutLookupError) {
        // Fail loud. A claim never proceeds on a guess about who opted out: the cost of returning
        // nobody is a wasted poll, the cost of guessing is an email to somebody who asked us to
        // stop.
        console.error(`[lead-service] followup claim failed campaign=${campaignId}:`, err);
        res.status(502).json({
          error: "Delivery status unavailable, so opt-outs cannot be honoured",
          code: "opt_out_lookup_unavailable",
        });
        return;
      }
      if (err instanceof FollowupResponderStartUnavailableError) {
        console.error(`[lead-service] followup claim failed campaign=${campaignId}:`, err);
        res.status(502).json({
          error: "campaign-service could not say when the claiming responder started, so a backlog cannot be told from a fresh reply",
          code: "responder_start_unavailable",
        });
        return;
      }
      throw err;
    }
  }),
);

/**
 * State that an answer is owed to a person we know by EMAIL, on this campaign.
 *
 * The debt queue works and nothing ever enqueued into it: measured in production, zero rows across
 * the fleet carried a due date, so the worker that claims the next person due always came back
 * empty and no interested prospect was ever answered. Both sides assumed the other seeded it. The
 * service that qualifies a reply is the one that knows we owe an answer, and it does NOT hold this
 * service's `leads_campaigns.id` — it holds the campaign and the person's address. This is that
 * door, and it is the whole difference between the queue existing and the queue running.
 *
 * Identification is EXACT (see `lookupFollowupRowByEmail`). An unknown address is a 404 and an
 * address that case-folds onto more than one row is a 409, both NAMED: a silent no-op would leave
 * the caller believing the debt was recorded, and a best guess would email somebody who never
 * replied.
 *
 * Everything after the lookup is the existing `scheduled` write, unchanged — so the queue's stop
 * conditions (opted out, a booked meeting on record) apply to a row enqueued this way exactly as
 * they apply to any other: they are enforced at CLAIM time, which is the only moment they can be
 * read honestly anyway.
 */
router.post(
  "/orgs/campaigns/:campaignId/followups/schedule-by-email",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    if (!campaignId) {
      res.status(400).json({ error: "campaignId required" });
      return;
    }

    const parsed = ScheduleByEmailBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const nowMs = Date.now();

    const due = parseDueDate(parsed.data.dueAt, nowMs);
    if (!due.ok) {
      res.status(400).json({
        error:
          due.code === "due_date_unparseable"
            ? "dueAt must be an ISO-8601 timestamp"
            : "dueAt is outside the accepted range: never in the past, never further out than the horizon",
        code: due.code,
        bounds: boundsPayload(nowMs),
      });
      return;
    }

    const byPhone = !parsed.data.email;
    const notFound = byPhone ? "No lead on this campaign holds that phone" : "No lead on this campaign holds that email address";
    const lookup: { ok: true; id: string; leadId: string; email: string | null; phone?: string } | FailedLookup =
      byPhone
        ? await lookupFollowupRowByPhone({
            orgId: req.orgId as string,
            campaignId,
            phone: canonicalE164(parsed.data.phone) as string,
          }).then((l) => (l.ok ? { ok: true as const, id: l.id, leadId: l.leadId, email: null, phone: l.phone } : l))
        : await lookupFollowupRowByEmail({
            orgId: req.orgId as string,
            campaignId,
            email: parsed.data.email as string,
          });

    if (!lookup.ok) {
      if (lookup.code === "ambiguous_lead") {
        res.status(409).json({
          error: byPhone
            ? "That phone matches more than one lead row on this campaign, so which person is owed an answer cannot be decided here"
            : "That address matches more than one lead row on this campaign, so which person is owed an answer cannot be decided here",
          code: "ambiguous_lead",
          matches: lookup.matches,
        });
        return;
      }
      res.status(404).json({
        error: notFound,
        code: "lead_not_found",
      });
      return;
    }

    const state = await writeFollowupStatement({
      orgId: req.orgId as string,
      id: lookup.id,
      kind: "scheduled",
      dueAtIso: due.iso,
      reason: null,
      nowMs,
      // WHO set the due date decides who may claim it: a campaign scheduling its own person (its run names
      // itself) keeps the debt for itself; an observer sends no x-campaign-id and anyone may claim it.
      actingCampaignId: req.campaignId ?? null,
      statedBy: parsed.data.statedBy
        ? { triggerEventId: parsed.data.statedBy.triggerEventId, triggerId: parsed.data.statedBy.triggerId ?? null }
        : null,
    });

    // The lookup already proved the row is this org's, so a miss here is a row deleted between the
    // two statements — vanishingly rare, and still answered rather than swallowed.
    if (!state) {
      res.status(404).json({
        error: notFound,
        code: "lead_not_found",
      });
      return;
    }

    const notMadeDue = notMadeDueOf(state);
    console.log(
      `[lead-service] followup scheduled by ${byPhone ? "phone" : "email"} campaign=${campaignId} leadCampaignId=${lookup.id} due=${state.dueAt ?? "NOT_DUE"} setBy=${req.campaignId ?? "observer"} statedBy=${parsed.data.statedBy?.triggerEventId ?? "-"}${notMadeDue ? ` notMadeDue=${notMadeDue.code}` : ""}`,
    );

    // 200 either way (the statement was recorded), but never one that reads as success when nobody was made
    // due: `madeDue` + `notMadeDue` say so, and `followup.dueAt` is null.
    res.json({
      followup: state,
      leadId: lookup.leadId,
      email: lookup.email,
      ...(byPhone ? { phone: lookup.phone } : {}),
      madeDue: notMadeDue === null,
      notMadeDue,
    });
  }),
);

/**
 * An acting campaign acted on a person OUTSIDE the queue: record it in the follow-up ledger.
 *
 * AI Instant Call rings the brand's rep about a sales-interest reply under its own campaign and
 * never claims anybody here, so without this door its conversation counts read zero while it was
 * placing calls. The path campaign is the one that HOLDS the person (the campaign that sent the
 * email they replied to); `x-campaign-id` is the campaign that acted; `x-run-id` is the act's run
 * and makes a retry a no-op. Identified exactly like schedule-by-email. Nothing about the queue
 * moves: this is a record of the act, not a follow-up statement.
 */
router.post(
  "/orgs/campaigns/:campaignId/followup-actions/by-email",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    if (!campaignId) {
      res.status(400).json({ error: "campaignId required" });
      return;
    }
    if (!req.campaignId) {
      res.status(400).json({ error: "x-campaign-id (the campaign that acted) is required", code: "acting_campaign_required" });
      return;
    }
    if (!req.runId) {
      res.status(400).json({ error: "x-run-id (the run of the act) is required", code: "run_required" });
      return;
    }

    const parsed = ActedByEmailBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const lookup = await lookupFollowupRowByEmail({
      orgId: req.orgId as string,
      campaignId,
      email: parsed.data.email,
    });
    if (!lookup.ok) {
      if (lookup.code === "ambiguous_lead") {
        res.status(409).json({
          error: "That address matches more than one lead row on this campaign, so who was acted on cannot be decided here",
          code: "ambiguous_lead",
          matches: lookup.matches,
        });
        return;
      }
      res.status(404).json({ error: "No lead on this campaign holds that email address", code: "lead_not_found" });
      return;
    }

    const outcome = await recordActedByEmail({
      orgId: req.orgId as string,
      leadCampaignId: lookup.id,
      actingCampaignId: req.campaignId,
      runId: req.runId,
      workflowSlug: req.workflowSlug ?? null,
      llmAlias: parsed.data.llmAlias ?? null,
      nowIso: new Date().toISOString(),
    });
    if (outcome === "row_gone") {
      res.status(404).json({ error: "No lead on this campaign holds that email address", code: "lead_not_found" });
      return;
    }

    console.log(
      `[lead-service] followup action by email ${outcome} held=${campaignId} acting=${req.campaignId} leadCampaignId=${lookup.id} run=${req.runId}`,
    );
    res.status(outcome === "recorded" ? 201 : 200).json({
      outcome,
      leadCampaignId: lookup.id,
      leadId: lookup.leadId,
      email: lookup.email,
    });
  }),
);

/** One row's follow-up state. */
router.get(
  "/orgs/leads/:id/followups",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be a leads_campaigns row uuid" });
      return;
    }

    const state = await readFollowupState(req.orgId as string, id);
    if (!state) {
      res.status(404).json({ error: "No such lead row for this org" });
      return;
    }

    res.json({ followup: state });
  }),
);

/**
 * State what we owe this person next.
 *
 * `scheduled` enqueues (qualification decided we owe an answer at T), `acted` records that a
 * worker answered and says when the next answer is owed, `stopped` empties the schedule with a
 * reason, `handed` gives the thread to a person for good (no responder claims it again, a later
 * `scheduled` does not re-enter it). A stop is not a tombstone: a later `scheduled` re-enters the person, which is how a
 * fresh reply works — whoever observes it stops the schedule so the old date cannot fire, and
 * qualification re-decides.
 */
router.post(
  "/orgs/leads/:id/followups",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be a leads_campaigns row uuid" });
      return;
    }

    const parsed = FollowupStatementBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const nowMs = Date.now();

    if (body.llmAlias !== undefined && body.kind !== "acted") {
      res.status(400).json({
        error: "llmAlias names the LLM that wrote a message, so it is only accepted on kind=acted",
        code: "llm_alias_only_on_acted",
      });
      return;
    }

    let dueAtIso: string | null = null;
    let reason: string | null = null;

    if (body.kind === "stopped" || body.kind === "handed") {
      const stated = body.reason?.trim();
      if (!stated) {
        res.status(400).json({
          error:
            body.kind === "handed"
              ? "reason is required when handing a thread to a person (to whom, why)"
              : "reason is required when stopping a follow-up schedule",
          code: "reason_required",
        });
        return;
      }
      reason = stated;
    } else {
      const raw = body.kind === "acted" ? body.nextDueAt : body.dueAt;
      const field = body.kind === "acted" ? "nextDueAt" : "dueAt";
      const due = parseDueDate(raw, nowMs);
      if (!due.ok) {
        res.status(400).json({
          error:
            due.code === "due_date_unparseable"
              ? `${field} must be an ISO-8601 timestamp`
              : `${field} is outside the accepted range: never in the past, never further out than the horizon`,
          code: due.code,
          bounds: boundsPayload(nowMs),
        });
        return;
      }
      dueAtIso = due.iso;
    }

    const state = await writeFollowupStatement({
      orgId: req.orgId as string,
      id,
      kind: body.kind,
      dueAtIso,
      reason,
      nowMs,
      actingCampaignId: req.campaignId ?? null,
      runId: req.runId ?? null,
      workflowSlug: req.workflowSlug ?? null,
      llmAlias: body.llmAlias ?? null,
    });

    if (!state) {
      res.status(404).json({ error: "No such lead row for this org" });
      return;
    }

    res.json({ followup: state });
  }),
);

/**
 * Withdraw a hand-over the caller stated, because its verdict turned out wrong (the same reply
 * re-judged positive). `handedReason` names the hand-over exactly as the caller wrote it; lifted only
 * if every hand-over on the row names it (see `withdrawHandover`). 200 either way, `outcome` says
 * which: `lifted` (a later `scheduled` re-enters the person) or `nothing_to_lift` (+ `cause`).
 */
router.post(
  "/orgs/leads/:id/followups/handover/withdraw",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be a leads_campaigns row uuid" });
      return;
    }
    const parsed = WithdrawHandoverBodySchema.safeParse(req.body);
    const handedReason = parsed.success ? parsed.data.handedReason.trim() : "";
    const reason = parsed.success ? parsed.data.reason.trim() : "";
    if (!handedReason || !reason) {
      res.status(400).json({
        error: "handedReason (the hand-over's reason, exactly as stated) and reason (why it is withdrawn) are required",
        code: "reason_required",
      });
      return;
    }

    const out = await withdrawHandover({ orgId: req.orgId as string, id, handedReason, reason, nowMs: Date.now() });
    if (out.outcome === "row_not_found") {
      res.status(404).json({ error: "No such lead row for this org" });
      return;
    }
    if (out.outcome === "lifted") {
      console.log(`[lead-service] followup handover withdrawn id=${id} org=${req.orgId} reason=${JSON.stringify(reason)}`);
      res.json({ outcome: "lifted", followup: out.state });
      return;
    }
    res.json({ outcome: "nothing_to_lift", cause: out.cause, followup: out.state });
  }),
);

/** Campaign ids a caller may name in one read. A consumer asks per offer, which is a handful. */
const MAX_ACTING_CAMPAIGN_IDS = 100;

/**
 * Which people the named campaigns' workers claimed and answered, for one brand.
 *
 * Built for a campaign that performs an INTERNAL leg (ai-meeting-booking): it serves no lead of its
 * own, it claims people held by its predecessor leg's campaign, so the only record of who crossed
 * its leg is the follow-up ledger (`src/lib/followup-actions.ts`). Service-auth, no org: the brand
 * scopes it, exactly as the other `/internal/brands/:brandId/*` reads.
 *
 * `campaignIds` (comma-separated, required) names the ACTING campaigns — the ones the workers were
 * dispatched for — never the campaign that holds the person. Every named campaign is answered in
 * `campaigns`, zeros included. History: every claim that ever handed somebody out is here — read
 * back from the orchestrator's job results for everything before the ledger shipped (the first such
 * claim is 2026-09-21), and written live since.
 */
router.get(
  "/internal/brands/:brandId/followup-actions",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId must be a uuid" });
      return;
    }

    const raw = typeof req.query.campaignIds === "string" ? req.query.campaignIds : "";
    const campaignIds = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (campaignIds.length === 0) {
      res.status(400).json({ error: "campaignIds is required (comma-separated acting campaign ids)" });
      return;
    }
    if (campaignIds.length > MAX_ACTING_CAMPAIGN_IDS) {
      res.status(400).json({ error: `campaignIds accepts at most ${MAX_ACTING_CAMPAIGN_IDS} ids` });
      return;
    }

    const result = await readFollowupActions({ brandId, campaignIds });
    res.json({ brandId, ...result });
  }),
);

/**
 * Is anyone owed a follow-up NOW on the held campaigns a responder would claim on, and if not, when
 * is the earliest moment? A READ (never claims, leases or writes), batched: campaign-service asks it
 * per reactive campaign instead of dispatching a workflow run that claims nobody (WA-REACTIVE-LOOP-1016,
 * `src/lib/followup-owed.ts`).
 */
const FollowupOwedBodySchema = z
  .object({
    campaigns: z
      .array(
        z
          .object({
            campaignId: z.string().min(1),
            heldCampaignIds: z.array(z.string().min(1)).max(20).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

router.post(
  "/internal/followups/owed",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const parsed = FollowupOwedBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Body must be {campaigns: [{campaignId, heldCampaignIds?}]} with 1 to 100 campaigns",
        code: "invalid_owed_query",
        details: parsed.error.flatten(),
      });
      return;
    }
    const nowMs = Date.now();
    const answers = [];
    for (const query of parsed.data.campaigns) {
      answers.push(
        await readFollowupOwed({
          orgId: req.orgId as string,
          query: { campaignId: query.campaignId, heldCampaignIds: query.heldCampaignIds ?? [query.campaignId] },
          nowMs,
        }),
      );
    }
    res.json({ asOf: new Date(nowMs).toISOString(), answers });
  }),
);

export default router;
