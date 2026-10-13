/**
 * A campaign that names its people files each one here: "this person, already known to the brand,
 * is a lead of the brand on this campaign". What it means and what it writes: `src/lib/named-person.ts`.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { fileNamedPerson } from "../lib/named-person.js";

const router = Router();

function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

const BodySchema = z.object({
  email: z.string().trim().min(3).max(320).refine((v) => v.includes("@"), "not an email address"),
  // The brand's own organization names this person (src/lib/named-person.ts): absent = today's door.
  statedBy: z
    .object({
      triggerEventId: z.string().trim().min(1).max(200),
      triggerId: z.string().trim().min(1).max(200).nullish(),
    })
    .nullish(),
  name: z.string().trim().max(300).nullish(),
});

router.post(
  "/orgs/campaigns/:campaignId/leads/by-email",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    const parsed = BodySchema.safeParse(req.body);
    if (!campaignId || !parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.success ? undefined : parsed.error.flatten(),
      });
      return;
    }

    let result: Awaited<ReturnType<typeof fileNamedPerson>>;
    try {
      result = await fileNamedPerson({
        orgId: req.orgId as string,
        campaignId,
        email: parsed.data.email,
        userId: req.userId ?? null,
        runId: req.runId ?? null,
        statedBy: parsed.data.statedBy ?? null,
        fullName: parsed.data.name ?? null,
      });
    } catch (err) {
      console.error(`[lead-service] named person: filing failed campaign=${campaignId}:`, err);
      res.status(502).json({
        error: "Could not file the person: a dependency (campaign-service or the database) did not answer",
        code: "filing_unavailable",
      });
      return;
    }

    if (!result.ok) {
      if (result.code === "campaign_not_found") {
        res.status(404).json({ error: "campaign-service holds no such campaign for this org", code: result.code });
        return;
      }
      if (result.code === "person_not_known") {
        res.status(404).json({
          error:
            "The brand does not know this address (no live CRM fact of the brand, no lead of the brand carries it); nothing was filed",
          code: result.code,
        });
        return;
      }
      if (result.code === "person_suppressed") {
        console.log(
          `[lead-service] named person: suppressed campaign=${campaignId} reason=${result.reason}`,
        );
        res.status(409).json({
          error:
            "The person may not be contacted (unsubscribed, hard-bounced, or a live opt_out / do_not_contact fact on the human); nothing was filed",
          code: result.code,
          reason: result.reason,
        });
        return;
      }
      if (result.code === "campaign_has_no_brand") {
        res.status(409).json({ error: "The campaign states no brand, so there is no brand to file a lead under", code: result.code });
        return;
      }
      res.status(409).json({
        error: "That address is registered on more than one lead; nothing was filed",
        code: result.code,
        leadIds: result.leadIds,
      });
      return;
    }

    const { ok: _ok, ...filing } = result;
    console.log(
      `[lead-service] named person: ${filing.status} campaign=${campaignId} lead=${filing.leadId} row=${filing.leadCampaignId} knownBy=${filing.knownBy}`,
    );
    res.status(filing.status === "filed" ? 201 : 200).json(filing);
  }),
);

export default router;
