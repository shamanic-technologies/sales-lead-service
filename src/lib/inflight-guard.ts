import { listRuns, updateRun, type RunsListItem } from "./runs-client.js";
import { PULL_NEXT_TIMEOUT_MS } from "../config.js";

/**
 * A genuine in-flight buffer/next cannot outlive PULL_NEXT_TIMEOUT_MS: the
 * request aborts (pullSignal) and the socket closes (server.setTimeout =
 * PULL_NEXT_TIMEOUT_MS + 5s) at that point, after which the handler's
 * updateRun(completed|failed) has run. A run still `running` past that window
 * + grace is an ORPHAN — left by a container restart / deploy / SIGKILL
 * mid-run, where no `finally` could fire. Such a run must NOT wedge the
 * campaign forever; we treat it as not-in-flight and clear it best-effort.
 */
const STALE_RUN_THRESHOLD_MS = PULL_NEXT_TIMEOUT_MS + 60_000;

/**
 * Detects concurrent buffer/next calls for the same campaignId by querying
 * runs-service for any other lead-service run currently in `running` state
 * for that campaign.
 *
 * campaign-service is supposed to serialize workflow runs per campaign, so
 * lead-service should never see two concurrent buffer/next requests for the
 * same campaignId. When this returns blocked=true, treat it as evidence of
 * an upstream serial-invariant violation — investigate campaign-service /
 * workflow-service, not lead-service.
 *
 * Best-effort detection: there is a small TOCTOU window between this query
 * and the caller's subsequent createRun. The race is acceptable because the
 * actual upstream bug surfaces as runs minutes apart, not millisecond races.
 */

export interface CheckConcurrentParams {
  orgId: string;
  campaignId: string;
  attemptedParentRunId: string;
  attemptedBrandIds: string[];
  attemptedWorkflowSlug?: string;
  attemptedFeatureSlug?: string;
}

export type ConcurrentCheckResult =
  | { blocked: false }
  | { blocked: true; detail: string; existing: RunsListItem };

export async function checkConcurrentBufferNext(
  params: CheckConcurrentParams,
): Promise<ConcurrentCheckResult> {
  const runs = await listRuns({
    orgId: params.orgId,
    campaignId: params.campaignId,
    serviceName: "lead-service",
    status: "running",
    limit: 2,
  });

  const now = Date.now();

  // Drop orphaned runs (running past the abort+grace window) so they stop
  // wedging the campaign, and clear them best-effort. A run with an
  // unparseable startedAt cannot be proven stale → treat as fresh (fail safe
  // toward the existing block behavior, never toward a silent unblock).
  const fresh: RunsListItem[] = [];
  for (const run of runs) {
    const runStartedAtMs = Date.parse(run.startedAt);
    const runElapsedMs = Number.isFinite(runStartedAtMs) ? now - runStartedAtMs : -1;
    if (runElapsedMs > STALE_RUN_THRESHOLD_MS) {
      console.warn(
        `[lead-service] Clearing orphaned in-flight buffer/next run id=${run.id} campaignId=${params.campaignId} elapsedMs=${runElapsedMs} (exceeds ${STALE_RUN_THRESHOLD_MS}ms — left by a crash/deploy/timeout mid-run, not a live request).`,
      );
      updateRun(run.id, "failed", { orgId: params.orgId, campaignId: params.campaignId }).catch((err) => {
        console.error(`[lead-service] Failed to clear orphaned in-flight run id=${run.id}:`, err);
      });
      continue;
    }
    fresh.push(run);
  }

  if (fresh.length === 0) {
    return { blocked: false };
  }

  const existing = fresh[0];
  const startedAtMs = Date.parse(existing.startedAt);
  const elapsedMs = Number.isFinite(startedAtMs) ? now - startedAtMs : -1;
  const detail = [
    `Concurrent buffer/next call for orgId=${params.orgId} campaignId=${params.campaignId}.`,
    `campaign-service is supposed to serialize workflow runs per campaign — this is an upstream serial-invariant violation.`,
    `In-flight: id=${existing.id} parentRunId=${existing.parentRunId ?? "none"} startedAt=${existing.startedAt} elapsedMs=${elapsedMs} brandIds=${(existing.brandIds ?? []).join(",")} workflowSlug=${existing.workflowSlug ?? "none"} featureSlug=${existing.featureSlug ?? "none"}.`,
    `Rejected: parentRunId=${params.attemptedParentRunId} brandIds=${params.attemptedBrandIds.join(",")} workflowSlug=${params.attemptedWorkflowSlug ?? "none"} featureSlug=${params.attemptedFeatureSlug ?? "none"}.`,
    fresh.length > 1 ? `(runs-service returned ${fresh.length} fresh in-flight runs — only the first is shown above.)` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  return { blocked: true, detail, existing };
}
