/**
 * What the customer's own CRM evidences about a lead, and WHOSE WIN each evidenced step was.
 *
 *   POST   /orgs/leads/crm-evidence/sync?brandId=         — reflect the brand's CRM now
 *   GET    /orgs/leads/:id/crm-attribution                — per CRM-evidenced step: the evidence, the
 *                                                          rule's answer, a person's override, and
 *                                                          which of the two stands
 *   PUT    /orgs/leads/:id/crm-attribution/:step          — a person states whose win it was
 *   DELETE /orgs/leads/:id/crm-attribution/:step          — withdraw it; the rule's answer stands again
 *
 * `:id` is the `leads_campaigns.id` a leads-list row (and a CRM pairing row's lead) already
 * carries. The override is about the PERSON and the step within the brand, because the CRM evidence
 * is about the person, not about one campaign row. Policy: crm-evidence.ts.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import {
  CRM_EVIDENCED_STEPS,
  crmCauseRule,
  effectiveCrmCause,
  isCrmEvidencedStep,
  type CrmCauseRule,
} from "../lib/crm-evidence.js";
import {
  loadCauseStatements,
  loadLiveCrmOutcomes,
  setCrmOutcomeCause,
  upsertCauseStatement,
  withdrawCauseStatement,
  type CauseStatement,
  type LiveCrmOutcome,
} from "../lib/crm-evidence-store.js";
import { syncBrandOnce } from "../lib/crm-evidence-worker.js";
import { CrmServiceError } from "../lib/crm-client.js";

const router = Router();

function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// POST /orgs/leads/crm-evidence/sync
// ---------------------------------------------------------------------------

router.post(
  "/orgs/leads/crm-evidence/sync",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : "";
    if (!UUID_RE.test(brandId)) {
      res.status(400).json({ error: "brandId query parameter is required (uuid)" });
      return;
    }
    try {
      const result = await syncBrandOnce(req.orgId!, brandId);
      res.json(result);
    } catch (error) {
      // A sibling that could not answer is a 502 with its reason — never a partial sync reported
      // as done. Nothing is set aside when a read fails (see crm-evidence-sync.ts).
      if (error instanceof CrmServiceError || /email-gateway/i.test((error as Error).message)) {
        res.status(502).json({ error: (error as Error).message });
        return;
      }
      throw error;
    }
  }),
);

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface LeadRowRef {
  id: string;
  lead_id: string;
  brand_ids: string[];
}

/** The ONE row the caller names, org in the predicate: another org's row reads as absent. */
async function fetchRow(orgId: string, id: string): Promise<LeadRowRef | null> {
  const rows = (await db.execute(sql`
    SELECT id, lead_id, brand_ids FROM leads_campaigns
    WHERE id = ${id} AND org_id = ${orgId}
    LIMIT 1
  `)) as unknown as LeadRowRef[];
  return rows[0] ?? null;
}

/** Same scoping as the step statements: `?brandId=` must be one the row is listed under. */
function resolveBrandId(row: LeadRowRef, req: AuthenticatedRequest): string | null {
  const fromQuery = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
  const requested = fromQuery ? [fromQuery] : (req.brandIds ?? []);
  if (requested.length > 0) return requested.find((b) => row.brand_ids.includes(b)) ?? null;
  return row.brand_ids[0] ?? null;
}

function storedRule(outcome: LiveCrmOutcome): CrmCauseRule {
  // Every CRM row is written with its rule; recompute from what is stored should one lack it.
  return outcome.evidence?.rule ?? crmCauseRule(outcome.occurredAt, null);
}

function entryFor(
  step: string,
  outcome: LiveCrmOutcome | null,
  statement: CauseStatement | null,
) {
  if (!outcome) {
    return {
      step,
      evidence: null,
      rule: null,
      statement,
      // Nothing of their CRM stands on this step, so there is nothing for an answer to be about.
      causedByOutreach: null,
      basis: null,
    };
  }
  const rule = storedRule(outcome);
  const effective = effectiveCrmCause(rule, statement);
  return {
    step,
    evidence: {
      crmContactId: outcome.evidence?.crmContactId ?? null,
      crmStep: outcome.evidence?.crmStep ?? null,
      occurredAt: outcome.occurredAt,
      dateBasis: outcome.evidence?.dateBasis ?? null,
      source: outcome.evidence?.source ?? null,
      sourceId: outcome.evidence?.sourceId ?? null,
      valueCents: outcome.valueCents,
    },
    rule,
    statement,
    causedByOutreach: effective.causedByOutreach,
    basis: effective.basis,
  };
}

async function loadRowAndBrand(req: AuthenticatedRequest, res: Response) {
  const id = req.params.id;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
    return null;
  }
  const row = await fetchRow(req.orgId!, id);
  const brandId = row ? resolveBrandId(row, req) : null;
  if (!row || !brandId) {
    res.status(404).json({ error: "Lead not found" });
    return null;
  }
  return { row, brandId };
}

router.get(
  "/orgs/leads/:id/crm-attribution",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const loaded = await loadRowAndBrand(req, res);
    if (!loaded) return;
    const { row, brandId } = loaded;
    const [outcomes, statements] = await Promise.all([
      loadLiveCrmOutcomes(brandId, row.lead_id),
      loadCauseStatements(brandId, [row.lead_id]),
    ]);
    res.json({
      leadCampaignId: row.id,
      leadId: row.lead_id,
      brandId,
      steps: CRM_EVIDENCED_STEPS.map((step) =>
        entryFor(step, outcomes.get(step) ?? null, statements.get(`${row.lead_id}:${step}`) ?? null),
      ),
    });
  }),
);

const CauseBodySchema = z.object({
  causedByOutreach: z.boolean(),
  note: z.string().optional(),
});

router.put(
  "/orgs/leads/:id/crm-attribution/:step",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const step = req.params.step;
    if (!isCrmEvidencedStep(step)) {
      res.status(400).json({ error: `step must be one of ${CRM_EVIDENCED_STEPS.join(" | ")}` });
      return;
    }
    const parsed = CauseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "causedByOutreach (boolean) is required" });
      return;
    }
    const loaded = await loadRowAndBrand(req, res);
    if (!loaded) return;
    const { row, brandId } = loaded;

    const outcomes = await loadLiveCrmOutcomes(brandId, row.lead_id);
    const outcome = outcomes.get(step) ?? null;
    if (!outcome) {
      res.status(409).json({
        error:
          `Their CRM evidences no ${step} for this lead, so there is no CRM answer to override. ` +
          "A step a person stated carries its own causedByOutreach on the step statement.",
        code: "no_crm_evidence",
      });
      return;
    }

    await upsertCauseStatement({
      orgId: req.orgId!,
      brandId,
      leadId: row.lead_id,
      step,
      causedByOutreach: parsed.data.causedByOutreach,
      note: parsed.data.note ?? null,
      statedByUserId: req.userId ?? null,
    });
    await setCrmOutcomeCause(outcome.id, parsed.data.causedByOutreach);

    const statements = await loadCauseStatements(brandId, [row.lead_id]);
    res.json({
      leadCampaignId: row.id,
      leadId: row.lead_id,
      brandId,
      ...entryFor(
        step,
        { ...outcome, causedByOutreach: parsed.data.causedByOutreach },
        statements.get(`${row.lead_id}:${step}`) ?? null,
      ),
    });
  }),
);

router.delete(
  "/orgs/leads/:id/crm-attribution/:step",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const step = req.params.step;
    if (!isCrmEvidencedStep(step)) {
      res.status(400).json({ error: `step must be one of ${CRM_EVIDENCED_STEPS.join(" | ")}` });
      return;
    }
    const loaded = await loadRowAndBrand(req, res);
    if (!loaded) return;
    const { row, brandId } = loaded;

    const withdrawn = await withdrawCauseStatement(brandId, row.lead_id, step, req.userId ?? null);
    const outcome = (await loadLiveCrmOutcomes(brandId, row.lead_id)).get(step) ?? null;
    if (outcome) {
      const rule = storedRule(outcome);
      await setCrmOutcomeCause(outcome.id, rule.causedByOutreach);
      outcome.causedByOutreach = rule.causedByOutreach;
    }
    res.json({
      leadCampaignId: row.id,
      leadId: row.lead_id,
      brandId,
      withdrawn,
      alreadyWithdrawn: !withdrawn,
      ...entryFor(step, outcome, null),
    });
  }),
);

export default router;
