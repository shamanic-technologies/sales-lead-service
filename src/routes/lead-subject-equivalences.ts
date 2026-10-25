import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { LeadSubjectEquivalencesRequestSchema } from "../schemas.js";
import { stateLeadSubjectEquivalences } from "../lib/lead-subject-equivalences.js";

const router = Router();

/**
 * POST /internal/subject-equivalences/state — state at runs-service which of our lead rows are the same lead
 * (LEDGER-RESIDUAL-1025, src/lib/lead-subject-equivalences.ts). The background thread runs the same pass every 30 min.
 */
router.post("/internal/subject-equivalences/state", apiKeyAuth, async (req, res) => {
  const parsed = LeadSubjectEquivalencesRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return res.json(await stateLeadSubjectEquivalences(parsed.data));
  } catch (err) {
    console.error("[lead-service] subject equivalences route failed:", err);
    return res.status(502).json({ error: "subject_equivalences_failed", message: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
