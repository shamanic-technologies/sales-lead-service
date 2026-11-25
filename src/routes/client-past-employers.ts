import { Router, type Response } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { CrmFactFeedNotCaughtUpError } from "../lib/crm-fact-events.js";
import { fillClientHistories, readClientPastEmployers } from "../lib/client-past-employers-read.js";
import { InsufficientCreditError, fundingCapLabel } from "../lib/treg-client.js";
import { messageOf } from "../lib/db-error.js";
import { OrgMembersUnavailableError } from "../lib/org-members.js";

const router = Router();

function failed(res: Response, brandId: string, error: unknown): void {
  if (error instanceof CrmFactFeedNotCaughtUpError) {
    res.status(503).json({ error: "crm_copy_not_caught_up", message: messageOf(error) });
    return;
  }
  if (error instanceof OrgMembersUnavailableError) {
    console.error(`[lead-service] client past employers: the members of the org owning brand ${brandId} are unreadable:`, error.message);
    res.status(502).json({ error: "org_members_unavailable", message: "Could not read the members of the org owning the brand" });
    return;
  }
  if (error instanceof InsufficientCreditError) {
    const cap = error.fundingCap;
    res.status(402).json({
      error: cap ? fundingCapLabel(cap.reason) : "Insufficient credit",
      code: "insufficient_credit",
      balanceCents: error.balanceCents,
      requiredCents: error.requiredCents,
      ...(cap ? { reason: cap.reason, sales_funnel_cap: cap.sales_funnel_cap } : {}),
    });
    return;
  }
  console.error(`[lead-service] client past employers failed for brand ${brandId}:`, error);
  res.status(500).json({ error: "client_past_employers_unreadable", message: "Could not read the paying clients' past employers" });
}

/**
 * GET /internal/brands/:brandId/client-past-employers (x-org-id) — the companies where the brand's PAYING CLIENTS
 * and its own TEAM (members of the org owning it + relations tagged team, TEAM-PAST-EMPLOYERS-1125) have worked, past or
 * current, with the people (`role`), roles and dates behind each (BRAND-PROOF-LOGOS-1121). A read: never spends, never
 * writes. Empty = `reason` (no_paying_clients = nobody at all | no_employment_history), never an error; client-service
 * unreadable = 502 `org_members_unavailable`.
 */
router.get("/internal/brands/:brandId/client-past-employers", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = String(req.params.brandId ?? "").trim();
  try {
    res.json(await readClientPastEmployers(req.orgId!, brandId));
  } catch (error) {
    failed(res, brandId, error);
  }
});

/**
 * POST /internal/brands/:brandId/client-past-employers (x-org-id, x-user-id, x-run-id) — first look up the careers of
 * team members and paying clients we hold none for (a team member no lead holds gets a global lead row; treg, org-billed on the caller's run; Apollo never), then answer the same read plus
 * `lookups` (what this call did). Idempotent: a client is looked up once (a non-finding lookup again after 90 days);
 * `lookups.remaining` > 0 = call again.
 */
router.post("/internal/brands/:brandId/client-past-employers", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = String(req.params.brandId ?? "").trim();
  if (!req.runId) {
    res.status(400).json({ error: "x-run-id header required", message: "the lookups' spend hangs on the caller's run" });
    return;
  }
  if (!req.userId) {
    res.status(400).json({ error: "x-user-id header required", message: "billing authorizes a paid lookup per user" });
    return;
  }
  try {
    const lookups = await fillClientHistories(
      { orgId: req.orgId!, userId: req.userId, runId: req.runId, brandId, campaignId: req.campaignId ?? null, workflowSlug: req.workflowSlug ?? null, featureSlug: req.featureSlug ?? null },
      brandId,
    );
    res.json({ ...(await readClientPastEmployers(req.orgId!, brandId)), lookups });
  } catch (error) {
    failed(res, brandId, error);
  }
});

export default router;
