import { HUMAN_SERVICE_URL, HUMAN_SERVICE_API_KEY } from "../config.js";
import { isCreditInsufficientError } from "./credit-errors.js";

/**
 * Client for the human-service people gateway (POST /orgs/people/*).
 *
 * The gateway is provider-agnostic: it routes to apollo-service (rich search +
 * enrich) OR apify-service (verified-email waterfall) and normalizes both into
 * one neutral Person shape. lead-service no longer talks to apollo/apify directly.
 *
 * Routing: explicit `provider` wins; else `need:"verified_email"` -> apify; else apollo.
 * Pagination: apollo uses a server-managed cursor (nextPage:true advances it, keyed
 * by org + x-campaign-id); apify uses client-managed offset/nextOffset.
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

// Neutral filter shape (gateway-locked). Field names are provider-agnostic; the
// gateway maps them to each provider's native vocabulary. Some fields are honored
// by only one provider (documented per-field in the gateway OpenAPI).
export interface PeopleFilters {
  titles?: string[];
  seniorities?: string[];
  functions?: string[];
  locationCountries?: string[];
  locationStates?: string[];
  locationCities?: string[];
  companyNames?: string[];
  companyDomains?: string[];
  industries?: string[];
  keywords?: string[];
  employeeMin?: number;
  employeeMax?: number;
  companySizes?: string[];
  revenueRanges?: string[];
  fundingStages?: string[];
  technologies?: string[];
  [key: string]: unknown;
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
// no funding/tech org detail.
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

interface ServiceContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
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
  return headers;
}

async function callGateway<T>(
  path: string,
  options: { method?: string; body?: unknown; ctx: ServiceContext; query?: Record<string, string> },
): Promise<T> {
  const { method = "GET", body, ctx, query } = options;
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";

  const response = await fetch(`${HUMAN_SERVICE_URL}${path}${qs}`, {
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

// --- Filters Prompt (provider-specific LLM filter-shape doc) ---

export interface FiltersPrompt {
  provider: PeopleProvider;
  prompt: string;
  schemaVersion: string;
}

export async function fetchFiltersPrompt(opts: {
  provider: PeopleProvider;
  orgId: string;
  userId?: string | null;
}): Promise<FiltersPrompt> {
  return callGateway<FiltersPrompt>("/orgs/people/filters-prompt", {
    ctx: { orgId: opts.orgId, userId: opts.userId },
    query: { provider: opts.provider },
  });
}

// --- Search (one page of normalized people) ---

export interface PeopleSearchResult {
  provider: PeopleProvider;
  people: Person[];
  done: boolean;
  total: number;
  nextOffset: number | null;
}

export async function peopleSearch(options: {
  provider: PeopleProvider;
  /** First page (apollo) / every page (apify): the neutral filter set. */
  filters?: PeopleFilters;
  /** apollo only: advance the server-managed cursor for the next page. */
  nextPage?: boolean;
  /** apify only: pagination offset (pass back nextOffset from the prior page). */
  offset?: number;
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId: string;
  campaignId: string;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<PeopleSearchResult> {
  const body: Record<string, unknown> = { provider: options.provider };
  if (options.filters) body.filters = options.filters;
  if (options.nextPage) body.nextPage = true;
  if (options.offset !== undefined) body.offset = options.offset;

  return callGateway<PeopleSearchResult>("/orgs/people/search", {
    method: "POST",
    body,
    ctx: {
      orgId: options.orgId,
      userId: options.userId,
      runId: options.runId,
      brandId: options.brandId,
      campaignId: options.campaignId,
      workflowSlug: options.workflowSlug,
      featureSlug: options.featureSlug,
    },
  });
}

// --- Dry Run (count matches without consuming credits) ---

export interface PeopleDryRunResult {
  provider: PeopleProvider;
  totalEntries: number;
}

export async function peopleDryRun(options: {
  provider: PeopleProvider;
  filters: PeopleFilters;
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<PeopleDryRunResult> {
  return callGateway<PeopleDryRunResult>("/orgs/people/search/dry-run", {
    method: "POST",
    body: { provider: options.provider, filters: options.filters },
    ctx: {
      orgId: options.orgId,
      userId: options.userId,
      runId: options.runId,
      brandId: options.brandId,
      campaignId: options.campaignId,
      workflowSlug: options.workflowSlug,
      featureSlug: options.featureSlug,
    },
  });
}

// --- Resolve Email (reveal a verified email for a known person) ---
// Replaces the old apollo enrich-by-personId path: the gateway has no
// enrich-by-id endpoint, so we resolve by name + organization domain.

export interface ResolveEmailResult {
  provider: PeopleProvider;
  person: Person | null;
}

export async function resolveEmail(options: {
  provider: PeopleProvider;
  firstName: string;
  lastName: string;
  domain: string;
  includeInferred?: boolean;
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<ResolveEmailResult> {
  const body: Record<string, unknown> = {
    provider: options.provider,
    firstName: options.firstName,
    lastName: options.lastName,
    domain: options.domain,
  };
  if (options.includeInferred !== undefined) body.includeInferred = options.includeInferred;

  return callGateway<ResolveEmailResult>("/orgs/people/resolve-email", {
    method: "POST",
    body,
    ctx: {
      orgId: options.orgId,
      userId: options.userId,
      runId: options.runId,
      brandId: options.brandId,
      campaignId: options.campaignId,
      workflowSlug: options.workflowSlug,
      featureSlug: options.featureSlug,
    },
  });
}
