import { HUMAN_SERVICE_URL, HUMAN_SERVICE_API_KEY } from "../config.js";
import { isCreditInsufficientError } from "./credit-errors.js";

/**
 * Client for human-service.
 *
 * lead-service no longer decides filters or provider. Each iteration it asks
 * features-service for the brand's most-relevant audience id, then asks
 * human-service to serve the next person of that audience via
 * POST /orgs/audiences/{id}/serve-next. human-service owns the audience's
 * canonical filters, provider routing (apollo OR apify), and dedup/suppression,
 * and returns one neutral Person already recorded as served — so the next call
 * returns someone new. lead-service just records the person and feeds it down.
 */

export type PeopleProvider = "apollo" | "apify";

export class PeopleServiceError extends Error {
  readonly status: number;
  readonly responseText: string;
  readonly body: unknown;

  constructor(status: number, responseText: string) {
    super(`People gateway call failed: ${status} - ${responseText}`);
    this.name = "PeopleServiceError";
    this.status = status;
    this.responseText = responseText;
    try {
      this.body = JSON.parse(responseText) as unknown;
    } catch {
      this.body = null;
    }
  }
}

export function isPeopleCreditInsufficientError(error: unknown): boolean {
  return isCreditInsufficientError(error);
}

// Neutral organization (gateway-locked, mirrors lead-service columns).
export interface PersonOrganization {
  name: string | null;
  domain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  estimatedNumEmployees: number | null;
  linkedinUrl: string | null;
  logoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

// Neutral Person (gateway-locked, mirrors FullLead). Slimmer than Apollo's raw
// firehose: single email (no personalEmails[]), no employment-history array,
// no funding/tech org detail. `provider` reports which provider human-service
// used to source the person (informational — NOT an input to lead-service).
export interface Person {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  headline: string | null;
  seniority: string | null;
  email: string | null;
  emailStatus: string | null;
  catchAll: boolean | null;
  inferred: boolean | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  provider: PeopleProvider;
  /** apollo person id (usable for a later enrich). null for apify. */
  providerPersonId: string | null;
  organization: PersonOrganization | null;
}

export interface ServiceContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  goal?: string;
  activeGoalId?: string;
  brandProfileId?: string;
  customerPersonaId?: string;
  audienceId?: string;
}

function buildHeaders(ctx: ServiceContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": HUMAN_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  if (ctx.campaignId) headers["x-campaign-id"] = ctx.campaignId;
  if (ctx.workflowSlug) headers["x-workflow-slug"] = ctx.workflowSlug;
  if (ctx.featureSlug) headers["x-feature-slug"] = ctx.featureSlug;
  if (ctx.goal) headers["x-goal"] = ctx.goal;
  if (ctx.activeGoalId) headers["x-active-goal-id"] = ctx.activeGoalId;
  if (ctx.brandProfileId) headers["x-brand-profile-id"] = ctx.brandProfileId;
  if (ctx.customerPersonaId) headers["x-customer-persona-id"] = ctx.customerPersonaId;
  if (ctx.audienceId) headers["x-audience-id"] = ctx.audienceId;
  return headers;
}

async function callHuman<T>(
  path: string,
  options: { method?: string; body?: unknown; ctx: ServiceContext },
): Promise<T> {
  const { method = "GET", body, ctx } = options;

  const response = await fetch(`${HUMAN_SERVICE_URL}${path}`, {
    method,
    headers: buildHeaders(ctx),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new PeopleServiceError(response.status, error);
  }

  return response.json() as Promise<T>;
}

// --- Serve Next (the next unserved person of an audience) ---
// human-service uses the audience's stored canonical filters + provider; the
// request body carries NO filters and NO provider. The returned person is
// already recorded as served, so the next call returns someone new.

export interface ServeNextResult {
  status: "served" | "exhausted";
  person: Person | null;
}

export async function serveNext(audienceId: string, ctx: ServiceContext): Promise<ServeNextResult> {
  return callHuman<ServeNextResult>(
    `/orgs/audiences/${encodeURIComponent(audienceId)}/serve-next`,
    { method: "POST", body: {}, ctx },
  );
}
