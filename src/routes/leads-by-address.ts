import { messageOf } from "../lib/db-error.js";
import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { MAX_ADDRESSES_PER_CALL, readLeadsByAddress } from "../lib/leads-by-address.js";
import { ReadModelUnavailableError } from "../lib/lead-read-model.js";
import { CampaignLegsUnavailableError } from "../lib/campaign-leg-client.js";

const router = Router();

export const LeadsByAddressBodySchema = z.object({
  emails: z.array(z.string().trim().min(1).max(320)).min(1).max(MAX_ADDRESSES_PER_CALL),
});

/**
 * POST /internal/brands/:brandId/leads/by-address — which lead each address is at (x-org-id, brand):
 * the rows `GET /orgs/leads?brandId=&view=basic&sort=activity&status=all` holds for it, read live,
 * without touching any read model or change feed (MON-DB-HOT-1112, `src/lib/leads-by-address.ts`).
 * Caller: crm-service's people build. Every address answered (`leads: []` = no lead).
 */
router.post("/internal/brands/:brandId/leads/by-address", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const brandId = req.params.brandId as string;
  const parsed = LeadsByAddressBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }
  try {
    const addresses = await readLeadsByAddress({
      orgId: req.orgId!,
      brandId,
      addresses: parsed.data.emails,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
    });
    res.json({ brandId, addresses, count: addresses.length });
  } catch (error) {
    if (error instanceof ReadModelUnavailableError || error instanceof CampaignLegsUnavailableError) {
      console.error(`[lead-service] leads by-address dependency unreadable for brand ${brandId}:`, messageOf(error));
      res.status(502).json({ error: "dependency_unavailable", message: messageOf(error) });
      return;
    }
    console.error(`[lead-service] leads by-address error for brand ${brandId}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
