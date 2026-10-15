/**
 * A campaign that names its people files each one here: "this person, already known to the brand,
 * is a lead of the brand on this campaign". What it means and what it writes: `src/lib/named-person.ts`.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { fileNamedPerson } from "../lib/named-person.js";
import { isIanaTimezone } from "../lib/timezone-inference.js";
import { canonicalE164 } from "../lib/e164-phone.js";

const router = Router();

function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

// `email` identifies the person whenever present (email-first, byte-identical). Without it, `phone` identifies
// them and must be E.164 (REPLY-PHONE-ONLY-1015: a WhatsApp writer known only by phone + name).
export const NamedPersonBodySchema = z
  .object({
  email: z.string().trim().min(3).max(320).refine((v) => v.includes("@"), "not an email address").nullish(),
  // The brand's own organization names this person (src/lib/named-person.ts): absent = today's door.
  statedBy: z
    .object({
      triggerEventId: z.string().trim().min(1).max(200),
      triggerId: z.string().trim().min(1).max(200).nullish(),
    })
    .nullish(),
  name: z.string().trim().max(300).nullish(),
  phone: z.string().trim().min(3).max(50).nullish(),
  // An IANA zone the client states for the person (src/lib/lead-timezone.ts); never an offset.
  timezone: z.string().trim().max(64).refine(isIanaTimezone, "not an IANA timezone (e.g. Europe/London)").nullish(),
  })
  .superRefine((body, ctx) => {
    if (body.email) return;
    if (!body.phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["email"], message: "email or phone (E.164) is required" });
    } else if (!canonicalE164(body.phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "with no email, phone identifies the person and must be E.164 (e.g. +33612345678)",
      });
    }
  });

router.post(
  "/orgs/campaigns/:campaignId/leads/by-email",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const campaignId = req.params.campaignId;
    const parsed = NamedPersonBodySchema.safeParse(req.body);
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
        email: parsed.data.email ?? null,
        userId: req.userId ?? null,
        runId: req.runId ?? null,
        statedBy: parsed.data.statedBy ?? null,
        fullName: parsed.data.name ?? null,
        phone: parsed.data.phone ?? null,
        timezone: parsed.data.timezone ?? null,
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
          error: parsed.data.email
            ? "The brand does not know this address (no live CRM fact of the brand, no lead of the brand carries it); nothing was filed"
            : "The brand does not know this phone (no live CRM fact of the brand, no lead of the brand carries it, no statement names it); nothing was filed",
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
        error: parsed.data.email
          ? "That address is registered on more than one lead; nothing was filed"
          : "That phone is registered on more than one lead; nothing was filed",
        code: result.code,
        leadIds: result.leadIds,
      });
      return;
    }

    const { ok: _ok, ...filing } = result;
    console.log(
      `[lead-service] named person: ${filing.status} campaign=${campaignId} lead=${filing.leadId} row=${filing.leadCampaignId} knownBy=${filing.knownBy} timezone=${filing.timezone ?? "none"}/${filing.timezoneSource ?? "none"}`,
    );
    res.status(filing.status === "filed" ? 201 : 200).json(filing);
  }),
);

export default router;
