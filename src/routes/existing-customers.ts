/**
 * "This person already buys from the brand", read off the prospect's own reply — on the wire.
 *
 * The caller is the service that classified the reply (instantly-service). It holds the org, the
 * campaign and the person's address, never this service's row ids, so the person is found EXACTLY
 * the way the follow-up queue's by-email door finds them. What the statement MEANS and how it is
 * stored is `src/lib/existing-customer.ts`.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import {
  recordExistingCustomerFromReply,
  withdrawExistingCustomerFromReply,
} from "../lib/existing-customer.js";

const router = Router();

function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

const RecordBodySchema = z.object({
  email: z.string().trim().min(1),
  replyRef: z.string().trim().min(1).max(200).optional(),
});

const WithdrawBodySchema = z.object({
  email: z.string().trim().min(1),
});

function refuseLookup(
  res: Response,
  r:
    | { code: "lead_not_found" }
    | { code: "ambiguous_lead"; matches: Array<{ id: string; leadId: string; email: string }> }
    | { code: "lead_has_no_brand" },
): void {
  if (r.code === "ambiguous_lead") {
    res.status(409).json({
      error: "That address matches more than one lead row on this campaign; nothing was recorded",
      code: "ambiguous_lead",
      matches: r.matches,
    });
    return;
  }
  if (r.code === "lead_has_no_brand") {
    res.status(409).json({
      error: "This lead row carries no brand, so there is no brand whose customer they could be",
      code: "lead_has_no_brand",
    });
    return;
  }
  res.status(404).json({
    error: "No lead on this campaign holds that email address",
    code: "lead_not_found",
  });
}

router.post(
  "/orgs/campaigns/:campaignId/existing-customers/by-email",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    const parsed = RecordBodySchema.safeParse(req.body);
    if (!campaignId || !parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.success ? undefined : parsed.error.flatten(),
      });
      return;
    }

    const result = await recordExistingCustomerFromReply({
      orgId: req.orgId as string,
      campaignId,
      email: parsed.data.email,
      replyRef: parsed.data.replyRef ?? null,
    });

    if (!result.ok) {
      if (result.code === "stated_never") {
        res.status(409).json({
          error:
            "A person stated this lead will never buy; a reading of a reply does not overrule them. Nothing was recorded.",
          code: "stated_never",
          leadId: result.leadId,
          leadCampaignId: result.leadCampaignId,
        });
        return;
      }
      refuseLookup(res, result);
      return;
    }

    if (result.status === "already_won") {
      console.log(
        `[lead-service] existing customer from reply: already won by ${result.wonBy} campaign=${campaignId} lead=${result.leadId}`,
      );
      res.status(200).json({
        status: "already_won",
        wonBy: result.wonBy,
        leadId: result.leadId,
        leadCampaignId: result.leadCampaignId,
        brandId: result.brandId,
        email: result.email,
        outcome: null,
      });
      return;
    }

    console.log(
      `[lead-service] existing customer from reply: ${result.status} campaign=${campaignId} lead=${result.outcome.leadId}`,
    );
    res.status(result.status === "recorded" ? 201 : 200).json({
      status: result.status,
      wonBy: "reply",
      leadId: result.outcome.leadId,
      leadCampaignId: result.outcome.leadCampaignId,
      brandId: result.outcome.brandId,
      email: result.outcome.email,
      outcome: result.outcome,
    });
  }),
);

router.post(
  "/orgs/campaigns/:campaignId/existing-customers/by-email/withdraw",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    const parsed = WithdrawBodySchema.safeParse(req.body);
    if (!campaignId || !parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.success ? undefined : parsed.error.flatten(),
      });
      return;
    }

    const result = await withdrawExistingCustomerFromReply({
      orgId: req.orgId as string,
      campaignId,
      email: parsed.data.email,
    });

    if (!result.ok) {
      if (result.code === "nothing_recorded") {
        res.status(409).json({
          error: "Nothing was ever recorded from a reply for this person, so there is nothing to withdraw",
          code: "nothing_recorded",
        });
        return;
      }
      refuseLookup(res, result);
      return;
    }

    res.json({
      withdrawn: result.withdrawn,
      alreadyWithdrawn: result.alreadyWithdrawn,
      leadId: result.leadId,
      leadCampaignId: result.leadCampaignId,
      brandId: result.brandId,
    });
  }),
);

export default router;
