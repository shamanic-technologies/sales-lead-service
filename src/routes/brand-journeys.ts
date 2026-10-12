import { Router } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { streamBrandJourneys } from "../lib/brand-journeys.js";
import { fetchOrgCampaignOffers } from "../lib/campaign-leg-client.js";
import { loadOutreachFeedState } from "../lib/outreach-fact-feed.js";
import { ResponseWriter } from "../lib/stream-writer.js";
import { watchClient, isClientGone } from "../lib/client-abort.js";

const router = Router();

const CHUNK_SIZE = Math.max(1, Number(process.env.LEADS_STREAM_CHUNK_SIZE) || 500);

/**
 * GET /internal/brands/:brandId/timeline-journeys — every person x offer journey of the brand
 * (x-org-id scoped), read off the silver timeline (`src/lib/brand-journeys.ts`).
 *
 * ONE statement streamed (`{"brandId":..,"journeys":[...],"count":N,"factCount":M}`): `count` and
 * `factCount` close the body so a consumer can check it read everything. FAIL LOUD: campaign-service
 * unable to name the follow-up acts' offers = 502; the outreach fact copy not caught up yet (the
 * timeline would be partial) = 503; a failure before the first byte = 500, after it the socket is
 * destroyed (a short body never parses as a complete one).
 */
router.get(
  "/internal/brands/:brandId/timeline-journeys",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const brandId = req.params.brandId as string;
    const orgId = req.orgId!;
    let offers: Map<string, string | null>;
    try {
      const { caughtUp } = await loadOutreachFeedState();
      if (!caughtUp) {
        res.status(503).json({
          error: "outreach_copy_not_caught_up",
          message: "the outreach fact copy has not reached the end of the feed yet; the timeline would be partial",
        });
        return;
      }
    } catch (error) {
      console.error(`[lead-service] timeline-journeys feed state unreadable for brand ${brandId}:`, error);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
    try {
      offers = await fetchOrgCampaignOffers({ orgId, brandId });
    } catch (error) {
      console.error(`[lead-service] timeline-journeys campaign offers unreadable for brand ${brandId}:`, error);
      res.status(502).json({ error: "campaign_offers_unavailable", message: (error as Error).message });
      return;
    }

    const writer = new ResponseWriter(res);
    const client = watchClient(req, res);
    let streamingStarted = false;
    const open = async () => {
      if (streamingStarted) return;
      res.setHeader("Content-Type", "application/json");
      await writer.write(`{"brandId":${JSON.stringify(brandId)},"journeys":[`);
      streamingStarted = true;
    };
    try {
      let count = 0;
      let factCount = 0;
      for await (const chunk of streamBrandJourneys(orgId, brandId, offers, CHUNK_SIZE)) {
        client.stopIfGone(count);
        await open();
        for (const journey of chunk) {
          await writer.write((count === 0 ? "" : ",") + JSON.stringify(journey));
          count += 1;
          factCount += journey.facts.length;
        }
      }
      await open();
      await writer.write(`],"count":${count},"factCount":${factCount}}`);
      await writer.end();
    } catch (error) {
      if (isClientGone(error)) {
        console.warn(`[lead-service] timeline-journeys read abandoned by the caller: ${error.message}`);
        res.destroy();
      } else {
        console.error(`[lead-service] timeline-journeys error for brand ${brandId}:`, error);
        if (streamingStarted || res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        } else {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    } finally {
      client.dispose();
    }
  },
);

export default router;
