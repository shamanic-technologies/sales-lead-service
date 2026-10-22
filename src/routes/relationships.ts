/**
 * Who a person is to a brand (RELATIONSHIP-TAGS-1014): the relationship block by human (crm-service's
 * Unibox, the CRM serve), the review page, and the owner's one-click fixes. Rules: src/lib/relationship-*.ts.
 */
import { messageOf } from "../lib/db-error.js";
import { Router, type Response } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { CompanyServiceError } from "../lib/company-client.js";
import { HumanIdentityError } from "../lib/human-identity-client.js";
import { CompanyStatementError, stateCompany } from "../lib/relationship-company.js";
import { answerMergeQuestion, MergeQuestionNotFoundError, undoMerge } from "../lib/relationship-merges.js";
import { EMPTY_RELATIONSHIP, loadRelationships, readBrandIntent, readReview, relationshipOfLead, stateTag, withdrawTag } from "../lib/relationship-read.js";
import { WANTS_BUSINESS } from "../lib/relationship-intent.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { isRelationshipTag } from "../lib/relationship-tags.js";

const router = Router();
/** A tag, or the `wants_business` answer a person of the org may state (HOT-INBOUND-UNANSWERED-1016). */
const isStatable = (tag: string) => isRelationshipTag(tag) || tag === WANTS_BUSINESS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RelationshipsQueryBody = z.object({ humanIds: z.array(z.string().regex(UUID_RE)).min(1).max(1000) });
/** `?companyKey=` names the relation (Unibox row) a tag is said about (PERSON-RELATIONS-1017); absent = the human's. */
function companyKeyOf(req: AuthenticatedRequest): string | undefined {
  return typeof req.query.companyKey === "string" ? req.query.companyKey : undefined;
}

export const TagStateBody = z.object({ state: z.enum(["yes", "no"]) });
export const MergeAnswerBody = z.object({ same: z.boolean() });
export const CompanyBody = z.union([
  z.object({ domain: z.string().min(3).max(253) }).strict(),
  z.object({ name: z.string().min(1).max(200) }).strict(),
  z.object({ none: z.literal(true) }).strict(),
]);

function brandOf(req: AuthenticatedRequest, res: Response): string | null {
  const brandId = String(req.params.brandId ?? "");
  if (!UUID_RE.test(brandId)) {
    res.status(400).json({ error: "brandId must be a uuid" });
    return null;
  }
  return brandId;
}

function userOf(req: AuthenticatedRequest, res: Response): string | null {
  if (!req.userId) {
    res.status(400).json({ error: "x-user-id header required: a person's word names who said it" });
    return null;
  }
  return req.userId;
}

function fail(res: Response, where: string, err: unknown): void {
  console.error(`[lead-service] ${where} failed:`, err);
  if (err instanceof HumanIdentityError || err instanceof CompanyServiceError) {
    res.status(502).json({ error: "dependency_unavailable", detail: messageOf(err) });
    return;
  }
  res.status(500).json({ error: "internal_error" });
}

router.post("/internal/brands/:brandId/relationships/query", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  const parsed = RelationshipsQueryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  try {
    const blocks = await loadRelationships(req.orgId!, brandId, parsed.data.humanIds);
    res.json({
      relationships: parsed.data.humanIds.map((h) => ({ ...(blocks.get(h) ?? { ...EMPTY_RELATIONSHIP, humanId: h }), humanId: h })),
    });
  } catch (err) {
    fail(res, "relationships query", err);
  }
});

router.get("/orgs/brands/:brandId/relationships/review", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  try {
    res.json(await readReview(req.orgId!, brandId));
  } catch (err) {
    fail(res, "relationships review", err);
  }
});

// HOT-INBOUND-UNANSWERED-1016: every person who wrote to the brand, is a lead / wants business (features-service families).
router.get("/internal/brands/:brandId/relationships/intent", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  try {
    const people = await readBrandIntent(req.orgId!, brandId);
    res.json({ brandId, count: people.length, people });
  } catch (err) {
    fail(res, "relationships intent", err);
  }
});

router.post(
  "/orgs/brands/:brandId/relationships/merge-questions/:questionId/answer",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res: Response) => {
    const brandId = brandOf(req, res);
    if (!brandId) return;
    const userId = userOf(req, res);
    if (!userId) return;
    const questionId = String(req.params.questionId);
    const parsed = MergeAnswerBody.safeParse(req.body);
    if (!UUID_RE.test(questionId) || !parsed.success) {
      res.status(400).json({ error: "invalid_request", detail: "questionId must be a uuid and body {same: boolean}" });
      return;
    }
    try {
      res.json(await answerMergeQuestion({ orgId: req.orgId!, brandId, questionId, same: parsed.data.same, userId }));
    } catch (err) {
      if (err instanceof MergeQuestionNotFoundError) {
        res.status(404).json({ error: "merge_question_not_found" });
        return;
      }
      if (err instanceof HumanIdentityError && err.status === 409) {
        res.status(409).json({ error: "human_service_refused", detail: messageOf(err) });
        return;
      }
      fail(res, "merge answer", err);
    }
  },
);

router.post("/orgs/brands/:brandId/relationships/merges/:linkId/undo", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  const userId = userOf(req, res);
  if (!userId) return;
  try {
    res.json(await undoMerge({ orgId: req.orgId!, brandId, linkId: String(req.params.linkId), userId }));
  } catch (err) {
    if (err instanceof MergeQuestionNotFoundError) {
      res.status(404).json({ error: "merge_not_found" });
      return;
    }
    fail(res, "merge undo", err);
  }
});

router.put("/orgs/brands/:brandId/relationships/:humanId/tags/:tag", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  const userId = userOf(req, res);
  if (!userId) return;
  const humanId = String(req.params.humanId);
  const tag = String(req.params.tag);
  const parsed = TagStateBody.safeParse(req.body);
  if (!UUID_RE.test(humanId) || !isStatable(tag) || !parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: "humanId uuid, a known tag, body {state: yes|no}" });
    return;
  }
  try {
    await stateTag({ orgId: req.orgId!, brandId, humanId, tag, state: parsed.data.state, userId, companyKey: companyKeyOf(req) });
    const block = (await loadRelationships(req.orgId!, brandId, [humanId])).get(humanId) ?? { ...EMPTY_RELATIONSHIP, humanId };
    res.json({ relationship: block });
  } catch (err) {
    fail(res, "tag statement", err);
  }
});

router.delete("/orgs/brands/:brandId/relationships/:humanId/tags/:tag", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  const userId = userOf(req, res);
  if (!userId) return;
  const humanId = String(req.params.humanId);
  const tag = String(req.params.tag);
  if (!UUID_RE.test(humanId) || !isStatable(tag)) {
    res.status(400).json({ error: "invalid_request", detail: "humanId uuid and a known tag" });
    return;
  }
  try {
    const withdrawn = await withdrawTag({ orgId: req.orgId!, brandId, humanId, tag, userId, companyKey: companyKeyOf(req) });
    const block = (await loadRelationships(req.orgId!, brandId, [humanId])).get(humanId) ?? { ...EMPTY_RELATIONSHIP, humanId };
    res.json({ withdrawn, relationship: block });
  } catch (err) {
    fail(res, "tag withdrawal", err);
  }
});

router.put("/orgs/brands/:brandId/relationships/:humanId/company", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = brandOf(req, res);
  if (!brandId) return;
  const userId = userOf(req, res);
  if (!userId) return;
  const humanId = String(req.params.humanId);
  const parsed = CompanyBody.safeParse(req.body);
  if (!UUID_RE.test(humanId) || !parsed.success) {
    res.status(400).json({ error: "invalid_request", detail: "body {domain} or {name} or {none: true}" });
    return;
  }
  try {
    const company = await stateCompany({ orgId: req.orgId!, humanId, userId, ...parsed.data });
    res.json({ company });
  } catch (err) {
    if (err instanceof CompanyStatementError) {
      res.status(400).json({ error: "invalid_domain", detail: messageOf(err) });
      return;
    }
    fail(res, "company statement", err);
  }
});

/**
 * Who the person of ONE lead row is to its brand (writers read it before writing). `{id}` = the list row's `id`
 * (a `leads_campaigns` row of the org; foreign = 404); `brandId` defaults to the row's first brand.
 */
router.get("/orgs/leads/:id/relationship", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
    return;
  }
  const asked = typeof req.query.brandId === "string" ? req.query.brandId : null;
  try {
    const rows = (await db.execute(sql`
      SELECT lead_id::text AS lead_id, brand_ids FROM leads_campaigns WHERE id = ${id}::uuid AND org_id = ${req.orgId!}
    `)) as unknown as Array<{ lead_id: string; brand_ids: string[] }>;
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (asked && !row.brand_ids.includes(asked)) {
      res.status(404).json({ error: "Lead not found for this brand" });
      return;
    }
    const brandId = asked ?? row.brand_ids[0] ?? null;
    res.json({ leadId: row.lead_id, brandId, relationship: await relationshipOfLead(req.orgId!, brandId, row.lead_id) });
  } catch (err) {
    fail(res, "lead relationship", err);
  }
});

export default router;
