import { Router, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { loadProspectFollowupVerdicts } from "../lib/prospect-followup.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this person still owed a PROSPECT follow-up by the brand (NEVER-NO-FOLLOWUP-1014)? The read a writer makes
 * right before writing (src/lib/prospect-followup.ts). FAIL LOUD: any source unreadable = 502, never a yes.
 */
async function answer(res: Response, orgId: string, brandId: string, leadId: string, ids: Record<string, string>, ctx: { userId?: string; runId?: string }) {
  try {
    const verdict = (await loadProspectFollowupVerdicts({ orgId, brandId, leadIds: [leadId], context: ctx })).get(leadId);
    if (!verdict) throw new Error(`no verdict computed for lead ${leadId}`);
    res.json({ ...ids, leadId, brandId, ...verdict });
  } catch (err) {
    console.error(`[lead-service] prospect follow-up verdict failed org=${orgId} brand=${brandId} lead=${leadId}:`, err);
    res.status(502).json({ error: "verdict_unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
}

/** By the lead ROW id (`leadCampaignId` on a serve, the list row `id`); `brandId` defaults to the row's first brand. */
router.get("/orgs/leads/:id/prospect-followup", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
    return;
  }
  const asked = typeof req.query.brandId === "string" && req.query.brandId.trim() !== "" ? req.query.brandId.trim() : null;
  let row: { lead_id: string; brand_ids: string[] } | undefined;
  try {
    [row] = (await db.execute(sql`
      SELECT lead_id::text AS lead_id, brand_ids FROM leads_campaigns WHERE id = ${id}::uuid AND org_id = ${req.orgId!}
    `)) as unknown as Array<{ lead_id: string; brand_ids: string[] }>;
  } catch (err) {
    console.error(`[lead-service] prospect follow-up row read failed id=${id}:`, err);
    res.status(500).json({ error: "internal_error" });
    return;
  }
  if (!row) {
    res.status(404).json({ error: "lead_not_found" });
    return;
  }
  if (asked && !row.brand_ids.includes(asked)) {
    res.status(404).json({ error: "lead_not_found_for_brand" });
    return;
  }
  const brandId = asked ?? row.brand_ids[0];
  if (!brandId) {
    res.status(409).json({ error: "lead_has_no_brand" });
    return;
  }
  await answer(res, req.orgId!, brandId, row.lead_id, { leadCampaignId: id }, { userId: req.userId, runId: req.runId });
});

/** By email at a brand: the lead of the org's brand registered on that address (case-folded). */
router.get("/orgs/brands/:brandId/prospect-followup", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = String(req.params.brandId ?? "").trim();
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!brandId || !email) {
    res.status(400).json({ error: "brandId and ?email= required" });
    return;
  }
  let leads: Array<{ lead_id: string }>;
  try {
    leads = (await db.execute(sql`
      SELECT DISTINCT cm.lead_id::text AS lead_id FROM lead_contact_methods cm
      WHERE cm.channel = 'email' AND lower(trim(cm.value)) = ${email}
        AND EXISTS (SELECT 1 FROM leads_campaigns lc WHERE lc.lead_id = cm.lead_id AND lc.org_id = ${req.orgId!} AND ${brandId} = ANY(lc.brand_ids))
    `)) as unknown as Array<{ lead_id: string }>;
  } catch (err) {
    console.error(`[lead-service] prospect follow-up email read failed brand=${brandId}:`, err);
    res.status(500).json({ error: "internal_error" });
    return;
  }
  if (leads.length === 0) {
    res.status(404).json({ error: "lead_not_found" });
    return;
  }
  if (leads.length > 1) {
    res.status(409).json({ error: "ambiguous_lead", leadIds: leads.map((l) => l.lead_id) });
    return;
  }
  await answer(res, req.orgId!, brandId, leads[0].lead_id, {}, { userId: req.userId, runId: req.runId });
});

export default router;
