import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { readServeWalks } from "../lib/serve-walk.js";
import { replayServeWalk } from "../lib/serve-walk-rules.js";

const router = Router();

const MAX_LIMIT = 100;

/**
 * GET /internal/serve-walks?runId=|campaignId=[&limit=] — staff, read-only (FACTORY-RECORD-SERVE-1028): the recorded
 * walk of past serves (src/lib/serve-walk.ts), each with its replay (src/lib/serve-walk-rules.ts): the person the
 * record hands out when every check is re-decided from its inputs, and every decision that does not replay.
 */
router.get("/internal/serve-walks", apiKeyAuth, async (req, res) => {
  const runId = typeof req.query.runId === "string" && req.query.runId.trim() ? req.query.runId.trim() : null;
  const campaignId = typeof req.query.campaignId === "string" && req.query.campaignId.trim() ? req.query.campaignId.trim() : null;
  if ((runId === null) === (campaignId === null)) {
    return res.status(400).json({ error: "run_id_or_campaign_id_required", message: "Name exactly one of runId or campaignId." });
  }
  let limit = 20;
  if (req.query.limit !== undefined) {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return res.status(400).json({ error: "invalid_limit", message: `limit must be an integer from 1 to ${MAX_LIMIT}.` });
    }
    limit = n;
  }
  try {
    const walks = await readServeWalks(runId ? { runId, limit } : { campaignId: campaignId!, limit });
    res.json({ walks: walks.map((w) => ({ ...w, replay: replayServeWalk(w.steps) })) });
  } catch (error) {
    console.error("[lead-service] serve-walks read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
