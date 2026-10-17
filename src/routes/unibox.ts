/**
 * The Unibox, read from lead-service (UNIBOX-SIX-TAGS-1017, owner 2026-10-17): the list of the brand's leads (the
 * people crm-service tags professional to the brand) with their six tag dimensions, and one lead's card. crm-service
 * keeps the thread and the sending.
 *
 *   GET /orgs/leads/unibox?brandId=[&status=&role=&type=&lifecycle=&interest=&conversation=&contactability=&fit=&q=&limit=&cursor=]
 *       Most recent activity first. Each filter is a comma list (any of); `lifecycle=none` = no rung yet. `total` is
 *       the size of the filtered set; `nextCursor` pages it. Unknown filter value / bad bound = 400.
 *   GET /orgs/leads/unibox-lead?brandId=&(relationKey=|humanId=)
 *       One row = one RELATION (a human at a company, PERSON-RELATIONS-1017): `relationKey` names it; `humanId` alone =
 *       that human's most recently active row. The lead card: the six tags + every campaign the person is part of, with the furthest step in each. 404 = not
 *       a lead of the brand.
 *
 * Mounted BEFORE the leads router so neither path is read as a lead id; the gateway reaches both through
 * `/v1/leads/:id` (path + query forwarded).
 */
import { Router } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  UNIBOX_CONTACTABILITY,
  UNIBOX_CONVERSATION,
  UNIBOX_FIT,
  UNIBOX_INTEREST,
  UNIBOX_ROLES,
  UNIBOX_STATUS,
  UNIBOX_TYPES,
} from "../lib/unibox-dimensions.js";
import { loadLifecycleCatalogue, readUniboxLead, readUniboxPage, UniboxCursorError, type UniboxFilters } from "../lib/unibox-model.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A professional relation key (crm-service): a personal relation has no Unibox row. */
const RELATION_KEY_RE = /^rel:[0-9a-f-]{36}:(pro|org:[0-9a-f-]{36})$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

class BadQuery extends Error {}

function list(raw: unknown, allowed: readonly string[], name: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new BadQuery(`${name} must be a comma list`);
  const values = raw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
  if (values.length === 0) throw new BadQuery(`${name} is empty`);
  const unknown = values.filter((v) => !allowed.includes(v));
  if (unknown.length > 0) throw new BadQuery(`${name}: unknown value(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`);
  return values;
}

function brandOf(req: AuthenticatedRequest): string {
  const brandId = typeof req.query.brandId === "string" ? req.query.brandId.trim() : "";
  if (!UUID_RE.test(brandId)) throw new BadQuery("brandId (uuid) is required");
  return brandId;
}

router.get("/orgs/leads/unibox", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    const brandId = brandOf(req);
    const catalogue = await loadLifecycleCatalogue();
    const filters: UniboxFilters = {
      status: list(req.query.status, UNIBOX_STATUS, "status"),
      roles: list(req.query.role, UNIBOX_ROLES, "role"),
      types: list(req.query.type, UNIBOX_TYPES, "type"),
      lifecycle: list(req.query.lifecycle, [...catalogue.ladder.map((r) => r.key), "none"], "lifecycle"),
      interest: list(req.query.interest, UNIBOX_INTEREST, "interest"),
      conversation: list(req.query.conversation, UNIBOX_CONVERSATION, "conversation"),
      contactability: list(req.query.contactability, UNIBOX_CONTACTABILITY, "contactability"),
      fit: list(req.query.fit, UNIBOX_FIT, "fit"),
      q: typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined,
    };
    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new BadQuery(`limit must be an integer 1..${MAX_LIMIT}`);
    }
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;
    const page = await readUniboxPage({ orgId: req.orgId!, brandId }, filters, { limit, cursor });
    res.json({ brandId, lifecycleLadder: catalogue.ladder, ...page });
  } catch (error) {
    if (error instanceof BadQuery || error instanceof UniboxCursorError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("[lead-service] unibox list read failed:", error);
    res.status(500).json({ error: "unibox list read failed" });
  }
});

router.get("/orgs/leads/unibox-lead", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    const brandId = brandOf(req);
    const humanId = typeof req.query.humanId === "string" ? req.query.humanId.trim() : "";
    const relationKey = typeof req.query.relationKey === "string" ? req.query.relationKey.trim() : "";
    if (humanId && !UUID_RE.test(humanId)) throw new BadQuery("humanId must be a uuid");
    if (relationKey && !RELATION_KEY_RE.test(relationKey)) throw new BadQuery("relationKey must be a crm relation key (rel:<personId>:pro|org:<companyId>)");
    if (!humanId && !relationKey) throw new BadQuery("relationKey or humanId is required");
    const card = await readUniboxLead({ orgId: req.orgId!, brandId }, humanId || null, relationKey || null);
    if (!card) {
      res.status(404).json({ error: "not a lead of this brand", code: "not_a_unibox_lead" });
      return;
    }
    res.json({ brandId, ...card });
  } catch (error) {
    if (error instanceof BadQuery) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("[lead-service] unibox lead read failed:", error);
    res.status(500).json({ error: "unibox lead read failed" });
  }
});

export default router;
