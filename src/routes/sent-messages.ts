import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { leadBelongsToOrg, readSentMessages } from "../lib/sent-messages.js";

const router = Router();

/**
 * GET /internal/leads/:leadId/sent-messages — every message we sent the lead at the org (x-org-id), any
 * channel, each with the workflow run that wrote it (`src/lib/sent-messages.ts`). INTERNAL (service key):
 * no customer read carries a workflow name or run id. 404 when the lead holds no row of the org.
 */
router.get(
  "/internal/leads/:leadId/sent-messages",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const leadId = req.params.leadId as string;
    if (!z.string().uuid().safeParse(leadId).success) {
      res.status(400).json({ error: "leadId must be a uuid", code: "invalid_lead_id" });
      return;
    }
    const orgId = req.orgId!;
    try {
      if (!(await leadBelongsToOrg(orgId, leadId))) {
        res.status(404).json({ error: "No such lead for this org", code: "lead_not_found" });
        return;
      }
      const messages = await readSentMessages(orgId, leadId);
      res.json({ leadId, messages, count: messages.length });
    } catch (error) {
      console.error(`[lead-service] sent-messages read failed for lead ${leadId}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
