import { messageOf } from "../lib/db-error.js";
import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { LeadsFoundUnavailableError, readSourceLeadsFound } from "../lib/source-leads-found.js";
import { readSourceReusedAcquisitions } from "../lib/source-reused-acquisitions.js";

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
      res.status(502).json({ error: "leads_found_unavailable", detail: messageOf(error) });
      return;
    }
    console.error("[lead-service] leads-found read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /internal/source-campaigns/reused-acquisitions — fleet-wide, per source campaign: of the leads it found in its
 * own runs, how many reused an acquisition an EARLIER run paid for, and what that cost (apollo-service's figures;
 * src/lib/source-reused-acquisitions.ts). An org apollo-service did not answer = null figures + `unavailableReason`.
 */
router.get("/internal/source-campaigns/reused-acquisitions", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await readSourceReusedAcquisitions());
  } catch (error) {
    console.error("[lead-service] reused-acquisitions read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
