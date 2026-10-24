import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { LeadIdByEmailRequestSchema, LeadIdResolveRequestSchema } from "../schemas.js";
import { resolveLeadIds, resolveLeadIdsByEmail } from "../lib/lead-id-resolve.js";

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

/**
 * POST /internal/leads/ids/by-email — which lead is each address, whatever the org (LEDGER-HISTORY-1024,
 * src/lib/lead-id-resolve.ts `resolveLeadIdsByEmail`).
 */
router.post("/internal/leads/ids/by-email", apiKeyAuth, async (req, res) => {
  const parsed = LeadIdByEmailRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return res.json({ answers: await resolveLeadIdsByEmail(parsed.data.emails) });
  } catch (error) {
    console.error("[lead-service] lead id by email failed:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
