import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { readCandidateScreeningStats } from "../lib/candidate-screening-stats.js";

const router = Router();

/**
 * GET /internal/candidate-screenings/stats — fleet-wide, by month: how the audience screen before the paid reveal
 * decided (pass/decline, P(yes) buckets) and how many orgs/brands/audiences it worked for
 * (src/lib/candidate-screening-stats.ts). Staff Research page, via features-service.
 */
router.get("/internal/candidate-screenings/stats", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await readCandidateScreeningStats());
  } catch (error) {
    console.error("[lead-service] candidate-screenings stats read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
