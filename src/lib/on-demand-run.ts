import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * A SOURCING PIPE RUNS AS ITS OWN RUN, ONLY WHEN ASKED (owner 2026-10-11: "ça ne changera rien si le pipe a un trigger
 * de type 'on demand' -> only exécuté quand par ex le pipe cold email l'appelle").
 *
 * A serve filed under a source campaign (source-campaign.ts) is that source unit answering its `on_demand` trigger:
 * the cold email run asked for a lead. Before the serve, campaign-service opens the unit's OWN run
 * (`POST /internal/on-demand-runs`: a root `campaign-service`/<unit id> run carrying the unit's campaign, brand,
 * channel and workflow); the `lead-serve` run and everything bought under it hang from that run and carry the unit's
 * workflow, so the sourcing spend is the sourcing pipe's own (own run id, campaign, workflow), never the cold email
 * workflow's. When the lead is found does not move: same ask, same instant. The serve closes the run.
 *
 * Fail loud: a run that cannot be opened fails the serve setup (500, the caller's retry is the ask), never a serve
 * whose cost lands on no run of the unit.
 */
export interface OnDemandRun {
  runId: string;
  campaignId: string;
  featureSlug: string;
  workflowSlug: string;
  brandIds: string[];
}

const CALL_TIMEOUT_MS = 10_000;

export async function openOnDemandRun(input: {
  orgId: string;
  userId: string | undefined;
  /** The asking (cold email) run, `x-run-id` of the serve. */
  callerRunId: string;
  /** The source unit answering. */
  campaignId: string;
  audienceId?: string | null;
}): Promise<OnDemandRun> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": CAMPAIGN_SERVICE_API_KEY,
    "x-org-id": input.orgId,
    "x-run-id": input.callerRunId,
  };
  if (input.userId) headers["x-user-id"] = input.userId;
  const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/internal/on-demand-runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ campaignId: input.campaignId, ...(input.audienceId ? { audienceId: input.audienceId } : {}) }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `campaign-service refused to open the on-demand run of source unit ${input.campaignId} (${response.status}): ${(await response.text()).slice(0, 500)}`,
    );
  }
  const body = (await response.json()) as Partial<OnDemandRun>;
  if (typeof body.runId !== "string" || typeof body.workflowSlug !== "string" || typeof body.featureSlug !== "string") {
    throw new Error(`campaign-service opened the on-demand run of ${input.campaignId} with an unreadable answer: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return {
    runId: body.runId,
    campaignId: body.campaignId ?? input.campaignId,
    featureSlug: body.featureSlug,
    workflowSlug: body.workflowSlug,
    brandIds: body.brandIds ?? [],
  };
}
