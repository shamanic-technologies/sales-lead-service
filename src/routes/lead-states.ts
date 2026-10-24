import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { LEAD_STATES_MAX_LIMIT, LeadStatesByLeadRequestSchema } from "../schemas.js";
import { decodeLeadStatesCursor, LeadStatesCursorError, readLeadStates } from "../lib/lead-states-read.js";
import { LeadStateCatalogueError } from "../lib/lead-states.js";
import { CampaignLegsUnavailableError } from "../lib/campaign-leg-client.js";

/** A sibling that says which step reaches which state (or which campaign places booking calls) could not answer. */
function dependencyDown(error: unknown): boolean {
  return error instanceof LeadStateCatalogueError || error instanceof CampaignLegsUnavailableError;
}

const router = Router();

/**
 * GET /internal/lead-states?limit=&cursor=[&orgId=] — when each lead first reached each state, every lead x brand,
 * walked in (org, brand, lead) order (LEAD-STATES-1024, rules in src/lib/lead-states.ts). runs-service charges each
 * run to the next state its lead had not reached at the run's time.
 */
router.get("/internal/lead-states", apiKeyAuth, async (req, res) => {
  const rawLimit = typeof req.query.limit === "string" ? req.query.limit : "";
  const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > LEAD_STATES_MAX_LIMIT) {
    return res.status(400).json({ error: "invalid_limit", message: `limit is required, an integer 1..${LEAD_STATES_MAX_LIMIT}` });
  }
  const orgId = typeof req.query.orgId === "string" && req.query.orgId.trim() ? req.query.orgId.trim() : undefined;
  let after: ReturnType<typeof decodeLeadStatesCursor> | null = null;
  if (typeof req.query.cursor === "string") {
    try {
      after = decodeLeadStatesCursor(req.query.cursor);
    } catch (error) {
      if (error instanceof LeadStatesCursorError) return res.status(400).json({ error: "invalid_cursor", message: error.message });
      throw error;
    }
  }
  try {
    return res.json(await readLeadStates({ orgId, after, limit }));
  } catch (error) {
    console.error("[lead-service] lead states read failed:", error);
    if (dependencyDown(error)) return res.status(502).json({ error: "dependency_unavailable", message: (error as Error).message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

/** POST /internal/lead-states/by-lead {leadIds} — the same answer for these leads, every brand they hold a state at. */
router.post("/internal/lead-states/by-lead", apiKeyAuth, async (req, res) => {
  const parsed = LeadStatesByLeadRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const { leads } = await readLeadStates({ leadIds: [...new Set(parsed.data.leadIds.map((id) => id.toLowerCase()))] });
    return res.json({ leads });
  } catch (error) {
    console.error("[lead-service] lead states by lead failed:", error);
    if (dependencyDown(error)) return res.status(502).json({ error: "dependency_unavailable", message: (error as Error).message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
