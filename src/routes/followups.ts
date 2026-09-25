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
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import {
  FOLLOWUP_DUE_MAX_HORIZON_MS,
  FOLLOWUP_DUE_PAST_TOLERANCE_MS,
  FollowupOptOutLookupError,
  dueDateBounds,
  lookupFollowupRowByEmail,
  parseDueDate,
  pickFollowupCandidate,
  readFollowupState,
  writeFollowupStatement,
} from "../lib/followup-queue.js";
import { readFollowupActions } from "../lib/followup-actions.js";

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

/** `leads_campaigns.id` is a uuid column, so anything else is a caller error, not a miss. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FollowupStatementBodySchema = z.object({
  kind: z.enum(["scheduled", "acted", "stopped"]),
  dueAt: z.string().optional(),
  nextDueAt: z.string().optional(),
  reason: z.string().optional(),
});

const ScheduleByEmailBodySchema = z.object({
  email: z.string().trim().min(3).max(320),
  dueAt: z.string(),
});

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

    try {
      const result = await pickFollowupCandidate({
        orgId: req.orgId as string,
        campaignId,
        runId: req.runId ?? null,
        // The campaign this worker was DISPATCHED for. For an internal leg it is not the campaign
        // named in the path (that one holds the person), and it is what the ledger attributes to.
        actingCampaignId: req.campaignId ?? null,
        context: {
          orgId: req.orgId,
          userId: req.userId,
          runId: req.runId,
          campaignId,
          brandId: req.brandId,
          workflowSlug: req.workflowSlug,
          featureSlug: req.featureSlug,
          audienceId: req.audienceId,
        },
      });

      if (!result.claimed) {
        res.json({ found: false, reason: result.reason });
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
          audienceId: candidate.audienceId,
          dueAt: candidate.dueAt instanceof Date ? candidate.dueAt.toISOString() : candidate.dueAt,
          followupCount: candidate.followupCount,
          lastActionAt:
            candidate.lastActionAt instanceof Date
              ? candidate.lastActionAt.toISOString()
              : candidate.lastActionAt,
        },
      });
    } catch (err) {
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

    const lookup = await lookupFollowupRowByEmail({
      orgId: req.orgId as string,
      campaignId,
      email: parsed.data.email,
    });

    if (!lookup.ok) {
      if (lookup.code === "ambiguous_lead") {
        res.status(409).json({
          error:
            "That address matches more than one lead row on this campaign, so which person is owed an answer cannot be decided here",
          code: "ambiguous_lead",
          matches: lookup.matches,
        });
        return;
      }
      res.status(404).json({
        error: "No lead on this campaign holds that email address",
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
    });

    // The lookup already proved the row is this org's, so a miss here is a row deleted between the
    // two statements — vanishingly rare, and still answered rather than swallowed.
    if (!state) {
      res.status(404).json({
        error: "No lead on this campaign holds that email address",
        code: "lead_not_found",
      });
      return;
    }

    console.log(
      `[lead-service] followup scheduled by email campaign=${campaignId} leadCampaignId=${lookup.id} due=${due.iso}`,
    );

    res.json({ followup: state, leadId: lookup.leadId, email: lookup.email });
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
 * reason. A stop is not a tombstone: a later `scheduled` re-enters the person, which is how a
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

    let dueAtIso: string | null = null;
    let reason: string | null = null;

    if (body.kind === "stopped") {
      const stated = body.reason?.trim();
      if (!stated) {
        res.status(400).json({
          error: "reason is required when stopping a follow-up schedule",
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
    });

    if (!state) {
      res.status(404).json({ error: "No such lead row for this org" });
      return;
    }

    res.json({ followup: state });
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

export default router;
