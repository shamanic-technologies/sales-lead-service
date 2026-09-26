/**
 * WHICH leg each campaign of an org works — campaign-service's `legKey`, read and never inferred.
 *
 * A campaign is (offer x leg x channel), and campaign-service owns the leg on the campaign row. It is
 * never guessed from the channel, the workflow, a sibling campaign or anything the campaign used to
 * be keyed on: a campaign that states no leg is exactly that, and the caller says so.
 *
 * NO SILENT FALLBACK. campaign-service unreachable is `CampaignLegsUnavailableError`, never an empty
 * map a caller would read as "no campaign states a leg".
 */
import { CAMPAIGN_SERVICE_URL, CAMPAIGN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export class CampaignLegsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignLegsUnavailableError";
  }
}

export interface CampaignLegContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

/** Every campaign of one org and the leg it states (null = states none) — one read. */
export async function fetchOrgCampaignLegs(ctx: CampaignLegContext): Promise<Map<string, string | null>> {
  const headers: Record<string, string> = {
    "X-API-Key": CAMPAIGN_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  let response: Response;
  try {
    response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new CampaignLegsUnavailableError(
      `[campaign-leg-client] campaign-service unreachable for org ${ctx.orgId}: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new CampaignLegsUnavailableError(
      `[campaign-leg-client] campaign-service /campaigns failed (${response.status}): ${body}`,
    );
  }
  const data = (await response.json()) as {
    campaigns?: Array<{ id?: string; legKey?: string | null }>;
  };
  if (!Array.isArray(data.campaigns)) {
    throw new CampaignLegsUnavailableError(
      "[campaign-leg-client] campaign-service /campaigns returned no campaigns array",
    );
  }
  const byId = new Map<string, string | null>();
  for (const row of data.campaigns) {
    if (!row?.id) continue;
    byId.set(row.id, typeof row.legKey === "string" && row.legKey.length > 0 ? row.legKey : null);
  }
  return byId;
}
