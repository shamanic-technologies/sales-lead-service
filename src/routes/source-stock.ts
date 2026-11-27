/**
 * A source's stock, asked again whether each find is its own, and finds given back to the source they belong to
 * (LEAK-1012 part 2): src/lib/source-stock-recheck.ts.
 */
import { errorMessage } from "../lib/db-error.js";
import { Router, Response } from "express";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { SourceCampaignUnresolvedError } from "../lib/source-campaign.js";
import { fetchSourceUnit } from "../lib/source-mode.js";
import { createSourceAudienceJudge } from "../lib/source-stock-belongs.js";
import { adoptSetAsideFinds, recheckSourceStock } from "../lib/source-stock-recheck.js";
import { SourcingOriginUnresolvedError } from "../lib/sourcing-origin.js";
import { AudienceFitError } from "../lib/audience-fit-client.js";
import { rejudgeCannotJudgeFinds } from "../lib/source-stock-rejudge.js";
import { SourceStockAdoptBodySchema, SourceStockRecheckBodySchema, SourceStockRejudgeBodySchema } from "../schemas.js";

const router = Router();

function siblingDown(error: unknown): boolean {
  return error instanceof SourceCampaignUnresolvedError || error instanceof SourcingOriginUnresolvedError || error instanceof AudienceFitError;
}

async function answer(res: Response, label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await work());
  } catch (error) {
    if (siblingDown(error)) {
      console.error(`[lead-service] ${label} unavailable: ${errorMessage(error)}`);
      res.status(502).json({ error: "dependency_unavailable", detail: errorMessage(error) });
      return;
    }
    console.error(`[lead-service] ${label} failed:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/** 404 when the campaign is not a source of this org; throws when campaign-service cannot say. */
async function isSource(campaignId: string, orgId: string): Promise<boolean> {
  return (await fetchSourceUnit(campaignId, orgId)) !== null;
}

router.post("/internal/source-campaigns/:campaignId/stock/recheck", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const campaignId = req.params.campaignId;
  const parsed = SourceStockRecheckBodySchema.safeParse(req.body);
  if (!campaignId || !parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.success ? undefined : parsed.error.flatten() });
    return;
  }
  const orgId = req.orgId as string;
  await answer(res, `source stock recheck campaign=${campaignId}`, async () => {
    if (!(await isSource(campaignId, orgId))) {
      res.status(404);
      return { error: "Not a source campaign of this org", code: "not_a_source_campaign" };
    }
    const judge = createSourceAudienceJudge({ orgId, userId: req.userId ?? null, runId: req.runId ?? null });
    return recheckSourceStock({ orgId, sourceCampaignId: campaignId, dryRun: parsed.data.dryRun, judge });
  });
});

router.post("/internal/source-campaigns/:campaignId/stock/adopt", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const campaignId = req.params.campaignId;
  const parsed = SourceStockAdoptBodySchema.safeParse(req.body);
  if (!campaignId || !parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.success ? undefined : parsed.error.flatten() });
    return;
  }
  const orgId = req.orgId as string;
  await answer(res, `source stock adopt campaign=${campaignId}`, async () => {
    if (!(await isSource(campaignId, orgId)) || !(await isSource(parsed.data.fromSourceCampaignId, orgId))) {
      res.status(404);
      return { error: "Not a source campaign of this org", code: "not_a_source_campaign" };
    }
    const judge = createSourceAudienceJudge({ orgId, userId: req.userId ?? null, runId: req.runId ?? null });
    return adoptSetAsideFinds({
      orgId,
      sourceCampaignId: campaignId,
      fromSourceCampaignId: parsed.data.fromSourceCampaignId,
      dryRun: parsed.data.dryRun,
      judge,
    });
  });
});

/**
 * GMAPS-SET-ASIDE-1127-REOPEN: every find of this source set aside because its audience COULD NOT judge it is asked
 * again now (src/lib/source-stock-rejudge.ts); fits = back in stock, a real no-fit stays set aside. `dryRun` writes nothing.
 */
router.post("/internal/source-campaigns/:campaignId/stock/rejudge", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const campaignId = req.params.campaignId;
  const parsed = SourceStockRejudgeBodySchema.safeParse(req.body);
  if (!campaignId || !parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.success ? undefined : parsed.error.flatten() });
    return;
  }
  const orgId = req.orgId as string;
  await answer(res, `source stock rejudge campaign=${campaignId}`, async () => {
    if (!(await isSource(campaignId, orgId))) {
      res.status(404);
      return { error: "Not a source campaign of this org", code: "not_a_source_campaign" };
    }
    const outcome = await rejudgeCannotJudgeFinds({ dryRun: parsed.data.dryRun, orgId, sourceCampaignId: campaignId });
    return { sourceCampaignId: campaignId, ...outcome };
  });
});

export default router;
