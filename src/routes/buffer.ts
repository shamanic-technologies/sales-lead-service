import { Router } from "express";
import { eq, lt } from "drizzle-orm";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, requireRunId } from "../middleware/auth.js";
import { pullNext, type PullNextMode } from "../lib/buffer.js";
import { createRun, updateRun } from "../lib/runs-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { BufferNextRequestSchema } from "../schemas.js";
import { db } from "../db/index.js";
import { idempotencyCache } from "../db/schema.js";
import { PULL_NEXT_TIMEOUT_MS } from "../config.js";
import { checkConcurrentBufferNext } from "../lib/inflight-guard.js";
import { CREDIT_INSUFFICIENT_REASON, isCreditInsufficientError } from "../lib/credit-errors.js";
import { AUDIENCE_NOT_SERVEABLE_REASON, isAudienceNotServeableError } from "../lib/people-client.js";
import { OriginNotFedError, resolveSourcingOriginSlug } from "../lib/sourcing-origin.js";
import { channelReachableBy } from "../lib/channel-reach.js";
import type { ReachMethod } from "../lib/people-client.js";
import { ORIGIN_NOT_FED_REASON, type ServeEmptyReason } from "../lib/serve-reasons.js";
import { resolveServeSource, withinBudget, type ServeSource } from "../lib/source-campaign.js";
import { decideSourceMode, type SourceUnit } from "../lib/source-mode.js";
import { resolveSourceAudiences } from "../lib/source-audiences.js";
import { SOURCE_CAMPAIGN_OFF_REASON, TARGETED_AUDIENCES_UNAVAILABLE_REASON } from "../lib/serve-reasons.js";
import { recordLeadRequested, type LeadRequestedPerformed } from "../lib/lead-requested-events.js";
import { openOnDemandRun, type OnDemandRun } from "../lib/on-demand-run.js";

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

  // The source unit's OWN run (src/lib/on-demand-run.ts): opened for a serve filed under a source campaign, the
  // serve run hangs from it and carries its workflow. Null for a legacy serve (no source unit to run).
  let onDemandRun: OnDemandRun | null = null;

  // LEADS-ONLY-FUNNEL-CAMPAIGN (src/lib/source-mode.ts): a source unit's OWN run finds and stores a lead under itself
  // (`ownRunUnit`, its audiences in `findAudienceIds`); an outreach campaign fed by sources that find on their own
  // serves their stock (`stockSourceIds`). Neither is an on-demand ask: neither records an `on_demand` event.
  let ownRunUnit: SourceUnit | null = null;
  let findAudienceIds: string[] = [];
  let stockSourceIds: string[] | null = null;

  // WHO this pipe can reach (src/lib/channel-reach.ts): the outreach channel's contact methods, passed on every serve.
  let reachableBy: ReachMethod[] | null = null;
  // The named audience may not be served for this pipe (its origin does not feed the channel): no FRESH serve, the
  // campaign's own pools still drain (src/lib/buffer.ts).
  let freshServeRefused: { reason: ServeEmptyReason; detail: string } | null = null;

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

    reachableBy = await channelReachableBy(featureSlug);

    const sourceMode = await decideSourceMode({ orgId: req.orgId!, campaignId, featureSlug });

    if (sourceMode.kind === "own_run") {
      // The source unit's OWN run: within its own budget, in its own audiences, filed under itself.
      const unit = sourceMode.unit;
      ownRunUnit = unit;
      runFeatureSlug = unit.featureSlug;
      if (unit.status !== "ongoing") {
        serveSource = { kind: "refused", reason: SOURCE_CAMPAIGN_OFF_REASON, campaignId: unit.id, detail: `source campaign ${unit.id} (${unit.featureSlug}) is ${unit.status}` };
      } else {
        const budget = await withinBudget({
          orgId: req.orgId!,
          brandId: unit.brandId,
          offerId: unit.offerId,
          sourceSlug: unit.featureSlug,
          campaignId: unit.id,
          originSlug: unit.featureSlug,
        });
        if (budget.kind === "refused") serveSource = budget;
        else {
          const found = await resolveSourceAudiences({
            orgId: req.orgId!,
            brandId: unit.brandId,
            offerId: unit.offerId,
            unitSlug: unit.featureSlug,
            preferredAudienceId: req.audienceId ?? null,
            targetAudienceIds: unit.audienceIds,
            userId: req.userId ?? null,
            runId,
          });
          // The campaign's targeting is a hard subset: none of its audiences walkable = nobody looked for, said why.
          if (found.kind === "targets_unavailable") {
            serveSource = { kind: "refused", reason: TARGETED_AUDIENCES_UNAVAILABLE_REASON, campaignId: unit.id, detail: found.detail };
          } else findAudienceIds = found.audienceIds;
        }
      }
    } else {
      const sourcesRead = sourceMode.read;
      if (req.audienceId) {
        try {
          const origin = await resolveSourcingOriginSlug({
            audienceId: req.audienceId,
            orgId: req.orgId!,
            outreachFeatureSlug: featureSlug,
          });
          if (origin) runFeatureSlug = origin;
        } catch (err) {
          if (err instanceof OriginNotFedError) {
            // A source that does not feed this pipe: nobody is served from it here, never "keeping the label".
            console.error(`[lead-service] buffer/next origin_not_fed campaign=${campaignId} ${err.message}`);
            freshServeRefused = { reason: ORIGIN_NOT_FED_REASON, detail: err.message };
          } else {
            console.error(
              `[lead-service] buffer/next sourcing origin unresolved runId=${runId} campaignId=${campaignId} audienceId=${req.audienceId} outreachFeatureSlug=${featureSlug}:`,
              err,
            );
            throw err;
          }
        }
      }

      if (runFeatureSlug !== featureSlug) {
        try {
          serveSource = await resolveServeSource({
            orgId: req.orgId!,
            brandId,
            outreachCampaignId: campaignId,
            originSlug: runFeatureSlug,
            userId: req.userId ?? null,
            runId,
            ...(sourcesRead ? { read: sourcesRead } : {}),
          });
          // The run carries the slug of the source campaign it is filed under: the origin, or Lead Sourcing
          // (whose serves keep their origin on the audience they served from).
          if (serveSource.kind === "source") runFeatureSlug = serveSource.sourceSlug;
        } catch (err) {
          console.error(
            `[lead-service] buffer/next source campaign unresolved runId=${runId} campaignId=${campaignId} origin=${runFeatureSlug}:`,
            err,
          );
          throw err;
        }
      }

      if (sourceMode.kind === "stock") {
        // Sources of this offer find on their own: serve their stock, never find on demand from them. The one
        // exception is an audience whose origin resolves to a source that still answers on demand (the switch is
        // per source): that serve is today's, byte for byte.
        const onDemandSource = serveSource.kind === "source" && !sourceMode.sourceCampaignIds.includes(serveSource.campaignId);
        if (!onDemandSource) {
          stockSourceIds = sourceMode.sourceCampaignIds;
          serveSource = { kind: "legacy", why: "offer_not_on_source_campaigns" };
          runFeatureSlug = featureSlug;
        }
      }
    }

    // A serve under a source unit is that unit answering its `on_demand` trigger: its own run, opened now.
    if (serveSource.kind === "source") {
      onDemandRun = await openOnDemandRun({
        orgId: req.orgId!,
        userId: req.userId,
        callerRunId: runId,
        campaignId: serveSource.campaignId,
        audienceId: req.audienceId,
      });
    }

    // The serve run: under the source unit's own run when there is one, else under the caller's run (legacy).
    const childRun = await createRun({
      orgId: req.orgId!,
      serviceName: "lead-service",
      taskName: "lead-serve",
      parentRunId: onDemandRun?.runId ?? runId,
      userId: req.userId,
      brandId: req.brandId,
      campaignId: serveSource.kind === "source" ? serveSource.campaignId : campaignId,
      workflowSlug: onDemandRun?.workflowSlug ?? workflowSlug,
      featureSlug: runFeatureSlug,
      goal: req.goal,
      brandProfileId: req.brandProfileId,
      audienceId: req.audienceId,
    });
    serveRunId = childRun.id;
  } catch (err) {
    console.error(`[lead-service] buffer/next pre-serve setup failed for runId=${runId} campaignId=${campaignId}:`, err);
    if (onDemandRun) {
      const opened = onDemandRun;
      updateRun(opened.runId, "failed", { orgId: req.orgId, userId: req.userId, campaignId: opened.campaignId, brandId: req.brandId, workflowSlug: opened.workflowSlug, featureSlug: opened.featureSlug }).catch((closeErr) =>
        console.error(`[lead-service] on-demand run ${opened.runId} of unit ${opened.campaignId} not closed after a failed setup:`, closeErr),
      );
    }
    traceEvent(runId, { service: "lead-service", event: "buffer-next-setup-failed", level: "error", detail: err instanceof Error ? err.message : String(err) }, req.headers).catch(() => {});
    return res.status(500).json({ error: "Lead serve setup failed", detail: err instanceof Error ? err.message : String(err) });
  }

  // The campaign the serve RUN (and every call under it) is filed under: the ON source campaign, else
  // the outreach campaign as before.
  const runCampaignId = serveSource.kind === "source" ? serveSource.campaignId : campaignId;
  // Everything bought under the serve carries the source unit's workflow (its pipe's), never the asking run's.
  const runWorkflowSlug = onDemandRun?.workflowSlug ?? workflowSlug;
  const runMeta = {
    orgId: req.orgId,
    userId: req.userId,
    campaignId: runCampaignId,
    brandId: req.brandId,
    workflowSlug: runWorkflowSlug,
    featureSlug: runFeatureSlug,
    goal: req.goal,
    brandProfileId: req.brandProfileId,
    audienceId: req.audienceId,
  };

  // The source unit's run ends with its serve, same status. Never throws: the serve's answer stands.
  const closeOnDemand = async (status: "completed" | "failed") => {
    if (!onDemandRun) return;
    try {
      await updateRun(onDemandRun.runId, status, { ...runMeta, featureSlug: onDemandRun.featureSlug });
    } catch (err) {
      console.error(`[lead-service] on-demand run ${onDemandRun.runId} of unit ${onDemandRun.campaignId} not closed (${status}):`, err);
    }
  };

  // Every answered ask is recorded as ONE `on_demand` trigger event at campaign-service
  // (src/lib/lead-requested-events.ts). Never awaited: recording can neither slow nor fail the serve.
  const recordAsk = (performed: LeadRequestedPerformed, leadId: string | null = null) =>
    ownRunUnit || stockSourceIds
      ? undefined
      : recordLeadRequested({
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
      await closeOnDemand("completed");
    } catch (err) {
      console.error(`[lead-service] buffer/next failed to close a refused serve runId=${runId}:`, err);
      try {
        await updateRun(serveRunId, "failed", runMeta);
        await closeOnDemand("failed");
      } catch (runErr) {
        console.error("[lead-service] Failed to close run after refused-serve error:", runErr);
      }
      return res.status(500).json({ error: "Internal server error" });
    }
    recordAsk({ outcome: "skipped", reason: refused.reason, detail: refused.detail });
    return res.json(result);
  }

  const pullSignal = AbortSignal.timeout(PULL_NEXT_TIMEOUT_MS);
  const pullMode: PullNextMode | null = ownRunUnit
    ? { kind: "find", audienceIds: findAudienceIds }
    : stockSourceIds
      ? { kind: "stock", sourceCampaignIds: stockSourceIds }
      : null;

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
        workflowSlug: runWorkflowSlug,
        activeGoalId: req.activeGoalId ?? null,
        brandProfileId: req.brandProfileId ?? null,
        audienceId: req.audienceId ?? null,
        ...(pullMode ? { mode: pullMode } : {}),
        ...(reachableBy ? { reachableBy } : {}),
        ...(parsed.data.acceptedEmails ? { acceptedEmails: parsed.data.acceptedEmails } : {}),
        ...(freshServeRefused ? { freshServeRefused } : {}),
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
    await closeOnDemand(runStatus);

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
        await closeOnDemand("completed");
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
        await closeOnDemand("completed");
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
      await closeOnDemand("failed");
    } catch (runErr) {
      console.error("[lead-service] Failed to close run after error:", runErr);
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
