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
import { CREDIT_INSUFFICIENT_REASON, isCreditInsufficientError } from "../lib/credit-errors.js";
import { AUDIENCE_NOT_SERVEABLE_REASON, isAudienceNotServeableError } from "../lib/people-client.js";
import { resolveSourcingOriginSlug } from "../lib/sourcing-origin.js";
import { resolveServeSource, type ServeSource } from "../lib/source-campaign.js";
import { recordLeadRequested, type LeadRequestedPerformed } from "../lib/lead-requested-events.js";

const router = Router();

/**
 * Outreach campaigns with a buffer/next in flight IN THIS PROCESS. The runs-service guard below finds
 * a concurrent serve by its run's campaign, and a serve filed under a SOURCE campaign
 * (src/lib/source-campaign.ts) no longer carries the outreach campaign's id on its run, so the same
 * serial invariant is also held here, keyed on the outreach campaign.
 */
const inFlightOutreach = new Set<string>();

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

  // The audience is resolved per (brand, feature) from features-service; the goal
  // is the brand's own (brands.currentGoal), fetched from brand-service inside
  // pullNext — NOT a caller input. So x-feature-slug is required; x-goal is not.
  const featureSlug = req.featureSlug;
  if (!featureSlug) {
    return res.status(400).json({ error: "x-feature-slug header required" });
  }
  // Audiences are per-brand; resolve against the primary (first) brand id.
  const brandId = brandIds[0];

  const workflowSlug = req.workflowSlug;
  const runId = req.runId as string;

  // The serve run and everything bought under it is SOURCING: it carries the audience's sourcing
  // origin slug (src/lib/sourcing-origin.ts), resolved below. The outreach slug (`featureSlug`) stays
  // on the lead row only. The run keeps the outreach slug when there is nothing to relabel: no
  // audience (no_audience) or one serving from no list (audience_not_serveable) buys nothing, and an
  // origin the channel's spend reads do not count is logged as an error and left where they count it.
  let runFeatureSlug: string = featureSlug;

  // The SOURCE campaign the serve is filed under (src/lib/source-campaign.ts): once the offer's lead
  // sources are campaigns, the serve run and every downstream call carry the ON source campaign's id
  // (the lead row keeps the outreach campaign that works it). `legacy` = today's serve, unchanged.
  let serveSource: ServeSource = { kind: "legacy", why: "channel_not_sourced" };

  // The idempotency lookup, in-flight guard, and child-run creation all run
  // BEFORE the main pullNext try/catch below. A throw here (e.g. runs-service
  // unreachable through its Neon cold-start window) must return a clean 500 —
  // NOT escape the async handler as an unhandled rejection, which leaves the
  // caller's socket hanging with no response. fetchWithRetry already absorbs
  // transient connect-phase drops; this catch handles a genuine outage.
  let serveRunId: string;
  try {
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
    if (inFlightOutreach.has(campaignId)) {
      const detail = `Concurrent buffer/next call for orgId=${req.orgId} campaignId=${campaignId} (in flight in this process). campaign-service is supposed to serialize workflow runs per campaign — this is an upstream serial-invariant violation. Rejected: parentRunId=${runId}.`;
      console.error(`[lead-service] ${detail}`);
      traceEvent(runId, { service: "lead-service", event: "buffer-next-concurrent-rejected", level: "error", detail }, req.headers).catch(() => {});
      return res.status(409).json({ error: "Concurrent buffer/next call for same campaign", detail });
    }
    inFlightOutreach.add(campaignId);
    res.on("close", () => inFlightOutreach.delete(campaignId));

    if (req.audienceId) {
      try {
        const origin = await resolveSourcingOriginSlug({
          audienceId: req.audienceId,
          orgId: req.orgId!,
          outreachFeatureSlug: featureSlug,
        });
        if (origin) runFeatureSlug = origin;
      } catch (err) {
        console.error(
          `[lead-service] buffer/next sourcing origin unresolved runId=${runId} campaignId=${campaignId} audienceId=${req.audienceId} outreachFeatureSlug=${featureSlug}:`,
          err,
        );
        throw err;
      }
    }

    if (runFeatureSlug !== featureSlug) {
      try {
        serveSource = await resolveServeSource({
          orgId: req.orgId!,
          brandId,
          outreachCampaignId: campaignId,
          originSlug: runFeatureSlug,
        });
      } catch (err) {
        console.error(
          `[lead-service] buffer/next source campaign unresolved runId=${runId} campaignId=${campaignId} origin=${runFeatureSlug}:`,
          err,
        );
        throw err;
      }
    }

    // Create child run for traceability (x-run-id from caller becomes our parentRunId)
    const childRun = await createRun({
      orgId: req.orgId!,
      serviceName: "lead-service",
      taskName: "lead-serve",
      parentRunId: runId,
      userId: req.userId,
      brandId: req.brandId,
      campaignId: serveSource.kind === "source" ? serveSource.campaignId : campaignId,
      workflowSlug,
      featureSlug: runFeatureSlug,
      goal: req.goal,
      brandProfileId: req.brandProfileId,
      audienceId: req.audienceId,
    });
    serveRunId = childRun.id;
  } catch (err) {
    console.error(`[lead-service] buffer/next pre-serve setup failed for runId=${runId} campaignId=${campaignId}:`, err);
    traceEvent(runId, { service: "lead-service", event: "buffer-next-setup-failed", level: "error", detail: err instanceof Error ? err.message : String(err) }, req.headers).catch(() => {});
    return res.status(500).json({ error: "Lead serve setup failed", detail: err instanceof Error ? err.message : String(err) });
  }

  // The campaign the serve RUN (and every call under it) is filed under: the ON source campaign, else
  // the outreach campaign as before.
  const runCampaignId = serveSource.kind === "source" ? serveSource.campaignId : campaignId;
  const runMeta = {
    orgId: req.orgId,
    userId: req.userId,
    campaignId: runCampaignId,
    brandId: req.brandId,
    workflowSlug,
    featureSlug: runFeatureSlug,
    goal: req.goal,
    brandProfileId: req.brandProfileId,
    audienceId: req.audienceId,
  };

  // Every answered ask is recorded as ONE `lead_requested` trigger event at campaign-service
  // (src/lib/lead-requested-events.ts). Never awaited: recording can neither slow nor fail the serve.
  const recordAsk = (performed: LeadRequestedPerformed, leadId: string | null = null) =>
    recordLeadRequested({
      orgId: req.orgId!,
      brandId,
      offerId: serveSource.kind === "source" ? serveSource.offerId : null,
      requestedByCampaignId: campaignId,
      callerRunId: runId,
      leadId,
      occurredAt: new Date().toISOString(),
      performed,
    });

  traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-start", detail: `campaignId=${campaignId}, brandIds=${brandIds.join(",")}, source=${serveSource.kind === "source" ? serveSource.campaignId : serveSource.kind}` }, req.headers).catch(() => {});

  // The audience's origin is a source campaign that is OFF, or over its daily budget: nothing is
  // bought, the empty answer names why (never exhaustion).
  if (serveSource.kind === "refused") {
    const refused = serveSource;
    console.log(
      `[lead-service] buffer/next found=false reason=${refused.reason} campaign=${campaignId} audience=${req.audienceId ?? "-"} origin=${runFeatureSlug}: ${refused.detail}`,
    );
    const result = { found: false, reason: refused.reason };
    try {
      await db.insert(idempotencyCache).values({ idempotencyKey: runId, orgId: req.orgId!, response: result });
      traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-done", detail: `found=false reason=${refused.reason}`, data: { found: false, reason: refused.reason, detail: refused.detail } }, req.headers).catch(() => {});
      await updateRun(serveRunId, "completed", runMeta);
    } catch (err) {
      console.error(`[lead-service] buffer/next failed to close a refused serve runId=${runId}:`, err);
      try {
        await updateRun(serveRunId, "failed", runMeta);
      } catch (runErr) {
        console.error("[lead-service] Failed to close run after refused-serve error:", runErr);
      }
      return res.status(500).json({ error: "Internal server error" });
    }
    recordAsk({ outcome: "skipped", reason: refused.reason, detail: refused.detail });
    return res.json(result);
  }

  const pullSignal = AbortSignal.timeout(PULL_NEXT_TIMEOUT_MS);

  try {
    const result = await pullNext(
      {
        orgId: req.orgId!,
        campaignId,
        brandIds,
        brandId,
        featureSlug,
        runFeatureSlug,
        runCampaignId,
        parentRunId: runId,
        runId: serveRunId,
        userId: req.userId ?? null,
        workflowSlug,
        activeGoalId: req.activeGoalId ?? null,
        brandProfileId: req.brandProfileId ?? null,
        audienceId: req.audienceId ?? null,
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

    // The reason rides the trace too: a run tree that only recorded found=false cannot
    // tell an exhausted audience from a run that was never given one to look at.
    traceEvent(
      serveRunId,
      {
        service: "lead-service",
        event: "buffer-next-done",
        detail: result.found ? "found=true" : `found=false reason=${result.reason}`,
        data: { found: result.found, reason: result.reason ?? null },
      },
      req.headers,
    ).catch(() => {});

    const runStatus = "completed";
    await updateRun(serveRunId, runStatus, runMeta);

    if (result.found) recordAsk({ outcome: "ran", campaignId: runCampaignId }, result.lead?.leadId ?? null);
    else recordAsk({ outcome: "skipped", reason: result.reason ?? "reason_unstated" });

    res.json(result);
  } catch (error) {
    if (isCreditInsufficientError(error)) {
      console.log(`[lead-service] buffer/next found=false reason=credit_insufficient campaign=${campaignId}`);
      const result = { found: false, reason: CREDIT_INSUFFICIENT_REASON };
      traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-credit-insufficient", detail: `campaignId=${campaignId}` }, req.headers).catch(() => {});
      try {
        await updateRun(serveRunId, "completed", runMeta);
      } catch (runErr) {
        console.error("[lead-service] Failed to close run after credit-insufficient response:", runErr);
      }
      recordAsk({ outcome: "skipped", reason: CREDIT_INSUFFICIENT_REASON });
      return res.json(result);
    }

    if (isAudienceNotServeableError(error)) {
      // The campaign-selected audience has no committed provider — a clean "no
      // lead this run", not a server error. (Audience lifecycle is fixed in
      // human-service; this prevents a stray uncommitted audience from looping
      // the workflow on 500s.)
      console.warn(`[lead-service] buffer/next found=false reason=audience_not_serveable campaign=${campaignId}`);
      const result = { found: false, reason: AUDIENCE_NOT_SERVEABLE_REASON };
      traceEvent(serveRunId, { service: "lead-service", event: "buffer-next-audience-not-serveable", detail: `campaignId=${campaignId}` }, req.headers).catch(() => {});
      try {
        await updateRun(serveRunId, "completed", runMeta);
      } catch (runErr) {
        console.error("[lead-service] Failed to close run after audience-not-serveable response:", runErr);
      }
      recordAsk({ outcome: "skipped", reason: AUDIENCE_NOT_SERVEABLE_REASON });
      return res.json(result);
    }

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
