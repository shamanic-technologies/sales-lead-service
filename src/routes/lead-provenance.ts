import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { readLeadProvenanceByEmail, PROVENANCE_MAX_EMAILS } from "../lib/lead-provenance.js";
import { AudienceServiceError } from "../lib/audience-client.js";
import { SourcingOriginUnresolvedError } from "../lib/sourcing-origin.js";

const router = Router();

export const LeadProvenanceBodySchema = z.object({
  emails: z.array(z.string().trim().min(3).max(320)).min(1).max(PROVENANCE_MAX_EMAILS),
});

/**
 * POST /internal/brands/:brandId/lead-provenance/by-email — every source tag of each address at
 * (x-org-id, brand), for the sending side to join sends, bounces and refusals to lead sources
 * (LEAD-SOURCE-AT-SEND-1016, `src/lib/lead-provenance.ts`). One answer per distinct asked address,
 * in the order asked (normalized: trimmed, lowercased). 502 when human-service or the origin catalogue
 * cannot be read (never "no source"); 400 on an unreadable body.
 */
router.post(
  "/internal/brands/:brandId/lead-provenance/by-email",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const brandId = req.params.brandId as string;
    const parsed = LeadProvenanceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const people = await readLeadProvenanceByEmail(req.orgId!, brandId, parsed.data.emails);
      res.json({ brandId, people, count: people.length });
    } catch (error) {
      if (error instanceof AudienceServiceError || error instanceof SourcingOriginUnresolvedError) {
        console.error(`[lead-service] lead-provenance source unreadable for brand ${brandId}:`, error.message);
        res.status(502).json({ error: "provenance_source_unavailable", message: error.message });
        return;
      }
      console.error(`[lead-service] lead-provenance error for brand ${brandId}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
