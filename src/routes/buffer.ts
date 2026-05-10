import { Router } from "express";
import { eq, lt } from "drizzle-orm";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, requireRunId } from "../middleware/auth.js";
import { pullNext } from "../lib/buffer.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { BufferNextRequestSchema } from "../schemas.js";
import { db } from "../db/index.js";
import { idempotencyCache } from "../db/schema.js";
import { PULL_NEXT_TIMEOUT_MS } from "../config.js";
import { checkConcurrentBufferNext } from "../lib/inflight-guard.js";

const router = Router();

const IDEMPOTENCY_TTL_DAYS = 60;

function pruneExpiredIdempotencyCache(): void {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60 * 1000);
  db.delete(idempotencyCache)
    .where(lt(idempotencyCache.createdAt, cutoff))
    .then((result) => {
      if (result.length > 0) {
        console.log(`[lead-service] Pruned ${result.length} expired idempotency cache entries`);
      }
    })
    .catch((err) => {
      console.warn("[lead-service] Failed to prune expired idempotency cache:", err);
    });
}

router.post("/orgs/buffer/next", apiKeyAuth, requireOrgId, requireRunId, async (req: AuthenticatedRequest, res) => {
  const parsed = BufferNextRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const campaignId = req.campaignId;
  const brandIds = req.brandIds ?? [];

  if (!campaignId || brandIds.length === 0) {
    return res.status(400).json({ error: "x-campaign-id and x-brand-id headers required" });
  }

  const workflowSlug = req.workflowSlug;
  const runId = req.runId as string;

  const runMeta = {
    orgId: req.orgId,
    userId: req.userId,
    campaignId,
    brandId: req.brandId,
    workflowSlug,
    featureSlug: req.featureSlug,
  };

  // Idempotency on x-run-id: if this run already got a lead, return the cached response
  const cached = await db.query.idempotencyCache.findFirst({
    where: eq(idempotencyCache.idempotencyKey, runId),
  });
  if (cached) {
    console.log(`[lead-service] Idempotency hit for runId=${runId}`);
    traceEvent(runId, { service: "lead-service", event: "idempotency-hit", detail: `Returning cached response for runId=${runId}` }, req.headers).catch(() => {});
    return res.json(cached.response);
  }

  // In-flight guard: campaign-service is supposed to serialize workflow runs per campaignId.
  // If runs-service shows another lead-service run already in-flight for this campaignId,
  // the upstream serial invariant is broken — fail loud with full debug context instead of
  // racing the strategy persist path into a duplicate-key 500.
  // Must run BEFORE createRun so we don't self-detect.
  const concurrentCheck = await checkConcurrentBufferNext({
    orgId: req.orgId!,
    campaignId,
    attemptedParentRunId: runId,
    attemptedBrandIds: brandIds,
    attemptedWorkflowSlug: workflowSlug,
    attemptedFeatureSlug: req.featureSlug,
  });
  if (concurrentCheck.blocked) {
    console.error(`[lead-service] ${concurrentCheck.detail}`);
    traceEvent(runId, { service: "lead-service", event: "buffer-next-concurrent-rejected", level: "error", detail: concurrentCheck.detail }, req.headers).catch(() => {});
    return res.status(409).json({ error: "Concurrent buffer/next call for same campaign", detail: concurrentCheck.detail });
  }

  // Create child run for traceability (x-run-id from caller becomes our parentRunId)
  const childRun = await createRun({
    orgId: req.orgId!,
    serviceName: "lead-service",
    taskName: "lead-serve",
    parentRunId: runId,
    userId: req.userId,
    brandId: req.brandId,
    campaignId,
    workflowSlug,
    featureSlug: req.featureSlug,
  });
  const serveRunId = childRun.id;

  traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-start", detail: `campaignId=${campaignId}, brandIds=${brandIds.join(",")}` }, req.headers).catch(() => {});

  const pullSignal = AbortSignal.timeout(PULL_NEXT_TIMEOUT_MS);

  try {
    const result = await pullNext(
      {
        orgId: req.orgId!,
        campaignId,
        brandIds,
        parentRunId: runId,
        runId: serveRunId,
        userId: req.userId ?? null,
        workflowSlug,
        featureSlug: req.featureSlug,
      },
      pullSignal,
    );

    // Cache response keyed by caller's runId for idempotency.
    // campaign-service guarantees one workflow run per campaign at a time, so concurrent
    // requests with the same runId cannot happen — a duplicate-key error here is a real bug.
    if (Math.random() < 0.01) pruneExpiredIdempotencyCache();
    await db.insert(idempotencyCache).values({
      idempotencyKey: runId,
      orgId: req.orgId!,
      response: result,
    });

    traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-done", detail: `found=${result.found}`, data: { found: result.found } }, req.headers).catch(() => {});

    const runStatus = "completed";
    await updateRun(serveRunId, runStatus, runMeta);

    res.json(result);
  } catch (error) {
    console.error("[lead-service] buffer/next error:", error);
    traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-error", level: "error", detail: String(error) }, req.headers).catch(() => {});
    try {
      await updateRun(serveRunId, "failed", runMeta);
    } catch (runErr) {
      console.error("[lead-service] Failed to close run after error:", runErr);
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
