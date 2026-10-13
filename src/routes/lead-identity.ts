import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { leadIdentityCounts } from "../lib/lead-identity-sweep.js";

const router = Router();

/**
 * GET /internal/lead-identity/status — how far the identity sweep is (src/lib/lead-identity-sweep.ts):
 * leads with a human (human-service), with a company (brand-service), without a safe company identity,
 * without an employer, still pending, and the (human, company) pairs held by more than one lead.
 */
router.get("/internal/lead-identity/status", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await leadIdentityCounts());
  } catch (error) {
    console.error("[lead-service] lead identity status failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
