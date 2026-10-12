import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { SocialEngagementsUnavailableError, syncSocialEngagements } from "../lib/social-engagements.js";

const router = Router();

/**
 * POST /internal/social-engagements/sync — file every engagement social-service holds from the last 14
 * days NOW (the background sweep does the same every 10 min): each person becomes a lead of the post's
 * brand, each fact a row of their timeline (src/lib/social-engagements.ts). Idempotent per fact.
 * 502 when social-service or campaign-service cannot answer.
 */
router.post("/internal/social-engagements/sync", apiKeyAuth, async (_req, res) => {
  try {
    res.json(await syncSocialEngagements());
  } catch (error) {
    if (error instanceof SocialEngagementsUnavailableError) {
      console.error(`[lead-service] social engagements sync unavailable: ${error.message}`);
      res.status(502).json({ error: "social_engagements_unavailable", detail: error.message });
      return;
    }
    console.error("[lead-service] social engagements sync failed:", error);
    res.status(500).json({ error: "Internal server error", detail: (error as Error).message });
  }
});

export default router;
