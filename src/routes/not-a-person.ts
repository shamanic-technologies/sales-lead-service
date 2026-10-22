/**
 * FAKE-OUTCOMES-1022: the brand's own user (staff included) corrects figures our tests inflated.
 *
 *   GET    /orgs/leads/not-a-person[?leadId=]         every lead of the org marked not a real person
 *   PUT    /orgs/leads/:id/not-a-person               mark one (body `{note?}`); x-user-id required
 *   DELETE /orgs/leads/:id/not-a-person               lift the stated mark
 *
 *   GET    /orgs/brands/:brandId/conversions[?event=&leadId=&email=&limit=]   the brand's conversion events
 *   POST   /orgs/brands/:brandId/conversions/:conversionId/withdraw            withdraw a wrong one (`{note}`)
 *   DELETE /orgs/brands/:brandId/conversions/:conversionId/withdrawal          undo that withdrawal
 *
 * `:id` = a list row id (what every row of GET /orgs/leads carries) or the lead's own id. Mounted BEFORE
 * the leads router: `/orgs/leads/not-a-person` is not a lead id.
 */
import { Router, type Response } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { listNotAPerson, liftNotAPerson, resolveOrgLead, stateNotAPerson } from "../lib/not-a-person.js";
import {
  MAX_CONVERSION_LIST,
  MAX_WITHDRAWAL_NOTE,
  listBrandConversions,
  restoreConversion,
  withdrawConversion,
} from "../lib/conversion-withdrawal.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(res: Response, error: unknown, what: string) {
  console.error(`[lead-service] ${what} failed:`, error);
  res.status(500).json({ error: `${what} failed` });
}

function optionalString(raw: unknown, name: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error(`${name} must be a string`);
  const v = raw.trim();
  return v.length === 0 ? null : v;
}

function readNote(raw: unknown, required: boolean): string | null {
  const note = optionalString(raw, "note");
  if (note === null && required) throw new Error("note is required: say why, in your words");
  if (note !== null && note.length > MAX_WITHDRAWAL_NOTE) throw new Error(`note is over ${MAX_WITHDRAWAL_NOTE} characters`);
  return note;
}

router.get("/orgs/leads/not-a-person", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  let leadId: string | null;
  try {
    leadId = optionalString(req.query.leadId, "leadId");
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  if (leadId && !UUID_RE.test(leadId)) {
    res.status(400).json({ error: "leadId must be a uuid" });
    return;
  }
  try {
    const resolved = leadId ? await resolveOrgLead(req.orgId!, leadId) : null;
    if (leadId && !resolved) {
      res.json({ total: 0, leads: [] });
      return;
    }
    const leads = await listNotAPerson(req.orgId!, resolved ?? undefined);
    res.json({ total: leads.length, leads });
  } catch (error) {
    fail(res, error, "not-a-person read");
  }
});

router.put("/orgs/leads/:id/not-a-person", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "id must be a lead row id or a lead id, a uuid" });
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
  let note: string | null;
  try {
    note = readNote(body.note, false);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  try {
    const leadId = await resolveOrgLead(req.orgId!, req.params.id);
    if (!leadId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const out = await stateNotAPerson({ orgId: req.orgId!, leadId, userId: req.userId, note });
    const marks = await listNotAPerson(req.orgId!, leadId);
    res.json({ leadId, notAPerson: true, alreadyMarked: out.alreadyMarked, conversionsSetAside: out.setAside, marks });
  } catch (error) {
    fail(res, error, "not-a-person mark");
  }
});

router.delete("/orgs/leads/:id/not-a-person", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "id must be a lead row id or a lead id, a uuid" });
    return;
  }
  if (!req.userId) {
    res.status(400).json({ error: "x-user-id is required: lifting the mark records who did it" });
    return;
  }
  try {
    const leadId = await resolveOrgLead(req.orgId!, req.params.id);
    if (!leadId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const out = await liftNotAPerson({ orgId: req.orgId!, leadId, userId: req.userId });
    res.json({
      leadId,
      lifted: out.lifted,
      notAPerson: out.stillMarkedBy.length > 0,
      stillMarkedBy: out.stillMarkedBy,
      ...(out.stillMarkedBy.includes("staff_identity")
        ? { message: "Every email of this lead is one of our staff addresses: it stays out of your figures." }
        : {}),
      conversionsRestored: out.restored,
    });
  } catch (error) {
    fail(res, error, "not-a-person lift");
  }
});

router.get("/orgs/brands/:brandId/conversions", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  let event: string | null;
  let leadIdRaw: string | null;
  let email: string | null;
  let limit = 50;
  try {
    event = optionalString(req.query.event, "event");
    leadIdRaw = optionalString(req.query.leadId, "leadId");
    email = optionalString(req.query.email, "email");
    const rawLimit = optionalString(req.query.limit, "limit");
    if (rawLimit !== null) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_CONVERSION_LIST) {
        throw new Error(`limit must be an integer from 1 to ${MAX_CONVERSION_LIST}`);
      }
      limit = n;
    }
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  if (leadIdRaw && !UUID_RE.test(leadIdRaw)) {
    res.status(400).json({ error: "leadId must be a uuid" });
    return;
  }
  try {
    const leadId = leadIdRaw ? await resolveOrgLead(req.orgId!, leadIdRaw) : null;
    if (leadIdRaw && !leadId) {
      res.json({ brandId: req.params.brandId, total: 0, conversions: [] });
      return;
    }
    const conversions = await listBrandConversions({
      orgId: req.orgId!,
      brandId: req.params.brandId,
      event,
      leadId,
      email,
      limit,
    });
    res.json({ brandId: req.params.brandId, total: conversions.length, conversions });
  } catch (error) {
    fail(res, error, "conversions read");
  }
});

router.post(
  "/orgs/brands/:brandId/conversions/:conversionId/withdraw",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    if (!UUID_RE.test(req.params.conversionId)) {
      res.status(400).json({ error: "conversionId must be a uuid" });
      return;
    }
    if (!req.userId) {
      res.status(400).json({ error: "x-user-id is required: the withdrawal records who made it" });
      return;
    }
    let note: string;
    try {
      note = readNote((req.body ?? {}).note, true)!;
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    try {
      const out = await withdrawConversion({
        orgId: req.orgId!,
        brandId: req.params.brandId,
        id: req.params.conversionId,
        userId: req.userId,
        note,
      });
      if (out.kind === "not_found") {
        res.status(404).json({ error: "Conversion not found" });
        return;
      }
      if (out.kind === "refused") {
        res.status(409).json({
          error: out.code,
          message:
            out.code === "crm_evidence"
              ? "This conversion comes from your CRM: reject its pairing to correct it."
              : "This is a person's statement: withdraw it through the lead's step statements.",
          conversion: out.conversion,
        });
        return;
      }
      res.json({ alreadyWithdrawn: out.kind === "already_withdrawn", conversion: out.conversion });
    } catch (error) {
      fail(res, error, "conversion withdrawal");
    }
  },
);

router.delete(
  "/orgs/brands/:brandId/conversions/:conversionId/withdrawal",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    if (!UUID_RE.test(req.params.conversionId)) {
      res.status(400).json({ error: "conversionId must be a uuid" });
      return;
    }
    try {
      const out = await restoreConversion({ orgId: req.orgId!, brandId: req.params.brandId, id: req.params.conversionId });
      if (out.kind === "not_found") {
        res.status(404).json({ error: "Conversion not found" });
        return;
      }
      if (out.kind === "not_withdrawn_by_a_person") {
        res.status(409).json({ error: "not_withdrawn_by_a_person", conversion: out.conversion });
        return;
      }
      res.json({ conversion: out.conversion });
    } catch (error) {
      fail(res, error, "conversion restore");
    }
  },
);

export default router;
