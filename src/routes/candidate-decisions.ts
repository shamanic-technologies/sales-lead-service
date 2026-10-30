import { Router } from "express";
import { and, asc, gt, sql } from "drizzle-orm";
import { apiKeyAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { candidateDecisions } from "../db/schema.js";
import { DECLINE_CALL, MUST_PASS_CALL, REVEAL_CALL, SCREEN_CALL, doorCall } from "../lib/candidate-serve.js";

const router = Router();

const DOORS: Record<string, string> = { screen: SCREEN_CALL, "must-pass": MUST_PASS_CALL, reveal: REVEAL_CALL, decline: DECLINE_CALL };

/**
 * POST /internal/candidate-decisions/{screen,must-pass,reveal,decline} (FACTORY-P3 next outcomes, lead_identified): the
 * stored candidate decision's doors. Serve ONLY a candidate in flight in a serve here (`x-caller-run-id` = the serve's
 * run + `candidateId`): our exact call (the Jev screen's spend on the script's run `x-run-id`). 409 when nothing is in
 * flight; 502 = refused, the refusal reaching the serve as our own error.
 */
router.post("/internal/candidate-decisions/:door", apiKeyAuth, async (req, res) => {
  const call = DOORS[req.params.door];
  const callerRunId = typeof req.headers["x-caller-run-id"] === "string" ? req.headers["x-caller-run-id"].trim() : "";
  const scriptRunId = typeof req.headers["x-run-id"] === "string" ? req.headers["x-run-id"].trim() : "";
  const candidateId = typeof req.body?.candidateId === "string" ? req.body.candidateId : "";
  if (!call) return res.status(404).json({ error: `no door ${req.params.door}` });
  if (!callerRunId || !scriptRunId || !candidateId) return res.status(400).json({ error: "x-caller-run-id, x-run-id (the script's run) and candidateId are required" });
  try {
    const out = await doorCall({ callerRunId, scriptRunId, call, candidateId, reason: typeof req.body?.reason === "string" ? req.body.reason : undefined });
    return res.status(out.status).json(out.body);
  } catch (error) {
    console.error(`[lead-service] candidate decision door ${req.params.door} failed:`, error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * GET /internal/candidate-decisions/recorded?after=<seq>&limit= — every candidate decision, oldest first (a row served
 * 60 s after it was written), for workflow-service's case recorder. Read-only.
 */
router.get("/internal/candidate-decisions/recorded", apiKeyAuth, async (req, res) => {
  const after = req.query.after === undefined ? 0 : Number(req.query.after);
  const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return res.status(400).json({ error: "after (a seq >= 0) and limit (1..1000) must be integers" });
  }
  try {
    const rows = await db
      .select()
      .from(candidateDecisions)
      .where(and(gt(candidateDecisions.seq, after), sql`${candidateDecisions.createdAt} < now() - interval '60 seconds'`))
      .orderBy(asc(candidateDecisions.seq))
      .limit(limit);
    return res.json({ decisions: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), nextAfter: rows.length > 0 ? rows[rows.length - 1]!.seq : after, hasMore: rows.length === limit });
  } catch (error) {
    console.error("[lead-service] candidate decisions read failed:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
