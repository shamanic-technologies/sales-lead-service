import { listRuns, type RunsListItem } from "./runs-client.js";

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

  if (runs.length === 0) {
    return { blocked: false };
  }

  const existing = runs[0];
  const startedAtMs = Date.parse(existing.startedAt);
  const elapsedMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : -1;
  const detail = [
    `Concurrent buffer/next call for orgId=${params.orgId} campaignId=${params.campaignId}.`,
    `campaign-service is supposed to serialize workflow runs per campaign — this is an upstream serial-invariant violation.`,
    `In-flight: id=${existing.id} parentRunId=${existing.parentRunId ?? "none"} startedAt=${existing.startedAt} elapsedMs=${elapsedMs} brandIds=${(existing.brandIds ?? []).join(",")} workflowSlug=${existing.workflowSlug ?? "none"} featureSlug=${existing.featureSlug ?? "none"}.`,
    `Rejected: parentRunId=${params.attemptedParentRunId} brandIds=${params.attemptedBrandIds.join(",")} workflowSlug=${params.attemptedWorkflowSlug ?? "none"} featureSlug=${params.attemptedFeatureSlug ?? "none"}.`,
    runs.length > 1 ? `(runs-service returned ${runs.length} in-flight runs — only the first is shown above.)` : "",
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  return { blocked: true, detail, existing };
}
