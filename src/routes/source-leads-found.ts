import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { LeadsFoundUnavailableError, readSourceLeadsFound } from "../lib/source-leads-found.js";

const router = Router();

/**
 * GET /internal/source-campaigns/leads-found — fleet-wide, per source campaign: how many leads it found (on demand
 * AND in its own runs), first and last time, and since when each mode is recorded (src/lib/source-leads-found.ts).
 * 502 when campaign-service cannot answer (never a partial count).
 */
router.get("/internal/source-campaigns/leads-found", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await readSourceLeadsFound());
  } catch (error) {
    if (error instanceof LeadsFoundUnavailableError) {
      console.error(`[lead-service] leads-found read unavailable: ${error.message}`);
      res.status(502).json({ error: "leads_found_unavailable", detail: error.message });
      return;
    }
    console.error("[lead-service] leads-found read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
