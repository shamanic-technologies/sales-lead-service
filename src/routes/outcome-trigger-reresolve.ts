import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { OutcomeReachReResolveRequestSchema } from "../schemas.js";
import { reResolveSetAsideReach } from "../lib/outcome-triggers.js";
import { errorMessage } from "../lib/db-error.js";

const router = Router();

/**
 * POST /internal/outcome-triggers/re-resolve — one outcome reach set aside before the door (`offer_unknown`,
 * `no_person`, `unresolvable`) re-resolved through the normal path (OFFER-FROM-LIVE-CAMPAIGNS-1024,
 * src/lib/outcome-triggers.ts `reResolveSetAsideReach`). Staff, api key only.
 */
router.post("/internal/outcome-triggers/re-resolve", apiKeyAuth, async (req, res) => {
  const parsed = OutcomeReachReResolveRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const answer = await reResolveSetAsideReach(parsed.data.sourceRef);
    if (answer.status === 200) return res.json({ sourceRef: parsed.data.sourceRef, rows: answer.rows });
    return res.status(answer.status).json({ error: answer.detail, reason: answer.reason });
  } catch (err) {
    console.error(`[lead-service] outcome reach ${parsed.data.sourceRef} re-resolve failed:`, err);
    return res.status(502).json({ error: errorMessage(err) });
  }
});

export default router;
