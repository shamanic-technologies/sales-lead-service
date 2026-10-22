import { errorMessage, messageOf } from "../lib/db-error.js";
import { Router } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { NotASourceCampaignError, readSourcingStats, SourceCampaignNotFoundError } from "../lib/source-people-read.js";

const router = Router();

/**
 * GET /orgs/campaigns/:campaignId/sourcing-stats — what ONE source pipe (a `start_to_lead_found`
 * campaign) found and what we kept, since inception: people and companies, per day, per audience,
 * per buying signal, with every unattributable serve served as a gap count (src/lib/source-people.ts).
 *
 * 404 = not a campaign of this org; 409 = a campaign that is not a lead source; 502 = a sibling
 * (campaign-service, features-service, human-service) could not answer: never a partial count.
 */
router.get("/orgs/campaigns/:campaignId/sourcing-stats", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const campaignId = req.params.campaignId as string;
  try {
    const stats = await readSourcingStats(campaignId, { orgId: req.orgId!, userId: req.userId, runId: req.runId });
    res.json(stats);
  } catch (error) {
    if (error instanceof SourceCampaignNotFoundError) {
      res.status(404).json({ error: "campaign_not_found", detail: messageOf(error) });
      return;
    }
    if (error instanceof NotASourceCampaignError) {
      res.status(409).json({ error: "not_a_source_campaign", detail: messageOf(error) });
      return;
    }
    console.error(`[lead-service] sourcing-stats failed for campaign ${campaignId} org ${req.orgId}:`, error);
    res.status(502).json({ error: "sourcing_stats_unavailable", detail: errorMessage(error) });
  }
});

export default router;
