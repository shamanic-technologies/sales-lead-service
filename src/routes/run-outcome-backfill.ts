import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { RunOutcomeBackfillRequestSchema } from "../schemas.js";
import { backfillJob, startOutcomeBackfill } from "../lib/run-outcome-backfill.js";

const router = Router();

/**
 * POST/GET /internal/run-outcomes/backfill — declare the outcomes of our PAST serve runs at runs-service
 * (COST-BACKFILL-1023-LEAD, src/lib/run-outcome-backfill.ts). One job at a time, in the background.
 */
router.post("/internal/run-outcomes/backfill", apiKeyAuth, (req, res) => {
  const parsed = RunOutcomeBackfillRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const { started, job } = startOutcomeBackfill(parsed.data);
  return res.status(started ? 202 : 409).json(job);
});

router.get("/internal/run-outcomes/backfill", apiKeyAuth, (_req, res) => {
  return res.json({ job: backfillJob() });
});

export default router;
