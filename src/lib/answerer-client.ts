/**
 * WHO WILL ANSWER A PERSON WE OWE A FOLLOW-UP — asked of campaign-service, never worked out here.
 *
 * A scheduled follow-up sits on the `leads_campaigns` row of the campaign that reached the person,
 * and it is claimed only by a live campaign on the leg that continues from there whose predecessor
 * resolves to exactly that campaign (the claim is never widened to a family or a brand). Whether
 * such a campaign exists is a question about OTHER campaigns, which only campaign-service can
 * answer — `POST /internal/campaigns/answerers` is derived from the very predecessor resolver the
 * claim is keyed on, so the answer cannot disagree with the claim.
 *
 * Three answers, kept apart: somebody answers (`answeredBy`), nobody does and campaign-service
 * names why (`absence`), or the question could not be answered at all. The third is a failed read,
 * NEVER "answered" and NEVER "nobody" — an outage must not tell a customer their prospect is taken
 * care of, nor that nobody ever will be.
 */
import { CAMPAIGN_SERVICE_URL, CAMPAIGN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { SourceRead } from "./outreach-client.js";

export interface AnsweringCampaign {
  campaignId: string;
  legKey: string;
  status: string;
  featureSlug: string | null;
  acquisitionChannel: string | null;
  /** Null for a channel the customer operates: a person answers, no workflow claims. */
  workflowSlug: string | null;
}

/** One campaign's answer, exactly as campaign-service serves it. */
export type AnswererEntry =
  | {
      ok: true;
      campaignId: string;
      answeredBy: AnsweringCampaign | null;
      absence: string | null;
      startableFeatureSlugs: string[];
      candidate: AnsweringCampaign | null;
      candidateAnswersCampaignId: string | null;
    }
  | { ok: false; campaignId: string; status: number; reason: string; error: string };

const TIMEOUT_MS = 10_000;

/** campaign-service caps the batch at 200; a history read asks about a handful. */
export const MAX_ANSWERER_BATCH = 200;

export async function fetchAnswerers(
  campaignIds: string[],
): Promise<SourceRead<Map<string, AnswererEntry>>> {
  const ids = [...new Set(campaignIds)].slice(0, MAX_ANSWERER_BATCH);
  if (ids.length === 0) return { ok: true, data: new Map() };

  let response: Response;
  try {
    response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/internal/campaigns/answerers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": CAMPAIGN_SERVICE_API_KEY },
      body: JSON.stringify({ campaignIds: ids }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[answerer-client] campaign-service unreachable:", error);
    return { ok: false, reason: `campaign-service unreachable: ${(error as Error).message}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[answerer-client] campaign-service answered ${response.status}: ${body.slice(0, 300)}`);
    return {
      ok: false,
      reason: `campaign-service answered ${response.status} on /internal/campaigns/answerers`,
    };
  }

  let parsed: { campaigns?: AnswererEntry[] };
  try {
    parsed = (await response.json()) as { campaigns?: AnswererEntry[] };
  } catch (error) {
    return { ok: false, reason: `campaign-service answered an unreadable body: ${(error as Error).message}` };
  }
  if (!Array.isArray(parsed.campaigns)) {
    return { ok: false, reason: "campaign-service answered without a `campaigns` list" };
  }

  const byId = new Map<string, AnswererEntry>();
  for (const entry of parsed.campaigns) {
    if (entry && typeof entry.campaignId === "string") byId.set(entry.campaignId, entry);
  }
  return { ok: true, data: byId };
}
