import { Router, type Response } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { CrmFactFeedNotCaughtUpError } from "../lib/crm-fact-events.js";
import { canonicalEmail, refuseStep } from "../lib/step-reached.js";
import { readStepReached } from "../lib/step-reached-read.js";

const router = Router();

/**
 * GET /internal/brands/:brandId/step-reached?step=<step key>&(since=<ISO>|email=<address>)
 *
 * WHO reached a catalogue step at the brand (x-org-id scoped), for campaign-service's `delay` trigger detector
 * (FACT-NOT-FOLLOWED-1014; rules in `src/lib/step-reached.ts`). `since`: people whose reach falls at/after it,
 * `reachedAt` = their earliest reach at/after it. `email`: that person at any time (empty = never reached).
 * Exactly one of the two. Unknown step = 400 `unknown_step`; a known step no store here sees = 400
 * `step_not_observable`. CRM copy not caught up = 503; anything else unreadable = 500. Never "nobody" on a failure.
 */
router.get(
  "/internal/brands/:brandId/step-reached",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res: Response) => {
    const brandId = String(req.params.brandId ?? "").trim();
    const orgId = req.orgId!;
    const step = typeof req.query.step === "string" ? req.query.step.trim() : "";
    if (!step) {
      res.status(400).json({ error: "step_required", message: "step is required (a catalogue step key)" });
      return;
    }
    const refusal = refuseStep(step);
    if (refusal) {
      res.status(400).json({ error: refusal.code, message: refusal.message });
      return;
    }

    const hasSince = req.query.since !== undefined;
    const hasEmail = req.query.email !== undefined;
    if (hasSince === hasEmail) {
      res.status(400).json({ error: "since_or_email_required", message: "state exactly one of since or email" });
      return;
    }

    let since: string | undefined;
    let email: string | undefined;
    if (hasSince) {
      const raw = typeof req.query.since === "string" ? req.query.since.trim() : "";
      const ms = Date.parse(raw);
      if (!raw || Number.isNaN(ms)) {
        res.status(400).json({ error: "invalid_since", message: "since must be an ISO datetime" });
        return;
      }
      since = new Date(ms).toISOString();
    } else {
      const raw = typeof req.query.email === "string" ? canonicalEmail(req.query.email) : "";
      if (!raw || !raw.includes("@")) {
        res.status(400).json({ error: "invalid_email", message: "email must be an address" });
        return;
      }
      email = raw;
    }

    try {
      const people =
        email !== undefined
          ? await readStepReached({ orgId, brandId, step, email })
          : await readStepReached({ orgId, brandId, step, since: since! });
      res.json({ step, people });
    } catch (error) {
      if (error instanceof CrmFactFeedNotCaughtUpError) {
        res.status(503).json({ error: "crm_copy_not_caught_up", message: error.message });
        return;
      }
      console.error(`[lead-service] step-reached unreadable for brand ${brandId} step ${step}:`, error);
      res.status(500).json({ error: "step_reached_unreadable", message: "Could not read who reached the step" });
    }
  },
);

export default router;
