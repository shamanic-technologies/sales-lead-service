import { Router, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { FollowupDateStatementSchema } from "../schemas.js";
import {
  FollowupStatementError,
  loadFollowupDate,
  loadQueued,
  stateLeadFollowupDate,
  dueVerdict,
  type FollowupStatement,
} from "../lib/lead-followup-date.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The person's NEXT FOLLOW-UP DATE at the brand (LEAD-FOLLOWUP-DATE-1016, src/lib/lead-followup-date.ts), by the lead
 * ROW id a writer holds (`leadCampaignId` on a serve, the list row `id`, any campaign's row of the person). `brandId`
 * defaults to the row's first brand.
 */
async function resolveRow(req: AuthenticatedRequest, res: Response): Promise<{ id: string; leadId: string; brandId: string } | null> {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "invalid_id", detail: "id must be the `id` of a lead row, a uuid" });
    return null;
  }
  const asked = typeof req.query.brandId === "string" && req.query.brandId.trim() !== "" ? req.query.brandId.trim() : null;
  const [row] = (await db.execute(sql`
    SELECT lead_id::text AS lead_id, brand_ids FROM leads_campaigns WHERE id = ${id}::uuid AND org_id = ${req.orgId!}
  `)) as unknown as Array<{ lead_id: string; brand_ids: string[] }>;
  if (!row) {
    res.status(404).json({ error: "lead_not_found" });
    return null;
  }
  if (asked && !row.brand_ids.includes(asked)) {
    res.status(404).json({ error: "lead_not_found_for_brand" });
    return null;
  }
  const brandId = asked ?? row.brand_ids[0];
  if (!brandId) {
    res.status(409).json({ error: "lead_has_no_brand" });
    return null;
  }
  return { id, leadId: row.lead_id, brandId };
}

async function answer(req: AuthenticatedRequest, res: Response, r: { id: string; leadId: string; brandId: string }, extra: Record<string, unknown> = {}) {
  const orgId = req.orgId!;
  let verdict;
  try {
    verdict = await dueVerdict({ orgId, brandId: r.brandId, leadId: r.leadId }, { userId: req.userId ?? null, runId: req.runId ?? null });
  } catch (err) {
    console.error(`[lead-service] follow-up date verdict failed org=${orgId} brand=${r.brandId} lead=${r.leadId}:`, err);
    res.status(502).json({ error: "verdict_unavailable", detail: err instanceof Error ? err.message : String(err) });
    return;
  }
  const [followupDate, queued] = await Promise.all([loadFollowupDate(orgId, r.brandId, r.leadId), loadQueued(orgId, r.brandId, r.leadId, verdict)]);
  res.json({
    leadCampaignId: r.id,
    leadId: r.leadId,
    brandId: r.brandId,
    followupDate,
    queued,
    owed: { owed: verdict.owed, kind: verdict.kind, retryAfter: verdict.retryAfter, reason: verdict.reason, reasons: verdict.reasons, relationshipTags: verdict.relationshipTags },
    ...extra,
  });
}

router.get("/orgs/leads/:id/followup-date", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const r = await resolveRow(req, res);
    if (!r) return;
    await answer(req, res, r);
  } catch (err) {
    console.error(`[lead-service] GET followup-date failed id=${req.params.id}:`, err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

router.put("/orgs/leads/:id/followup-date", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const parsed = FollowupDateStatementSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    return;
  }
  const b = parsed.data;
  let statement: FollowupStatement;
  if (b.stop) {
    if (b.nextFollowupAt || b.sent) {
      res.status(400).json({ error: "stop_excludes_date", detail: "`stop` ends the follow-ups: state it alone, without nextFollowupAt or sent" });
      return;
    }
    statement = { kind: "stop", reason: b.stop.reason };
  } else if (b.nextFollowupAt) {
    if (!b.reason) {
      res.status(400).json({ error: "reason_required", detail: "a stated nextFollowupAt carries a short `reason` (why then)" });
      return;
    }
    statement = { kind: "date", nextFollowupAt: b.nextFollowupAt, reason: b.reason, ...(b.sent ? { sent: b.sent } : {}) };
  } else if (b.sent) {
    statement = { kind: "sent", sent: b.sent, ...(b.reason ? { reason: b.reason } : {}) };
  } else {
    res.status(400).json({ error: "nothing_stated", detail: "state nextFollowupAt (+ reason), sent, or stop" });
    return;
  }
  try {
    const r = await resolveRow(req, res);
    if (!r) return;
    const { replayed } = await stateLeadFollowupDate({
      orgId: req.orgId!,
      brandId: r.brandId,
      leadId: r.leadId,
      statement,
      campaignId: req.campaignId ?? null,
      runId: req.runId ?? null,
    });
    await answer(req, res, r, { replayed });
  } catch (err) {
    if (err instanceof FollowupStatementError) {
      res.status(400).json({ error: err.code, detail: err.message, ...err.detail });
      return;
    }
    console.error(`[lead-service] PUT followup-date failed id=${req.params.id}:`, err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

export default router;
