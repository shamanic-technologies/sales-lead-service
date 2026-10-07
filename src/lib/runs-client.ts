import { RUNS_SERVICE_URL, RUNS_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

// runs-service sits behind Neon scale-to-zero (DIS-153/155/157): idle compute
// suspends, and the first call after a suspend can land mid-wake — the resume
// takes ~1-7s and/or the socket is reset. 30s tolerates a slow resume (the
// fleet norm is 120-300s; the prior 5s was the outlier that a cold resume
// could not fit and 500'd on), and fetchWithRetry absorbs the connect-phase
// drops (ECONNRESET/ECONNREFUSED) — write-safe: those never reached the server.
const RUNS_SERVICE_TIMEOUT_MS = 30_000;

async function callRunsService(path: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Promise<unknown> {
  const { method = "GET", body, headers: extraHeaders } = options;

  const response = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": RUNS_SERVICE_API_KEY,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(RUNS_SERVICE_TIMEOUT_MS),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Runs service call failed: ${response.status} - ${error}`);
  }

  return response.json();
}

export async function createRun(params: {
  orgId: string;
  serviceName: string;
  taskName: string;
  parentRunId?: string;
  userId?: string;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  goal?: string;
  brandProfileId?: string;
  audienceId?: string;
}): Promise<{ id: string }> {
  const headers: Record<string, string> = {
    "x-org-id": params.orgId,
  };
  if (params.userId) headers["x-user-id"] = params.userId;
  if (params.parentRunId) headers["x-run-id"] = params.parentRunId;
  if (params.campaignId) headers["x-campaign-id"] = params.campaignId;
  if (params.brandId) headers["x-brand-id"] = params.brandId;
  if (params.workflowSlug) headers["x-workflow-slug"] = params.workflowSlug;
  if (params.featureSlug) headers["x-feature-slug"] = params.featureSlug;
  if (params.goal) headers["x-goal"] = params.goal;
  if (params.brandProfileId) headers["x-brand-profile-id"] = params.brandProfileId;
  if (params.audienceId) headers["x-audience-id"] = params.audienceId;

  return callRunsService("/runs", {
    method: "POST",
    body: {
      serviceName: params.serviceName,
      taskName: params.taskName,
      brandId: params.brandId,
      campaignId: params.campaignId,
      workflowSlug: params.workflowSlug,
    },
    headers,
  }) as Promise<{ id: string }>;
}

export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  context?: { orgId?: string; userId?: string; campaignId?: string; brandId?: string; workflowSlug?: string; featureSlug?: string; goal?: string; brandProfileId?: string; audienceId?: string }
): Promise<void> {
  const headers: Record<string, string> = {};
  if (context?.orgId) headers["x-org-id"] = context.orgId;
  if (context?.userId) headers["x-user-id"] = context.userId;
  headers["x-run-id"] = runId;
  if (context?.campaignId) headers["x-campaign-id"] = context.campaignId;
  if (context?.brandId) headers["x-brand-id"] = context.brandId;
  if (context?.workflowSlug) headers["x-workflow-slug"] = context.workflowSlug;
  if (context?.featureSlug) headers["x-feature-slug"] = context.featureSlug;
  if (context?.goal) headers["x-goal"] = context.goal;
  if (context?.brandProfileId) headers["x-brand-profile-id"] = context.brandProfileId;
  if (context?.audienceId) headers["x-audience-id"] = context.audienceId;

  await callRunsService(`/runs/${runId}`, {
    method: "PATCH",
    body: { status },
    headers,
  });
}

export interface RunsListItem {
  id: string;
  parentRunId: string | null;
  campaignId: string | null;
  startedAt: string;
  brandIds: string[] | null;
  workflowSlug: string | null;
  featureSlug: string | null;
}

export async function listRuns(params: {
  orgId: string;
  campaignId: string;
  serviceName: string;
  status: string;
  limit: number;
}): Promise<RunsListItem[]> {
  const query = new URLSearchParams({
    campaignId: params.campaignId,
    serviceName: params.serviceName,
    status: params.status,
    limit: String(params.limit),
  });
  const result = (await callRunsService(`/runs?${query.toString()}`, {
    method: "GET",
    headers: { "x-org-id": params.orgId },
  })) as { runs: RunsListItem[] };
  return result.runs;
}

export async function addCosts(
  runId: string,
  items: Array<{ costName: string; quantity: number; costSource: "platform" | "org" }>,
  context?: { orgId?: string; userId?: string; campaignId?: string; brandId?: string; workflowSlug?: string; featureSlug?: string; goal?: string; brandProfileId?: string; audienceId?: string }
): Promise<void> {
  if (items.length === 0) return;

  const headers: Record<string, string> = {};
  if (context?.orgId) headers["x-org-id"] = context.orgId;
  if (context?.userId) headers["x-user-id"] = context.userId;
  headers["x-run-id"] = runId;
  if (context?.campaignId) headers["x-campaign-id"] = context.campaignId;
  if (context?.brandId) headers["x-brand-id"] = context.brandId;
  if (context?.workflowSlug) headers["x-workflow-slug"] = context.workflowSlug;
  if (context?.featureSlug) headers["x-feature-slug"] = context.featureSlug;
  if (context?.goal) headers["x-goal"] = context.goal;
  if (context?.brandProfileId) headers["x-brand-profile-id"] = context.brandProfileId;
  if (context?.audienceId) headers["x-audience-id"] = context.audienceId;

  await callRunsService(`/runs/${runId}/costs`, {
    method: "POST",
    body: { items },
    headers,
  });
}

/** A run's total cost, its descendants included (runs-service sums recursively), in USD cents. */
export async function getRunTotalCents(runId: string, orgId: string): Promise<{ totalCents: number; actualCents: number }> {
  const run = (await callRunsService(`/runs/${runId}`, { method: "GET", headers: { "x-org-id": orgId } })) as {
    totalCostInUsdCents?: string;
    actualCostInUsdCents?: string;
  };
  return { totalCents: Number(run.totalCostInUsdCents ?? 0), actualCents: Number(run.actualCostInUsdCents ?? 0) };
}
