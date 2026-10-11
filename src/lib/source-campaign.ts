import {
  BILLING_SERVICE_API_KEY,
  BILLING_SERVICE_URL,
  CAMPAIGN_SERVICE_API_KEY,
  CAMPAIGN_SERVICE_URL,
  HUMAN_SERVICE_API_KEY,
  HUMAN_SERVICE_URL,
} from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { SOURCE_BUDGET_REACHED_REASON, SOURCE_CAMPAIGN_OFF_REASON } from "./serve-reasons.js";

/**
 * WHICH SOURCE CAMPAIGN A SERVE IS FILED UNDER (owner 2026-10-07: "the sources ARE campaigns").
 *
 * An offer's lead sources are campaigns of campaign-service, keyed (offer, featureSlug = <origin slug>,
 * legKey = "start_to_lead_found"):
 *     Solstice    [Apollo Cold Filters] -> Lead found              [On]   [Up to $42/day]
 *     Jubilation  Lead found -> Sales Cold Email -> Positive reply [On]   [Up to $65/day]
 * The outreach campaign's run asks for a lead (buffer/next); the lead is FOUND by the source campaign
 * of the audience's origin, so the serve run and everything bought under it carry that source
 * campaign's id (and the origin slug, src/lib/sourcing-origin.ts). The found lead itself stays the
 * outreach campaign's (leads_campaigns.campaign_id): the outreach campaign is what works it. One person
 * is contacted once whichever sources found them: human-service's per-brand suppression keys on the
 * person, never on a campaign.
 *
 * The rule, read from campaign-service `GET /internal/campaigns/{outreachId}/source-campaigns`:
 *   - the outreach channel sources nothing, or the offer has NO source campaign at all (its sources are
 *     not campaigns yet) -> `legacy`: today's serve, unchanged (the run keeps the outreach campaign).
 *   - the origin's source campaign is ON -> `source`, within ITS budget: billing's ceiling for
 *     (offer, start_to_lead_found, origin) against what that source campaign spent today. No ceiling
 *     stated -> nothing caps it here (the outreach campaign's gate still paces the run, as today).
 *   - else the offer's LEAD SOURCING campaign is ON (owner 2026-10-11: the sourcing channel that picks its
 *     origins; human-service decides which, per brand) and human-service CHOSE this origin for it ->
 *     `source` filed under the Lead Sourcing campaign, within ITS budget; the serve run carries
 *     `lead-sourcing` (the channel it is filed under), the origin stays readable off the audience.
 *   - the offer has source campaigns and this origin's is OFF or absent (and Lead Sourcing does not use it)
 *     -> refused, `source_campaign_off`: nothing is bought from a source the customer did not turn on.
 *
 * FAIL LOUD: a read that cannot be completed throws SourceCampaignUnresolvedError and the serve fails
 * (500) before anything is bought, never a serve filed under the wrong campaign.
 */

export const SOURCE_LEG_KEY = "start_to_lead_found" as const;

const CALL_TIMEOUT_MS = 10_000;

export class SourceCampaignUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCampaignUnresolvedError";
  }
}

/** The sourcing channel that picks its own origins (features-service `LEAD_SOURCING_CHANNEL`). */
export const LEAD_SOURCING_SLUG = "lead-sourcing";

export type ServeSource =
  | { kind: "legacy"; why: "channel_not_sourced" | "offer_not_on_source_campaigns" }
  /** `sourceSlug` = the channel of the source campaign the serve is filed under (the origin, or Lead Sourcing). */
  | { kind: "source"; campaignId: string; originSlug: string; sourceSlug: string; offerId: string }
  | {
      kind: "refused";
      reason: typeof SOURCE_CAMPAIGN_OFF_REASON | typeof SOURCE_BUDGET_REACHED_REASON;
      campaignId: string | null;
      detail: string;
    };

interface CampaignSourceCampaigns {
  offerId: string | null;
  sourced: boolean;
  sourceCampaigns: Array<{ featureSlug: string; campaignId: string; running: boolean }>;
}

function parseCampaignSources(body: unknown, where: string): CampaignSourceCampaigns {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || typeof b.sourced !== "boolean" || !Array.isArray(b.sourceCampaigns)) {
    throw new SourceCampaignUnresolvedError(`campaign-service source-campaigns answer unreadable (${where})`);
  }
  const sources = (b.sourceCampaigns as unknown[]).map((s) => {
    const r = s as Record<string, unknown>;
    if (typeof r.featureSlug !== "string" || typeof r.campaignId !== "string" || typeof r.running !== "boolean") {
      throw new SourceCampaignUnresolvedError(`campaign-service source campaign entry unreadable (${where})`);
    }
    return { featureSlug: r.featureSlug, campaignId: r.campaignId, running: r.running };
  });
  return { offerId: typeof b.offerId === "string" ? b.offerId : null, sourced: b.sourced, sourceCampaigns: sources };
}

async function fetchCampaignSources(outreachCampaignId: string, orgId: string): Promise<CampaignSourceCampaigns> {
  const url = `${CAMPAIGN_SERVICE_URL}/internal/campaigns/${encodeURIComponent(outreachCampaignId)}/source-campaigns`;
  const where = `campaign=${outreachCampaignId} org=${orgId}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SourceCampaignUnresolvedError(
      `campaign-service source-campaigns read failed (${where}): ${response.status} ${await response.text()}`,
    );
  }
  return parseCampaignSources(await response.json(), where);
}

/** Cents arrive as decimal strings (billing), sometimes numbers; null stays null. */
function cents(v: unknown, field: string, where: string): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new SourceCampaignUnresolvedError(`billing ${field} unreadable (${where}): ${String(v)}`);
  return n;
}

/**
 * The source campaign's daily ceiling and what it spent today. dailyBudgetCents null = billing
 * funds no ceiling for it (nothing caps it here).
 */
async function fetchSourceBudgetToday(args: {
  orgId: string;
  brandId: string;
  offerId: string;
  originSlug: string;
  sourceCampaignId: string;
}): Promise<{ dailyBudgetCents: number | null; spentCents: number }> {
  const query = new URLSearchParams({
    offerId: args.offerId,
    legKey: SOURCE_LEG_KEY,
    featureSlug: args.originSlug,
    campaignIds: args.sourceCampaignId,
  });
  const url = `${BILLING_SERVICE_URL}/internal/brands/${encodeURIComponent(args.brandId)}/campaign-budget?${query}`;
  const where = `source campaign=${args.sourceCampaignId} origin=${args.originSlug} offer=${args.offerId}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": BILLING_SERVICE_API_KEY, "x-org-id": args.orgId },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SourceCampaignUnresolvedError(`billing campaign-budget read failed (${where}): ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { dailyBudgetCents?: unknown; today?: { spentCents?: unknown } | null };
  const dailyBudgetCents = cents(body.dailyBudgetCents, "dailyBudgetCents", where);
  if (dailyBudgetCents === null) return { dailyBudgetCents: null, spentCents: 0 };
  const spentCents = cents(body.today?.spentCents, "today.spentCents", where);
  if (spentCents === null) throw new SourceCampaignUnresolvedError(`billing answered no spend for today (${where})`);
  return { dailyBudgetCents, spentCents };
}

/**
 * The origins human-service chose for the offer's Lead Sourcing campaign (`GET /orgs/lead-sourcing/sources`).
 * Fail loud: unreadable = SourceCampaignUnresolvedError (the serve fails before anything is bought).
 */
async function fetchLeadSourcingChoice(args: {
  orgId: string;
  brandId: string;
  offerId: string;
  userId?: string | null;
  runId?: string | null;
}): Promise<Set<string>> {
  const query = new URLSearchParams({ brandId: args.brandId, offerId: args.offerId });
  const url = `${HUMAN_SERVICE_URL}/orgs/lead-sourcing/sources?${query}`;
  const where = `brand=${args.brandId} offer=${args.offerId} org=${args.orgId}`;
  const headers: Record<string, string> = { "x-api-key": HUMAN_SERVICE_API_KEY, "x-org-id": args.orgId };
  if (args.userId) headers["x-user-id"] = args.userId;
  if (args.runId) headers["x-run-id"] = args.runId;
  const response = await fetchWithRetry(url, { headers, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (!response.ok) {
    throw new SourceCampaignUnresolvedError(`human-service lead-sourcing read failed (${where}): ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { chosenOriginSlugs?: unknown };
  if (!Array.isArray(body.chosenOriginSlugs) || body.chosenOriginSlugs.some((s) => typeof s !== "string")) {
    throw new SourceCampaignUnresolvedError(`human-service lead-sourcing answer unreadable (${where}): no chosenOriginSlugs`);
  }
  return new Set(body.chosenOriginSlugs as string[]);
}

/** Within the source campaign's own budget (billing), or why not. */
async function withinBudget(args: { orgId: string; brandId: string; offerId: string; sourceSlug: string; campaignId: string; originSlug: string }): Promise<ServeSource> {
  const budget = await fetchSourceBudgetToday({
    orgId: args.orgId,
    brandId: args.brandId,
    offerId: args.offerId,
    originSlug: args.sourceSlug,
    sourceCampaignId: args.campaignId,
  });
  if (budget.dailyBudgetCents !== null && budget.spentCents >= budget.dailyBudgetCents) {
    return {
      kind: "refused",
      reason: SOURCE_BUDGET_REACHED_REASON,
      campaignId: args.campaignId,
      detail: `source campaign ${args.campaignId} (${args.sourceSlug}) spent ${budget.spentCents}c of ${budget.dailyBudgetCents}c today`,
    };
  }
  return { kind: "source", campaignId: args.campaignId, originSlug: args.originSlug, sourceSlug: args.sourceSlug, offerId: args.offerId };
}

/**
 * The source campaign this serve is filed under, or why it may not serve. `originSlug` is the
 * audience's sourcing origin (null when the serve has none: no audience, or one serving from no list,
 * which buys nothing and stays `legacy`). `userId`/`runId` ride the Lead Sourcing read (human-service).
 */
export async function resolveServeSource(params: {
  orgId: string;
  brandId: string;
  outreachCampaignId: string;
  originSlug: string | null;
  userId?: string | null;
  runId?: string | null;
}): Promise<ServeSource> {
  if (!params.originSlug) return { kind: "legacy", why: "channel_not_sourced" };
  const read = await fetchCampaignSources(params.outreachCampaignId, params.orgId);
  if (!read.sourced || !read.offerId) return { kind: "legacy", why: "channel_not_sourced" };
  if (read.sourceCampaigns.length === 0) return { kind: "legacy", why: "offer_not_on_source_campaigns" };
  const offerId = read.offerId;

  const ofOrigin = read.sourceCampaigns.filter((s) => s.featureSlug === params.originSlug);
  const on = ofOrigin.find((s) => s.running);
  if (on) {
    return withinBudget({ orgId: params.orgId, brandId: params.brandId, offerId, sourceSlug: params.originSlug, campaignId: on.campaignId, originSlug: params.originSlug });
  }

  // LEAD SOURCING (owner 2026-10-11): its campaign is ON and human-service chose this origin for the brand.
  const leadSourcing = read.sourceCampaigns.find((s) => s.featureSlug === LEAD_SOURCING_SLUG && s.running);
  if (leadSourcing) {
    const chosen = await fetchLeadSourcingChoice({ orgId: params.orgId, brandId: params.brandId, offerId, userId: params.userId, runId: params.runId });
    if (chosen.has(params.originSlug)) {
      return withinBudget({ orgId: params.orgId, brandId: params.brandId, offerId, sourceSlug: LEAD_SOURCING_SLUG, campaignId: leadSourcing.campaignId, originSlug: params.originSlug });
    }
    return {
      kind: "refused",
      reason: SOURCE_CAMPAIGN_OFF_REASON,
      campaignId: leadSourcing.campaignId,
      detail: `lead sourcing campaign ${leadSourcing.campaignId} does not use ${params.originSlug} for this brand (it uses ${[...chosen].sort().join(", ") || "none"})`,
    };
  }

  return {
    kind: "refused",
    reason: SOURCE_CAMPAIGN_OFF_REASON,
    campaignId: ofOrigin[0]?.campaignId ?? null,
    detail: ofOrigin.length > 0 ? `source campaign ${ofOrigin[0].campaignId} (${params.originSlug}) is off` : `no ${params.originSlug} source campaign on this offer`,
  };
}
