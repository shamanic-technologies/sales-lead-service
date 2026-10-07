/**
 * Qualification checks on the wire: the catalogue with estimated cost per row, suggested criteria
 * from a brand's offer, the brand's chosen criteria, a run on a sample of real leads, and what the
 * checks say about one lead. Model: src/lib/qualification.ts.
 *
 * Routes that SPEND (suggestions, sample) need the caller's full identity (org, user, run): the
 * spend hangs on a child run of the caller's run, so every cent is attributed. Reads never spend.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { qualificationCriteria } from "../db/schema.js";
import { and, eq, isNull } from "drizzle-orm";
import { buildFullLeadsBatch } from "../lib/lead-shape.js";
import { createRun, getRunTotalCents, updateRun } from "../lib/runs-client.js";
import {
  InsufficientCreditError,
  estimateCostPerRow,
  getCriterion,
  listCriteria,
  probeLabel,
  probeOf,
  resolveProbe,
  QUALIFICATION_MODES,
} from "../lib/qualification.js";
import { BUILTIN_PROBES, BUILTIN_PROBE_KEYS, probeSpecProblems } from "../lib/qualification-probes.js";
import {
  MAX_SAMPLE,
  generateSuggestions,
  latestSuggestions,
  leadsOfBrand,
  readLeadQualification,
  recentServedLeadIds,
  runCriterionOnLeads,
} from "../lib/qualification-run.js";
import { TregEndpointUnknownError } from "../lib/treg-catalog-client.js";
import type { SpendIdentity } from "../lib/treg-client.js";
import type { QualificationCriterionRow } from "../db/schema.js";

const router = Router();

function wrap<Req extends Request = Request>(fn: (req: Req, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof InsufficientCreditError) {
    res.status(402).json({ error: "Insufficient credit", code: "insufficient_credit", balanceCents: error.balanceCents, requiredCents: error.requiredCents });
    return;
  }
  console.error(`[lead-service] ${what} failed:`, error);
  res.status(502).json({ error: `${what} failed`, detail: (error as Error).message });
}

/** A spending route opens its own child run under the caller's run. */
async function openRun(req: AuthenticatedRequest, res: Response, brandId: string, taskName: string): Promise<SpendIdentity | null> {
  if (!req.userId || !req.runId) {
    res.status(400).json({ error: "x-user-id and x-run-id headers are required: this route spends on the org's behalf" });
    return null;
  }
  const run = await createRun({
    orgId: req.orgId as string,
    userId: req.userId,
    parentRunId: req.runId,
    serviceName: "lead-service",
    taskName,
    brandId,
    campaignId: req.campaignId,
    workflowSlug: req.workflowSlug,
    featureSlug: req.featureSlug,
  });
  return {
    orgId: req.orgId as string,
    userId: req.userId,
    runId: run.id,
    brandId,
    campaignId: req.campaignId ?? null,
    workflowSlug: req.workflowSlug ?? null,
    featureSlug: req.featureSlug ?? null,
  };
}

async function closeRun(identity: SpendIdentity, ok: boolean): Promise<void> {
  await updateRun(identity.runId, ok ? "completed" : "failed", { orgId: identity.orgId, userId: identity.userId ?? undefined, brandId: identity.brandId ?? undefined });
}

async function serializeCriterion(row: QualificationCriterionRow) {
  const spec = probeOf(row);
  return {
    id: row.id,
    question: row.question,
    mode: row.mode,
    availability: spec.kind === "company_data" ? "in_our_data" : "custom_check",
    source: probeLabel(spec),
    probe: spec,
    estimate: await estimateCostPerRow(spec),
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Catalogue -------------------------------------------------------------------------------

router.get(
  "/orgs/qualification/catalog",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (_req, res) => {
    try {
      const probes = await Promise.all(
        BUILTIN_PROBE_KEYS.map(async (key) => {
          const { description, spec } = BUILTIN_PROBES[key];
          return { key, source: probeLabel(spec), description, availability: spec.kind === "company_data" ? "in_our_data" : "custom_check", estimate: await estimateCostPerRow(spec) };
        }),
      );
      res.json({ probes });
    } catch (error) {
      fail(res, error, "qualification catalogue");
    }
  }),
);

// --- Suggestions -----------------------------------------------------------------------------

const SuggestBody = z.object({ offerId: z.string().trim().min(1) });

router.post(
  "/orgs/brands/:brandId/qualification/suggestions",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const parsed = SuggestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    let identity: SpendIdentity | null = null;
    try {
      identity = await openRun(req, res, req.params.brandId, "qualification-suggestions");
      if (!identity) return;
      const suggestions = await generateSuggestions({ orgId: req.orgId as string, brandId: req.params.brandId, offerId: parsed.data.offerId, identity });
      await closeRun(identity, true);
      res.json({ suggestions, runId: identity.runId });
    } catch (error) {
      if (identity) await closeRun(identity, false).catch((e) => console.error("[lead-service] closing run failed:", e));
      fail(res, error, "qualification suggestions");
    }
  }),
);

router.get(
  "/orgs/brands/:brandId/qualification/suggestions",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    try {
      const latest = await latestSuggestions(req.orgId as string, req.params.brandId);
      if (!latest) {
        res.status(404).json({ error: "No suggestions generated for this brand yet", code: "no_suggestions" });
        return;
      }
      res.json(latest);
    } catch (error) {
      fail(res, error, "qualification suggestions read");
    }
  }),
);

// --- Criteria --------------------------------------------------------------------------------

const ProbeInput = z.union([
  z.object({ builtin: z.string().min(1) }).strict(),
  z.object({ tregEndpointIds: z.array(z.string().min(1)).min(1).max(5) }).strict(),
]);

const CreateCriterionBody = z.object({
  question: z.string().trim().min(5).max(500),
  probe: ProbeInput,
  mode: z.enum(QUALIFICATION_MODES),
});

router.post(
  "/orgs/brands/:brandId/qualification/criteria",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const parsed = CreateCriterionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    try {
      const resolved = await resolveProbe(parsed.data.probe);
      if (!resolved.ok) {
        res.status(400).json({ error: "Unusable probe", code: "unusable_probe", reason: resolved.reason });
        return;
      }
      const problems = probeSpecProblems(resolved.spec);
      if (problems.length) {
        res.status(400).json({ error: "Unusable probe", code: "unusable_probe", reason: problems.join("; ") });
        return;
      }
      const [row] = await db
        .insert(qualificationCriteria)
        .values({ orgId: req.orgId as string, brandId: req.params.brandId, question: parsed.data.question, probe: resolved.spec, mode: parsed.data.mode, createdByUserId: req.userId ?? null })
        .returning();
      res.status(201).json({ criterion: await serializeCriterion(row) });
    } catch (error) {
      if (error instanceof TregEndpointUnknownError) {
        res.status(400).json({ error: "Unusable probe", code: "unusable_probe", reason: error.message });
        return;
      }
      fail(res, error, "qualification criterion create");
    }
  }),
);

router.get(
  "/orgs/brands/:brandId/qualification/criteria",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    try {
      const rows = await listCriteria(req.orgId as string, req.params.brandId);
      res.json({ criteria: await Promise.all(rows.map(serializeCriterion)) });
    } catch (error) {
      fail(res, error, "qualification criteria read");
    }
  }),
);

router.delete(
  "/orgs/brands/:brandId/qualification/criteria/:criterionId",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    try {
      const archived = await db
        .update(qualificationCriteria)
        .set({ archivedAt: new Date() })
        .where(and(eq(qualificationCriteria.id, req.params.criterionId), eq(qualificationCriteria.orgId, req.orgId as string), eq(qualificationCriteria.brandId, req.params.brandId), isNull(qualificationCriteria.archivedAt)))
        .returning({ id: qualificationCriteria.id });
      if (archived.length === 0) {
        res.status(404).json({ error: "No active criterion with that id on this brand", code: "criterion_not_found" });
        return;
      }
      res.json({ archived: true });
    } catch (error) {
      fail(res, error, "qualification criterion archive");
    }
  }),
);

// --- Run on a sample of real leads -----------------------------------------------------------

const SampleBody = z.union([
  z.object({ limit: z.number().int().min(1).max(MAX_SAMPLE) }).strict(),
  z.object({ leadIds: z.array(z.string().uuid()).min(1).max(MAX_SAMPLE) }).strict(),
]);

router.post(
  "/orgs/brands/:brandId/qualification/criteria/:criterionId/sample",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const parsed = SampleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `Invalid request: send either {limit} or {leadIds}, at most ${MAX_SAMPLE}`, details: parsed.error.flatten() });
      return;
    }
    const orgId = req.orgId as string;
    const brandId = req.params.brandId;
    let identity: SpendIdentity | null = null;
    try {
      const criterion = await getCriterion(orgId, brandId, req.params.criterionId);
      if (!criterion) {
        res.status(404).json({ error: "No active criterion with that id on this brand", code: "criterion_not_found" });
        return;
      }
      let leadIds: string[];
      if ("leadIds" in parsed.data) {
        const owned = await leadsOfBrand(orgId, brandId, parsed.data.leadIds);
        const foreign = parsed.data.leadIds.filter((id) => !owned.has(id));
        if (foreign.length) {
          res.status(404).json({ error: "Some leads are not leads of this brand", code: "lead_not_found", leadIds: foreign });
          return;
        }
        leadIds = parsed.data.leadIds;
      } else {
        leadIds = await recentServedLeadIds(orgId, brandId, parsed.data.limit);
      }
      identity = await openRun(req, res, brandId, "qualification-sample");
      if (!identity) return;
      const rows = await runCriterionOnLeads(criterion, leadIds, identity);
      await closeRun(identity, true);
      const total = await getRunTotalCents(identity.runId, orgId);
      res.json({
        criterionId: criterion.id,
        rows,
        run: {
          id: identity.runId,
          rows: rows.length,
          totalCostUsd: Math.round(total.totalCents * 10_000) / 1_000_000,
          costPerRowUsd: rows.length ? Math.round((total.totalCents / rows.length) * 10_000) / 1_000_000 : 0,
        },
      });
    } catch (error) {
      if (identity) await closeRun(identity, false).catch((e) => console.error("[lead-service] closing run failed:", e));
      fail(res, error, "qualification sample");
    }
  }),
);

// --- What the checks say about one lead ------------------------------------------------------

router.get(
  "/orgs/leads/:id/qualification",
  apiKeyAuth,
  requireOrgId,
  wrap<AuthenticatedRequest>(async (req, res) => {
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : null;
    if (!brandId || !z.string().uuid().safeParse(req.params.id).success) {
      res.status(400).json({ error: "A lead uuid and the brandId query parameter are required" });
      return;
    }
    try {
      const owned = await leadsOfBrand(req.orgId as string, brandId, [req.params.id]);
      if (!owned.has(req.params.id)) {
        res.status(404).json({ error: "Lead not found on this brand", code: "lead_not_found" });
        return;
      }
      const lead = (await buildFullLeadsBatch([req.params.id])).get(req.params.id);
      if (!lead) {
        res.status(404).json({ error: "Lead not found", code: "lead_not_found" });
        return;
      }
      const criteria = await listCriteria(req.orgId as string, brandId);
      res.json(await readLeadQualification(lead, criteria));
    } catch (error) {
      fail(res, error, "lead qualification read");
    }
  }),
);

export default router;
