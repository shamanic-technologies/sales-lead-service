/**
 * "Disqualified", its own mark beside the step tags (owner 2026-10-13; src/lib/lead-disqualification.ts).
 *
 *   GET    /orgs/leads/disqualifications?brandId=[&offerId=]   every disqualified person of the brand
 *                                                             (of one offer when named), with the note;
 *                                                             `total` is the length of the same list.
 *   PUT    /orgs/leads/:id/disqualification                    set it (or restate the note). Body
 *                                                             `{brandId?, offerId?, note?}`, all optional.
 *   DELETE /orgs/leads/:id/disqualification?[brandId=][&offerId=]  remove it.
 *
 * `:id` is the list row's id, as on every per-lead route; the mark is a fact about the PERSON at the
 * brand (and offer), never about that row. The brand is `brandId` (body for PUT, query for DELETE)
 * or x-brand-id when named (a brand the row is not part of is 404), else the row's own brand.
 * `offerId` absent = every offer of the brand. x-user-id is required: a mark records who set it.
 *
 * Mounted BEFORE the leads router so `/orgs/leads/disqualifications` is not read as a lead id (the
 * gateway reaches the GET through `/v1/leads/:id`).
 */
import { Router, type Response } from "express";
import { sql } from "../db/index.js";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  effectiveMark,
  listBrandDisqualifications,
  loadLiveMarks,
  normalizeDisqualificationNote,
  setDisqualification,
  withdrawDisqualification,
} from "../lib/lead-disqualification.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalString(raw: unknown, name: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error(`${name} must be a string`);
  const v = raw.trim();
  return v.length === 0 ? null : v;
}

/** The row, and the brand the statement is about. null = 404 (absent, foreign, or not that brand). */
async function resolveRow(
  req: AuthenticatedRequest,
  brandIdRaw: string | null,
): Promise<{ rowId: string; leadId: string; brandId: string } | null> {
  const rows = (await sql`
    SELECT id::text AS id, lead_id::text AS lead_id, brand_ids
    FROM leads_campaigns WHERE id = ${req.params.id} AND org_id = ${req.orgId!} LIMIT 1
  `) as unknown as Array<{ id: string; lead_id: string; brand_ids: string[] }>;
  const row = rows[0];
  if (!row) return null;
  const requested = brandIdRaw ? [brandIdRaw] : (req.brandIds ?? []);
  const brandId =
    requested.length > 0 ? (requested.find((b) => row.brand_ids.includes(b)) ?? null) : (row.brand_ids[0] ?? null);
  return brandId ? { rowId: row.id, leadId: row.lead_id, brandId } : null;
}

function fail(res: Response, error: unknown, what: string) {
  console.error(`[lead-service] ${what} failed:`, error);
  res.status(500).json({ error: `${what} failed` });
}

router.get("/orgs/leads/disqualifications", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  let brandId: string | null;
  let offerId: string | null;
  try {
    brandId = optionalString(req.query.brandId, "brandId") ?? req.brandIds?.[0] ?? null;
    offerId = optionalString(req.query.offerId, "offerId");
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  if (!brandId) {
    res.status(400).json({ error: "brandId is required" });
    return;
  }
  try {
    const leads = await listBrandDisqualifications({ orgId: req.orgId!, brandId, offerId });
    res.json({ brandId, offerId, total: leads.length, leads });
  } catch (error) {
    fail(res, error, "disqualifications read");
  }
});

router.put("/orgs/leads/:id/disqualification", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
    return;
  }
  if (!req.userId) {
    res.status(400).json({ error: "x-user-id is required: the mark records who set it" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "body must be an object" });
    return;
  }
  let brandIdRaw: string | null;
  let offerId: string | null;
  let note: string | null;
  try {
    brandIdRaw = optionalString(body.brandId, "brandId");
    offerId = optionalString(body.offerId, "offerId");
    note = normalizeDisqualificationNote(body.note);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  try {
    const target = await resolveRow(req, brandIdRaw);
    if (!target) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const disqualification = await setDisqualification({
      orgId: req.orgId!,
      brandId: target.brandId,
      leadId: target.leadId,
      offerId,
      note,
      statedByUserId: req.userId,
      leadCampaignId: target.rowId,
    });
    res.json({
      id: target.rowId,
      leadId: target.leadId,
      brandId: target.brandId,
      offerId,
      disqualified: true,
      disqualification,
    });
  } catch (error) {
    fail(res, error, "disqualification write");
  }
});

router.delete("/orgs/leads/:id/disqualification", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
    return;
  }
  if (!req.userId) {
    res.status(400).json({ error: "x-user-id is required: the withdrawal records who removed it" });
    return;
  }
  let brandIdRaw: string | null;
  let offerId: string | null;
  try {
    brandIdRaw = optionalString(req.query.brandId, "brandId");
    offerId = optionalString(req.query.offerId, "offerId");
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  try {
    const target = await resolveRow(req, brandIdRaw);
    if (!target) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const withdrawn = await withdrawDisqualification({
      orgId: req.orgId!,
      brandId: target.brandId,
      leadId: target.leadId,
      offerId,
      withdrawnByUserId: req.userId,
    });
    // What still answers for the conversation named: removing an offer's mark leaves a brand-wide
    // one standing, and the answer says so rather than claiming the person is clear.
    const marks = await loadLiveMarks({ orgId: req.orgId!, brandIds: [target.brandId], leadIds: [target.leadId] });
    const remaining = effectiveMark(marks.get(`${target.leadId}|${target.brandId}`), offerId);
    res.json({
      id: target.rowId,
      leadId: target.leadId,
      brandId: target.brandId,
      offerId,
      withdrawn,
      disqualified: remaining !== null,
      disqualification: remaining,
    });
  } catch (error) {
    fail(res, error, "disqualification withdrawal");
  }
});

export default router;
