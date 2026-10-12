/**
 * A sender refused a person for a reason about its CHANNEL (WhatsApp: no phone known, not on WhatsApp). The person is
 * released to the brand's other pipes that can reach them: `src/lib/released-pool.ts`.
 */
import { Router, Request, Response, NextFunction } from "express";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { releaseForChannel } from "../lib/released-pool.js";
import { ChannelRefusalBodySchema } from "../schemas.js";

const router = Router();

function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

router.post(
  "/orgs/campaigns/:campaignId/leads/channel-refusals",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    const parsed = ChannelRefusalBodySchema.safeParse(req.body);
    if (!campaignId || !parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.success ? undefined : parsed.error.flatten() });
      return;
    }
    const released = await releaseForChannel({
      orgId: req.orgId as string,
      campaignId,
      email: parsed.data.email,
      code: parsed.data.code,
    });
    if (released.length === 0) {
      res.status(404).json({ error: "This campaign holds no lead with that email", code: "lead_not_in_campaign" });
      return;
    }
    console.log(
      `[lead-service] channel refusal campaign=${campaignId} code=${parsed.data.code} leads=${released.map((r) => r.leadId).join(",")}: released to the brand's other pipes`,
    );
    res.json({
      campaignId,
      code: parsed.data.code,
      released: released.map((r) => ({ leadId: r.leadId, alreadyReleased: r.alreadyReleased })),
    });
  }),
);

export default router;
