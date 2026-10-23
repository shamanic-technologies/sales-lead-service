import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { LeadIdResolveRequestSchema } from "../schemas.js";
import { resolveLeadIds } from "../lib/lead-id-resolve.js";

const router = Router();

/**
 * POST /internal/leads/ids/resolve — which lead is each person, for an org (COST-ACCOUNTING-1023-P1,
 * src/lib/lead-id-resolve.ts). apollo-service names the subject of its outcome declarations through it.
 */
router.post("/internal/leads/ids/resolve", apiKeyAuth, async (req, res) => {
  const parsed = LeadIdResolveRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return res.json({ people: await resolveLeadIds(parsed.data.people) });
  } catch (error) {
    console.error("[lead-service] lead id resolve failed:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
