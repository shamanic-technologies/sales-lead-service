import { APOLLO_SERVICE_URL, APOLLO_SERVICE_API_KEY } from "../config.js";

async function callApolloService<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const { method = "GET", body, headers: extraHeaders } = options;

  const response = await fetch(`${APOLLO_SERVICE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": APOLLO_SERVICE_API_KEY,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apollo service call failed: ${response.status} - ${error}`);
  }

  return response.json() as Promise<T>;
}

export interface ApolloSearchParams {
  personTitles?: string[];
  organizationLocations?: string[];
  organizationIndustries?: string[];
  organizationNumEmployeesRanges?: string[];
  qOrganizationKeywordTags?: string[];
  qOrganizationIndustryTagIds?: string[];
  qKeywords?: string[];
  keywords?: string[];
  [key: string]: unknown;
}

export interface ApolloPhoneNumber {
  rawNumber?: string;
  sanitizedNumber?: string;
  type?: string;
  position?: number;
  status?: string;
  dncStatus?: string;
  dncOtherInfo?: string;
  dialerFlags?: Record<string, unknown>;
}

export interface ApolloPersonResult {
  id: string;
  email?: string;
  emailStatus?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  linkedinUrl?: string;
  // Person details
  photoUrl?: string;
  headline?: string;
  city?: string;
  state?: string;
  country?: string;
  seniority?: string;
  departments?: string[];
  subdepartments?: string[];
  functions?: string[];
  twitterUrl?: string;
  githubUrl?: string;
  facebookUrl?: string;
  personalEmails?: string[];
  mobilePhone?: string;
  phoneNumbers?: ApolloPhoneNumber[];
  employmentHistory?: Array<{
    title?: string;
    organizationName?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
    current?: boolean;
  }>;
  // Organization details
  organizationId?: string;
  organizationName?: string;
  organizationDomain?: string;
  organizationIndustry?: string;
  organizationSize?: string;
  organizationRawAddress?: string;
  organizationRevenueUsd?: string;
  organizationWebsiteUrl?: string;
  organizationLogoUrl?: string;
  organizationShortDescription?: string;
  organizationSeoDescription?: string;
  organizationLinkedinUrl?: string;
  organizationTwitterUrl?: string;
  organizationFacebookUrl?: string;
  organizationBlogUrl?: string;
  organizationCrunchbaseUrl?: string;
  organizationAngellistUrl?: string;
  organizationFoundedYear?: number;
  organizationPrimaryPhone?: string;
  organizationPubliclyTradedSymbol?: string;
  organizationPubliclyTradedExchange?: string;
  organizationAnnualRevenuePrinted?: string;
  organizationTotalFunding?: string;
  organizationTotalFundingPrinted?: string;
  organizationLatestFundingRoundDate?: string;
  organizationLatestFundingStage?: string;
  organizationFundingEvents?: Array<{
    id?: string;
    date?: string;
    type?: string;
    investors?: string;
    amount?: number;
    currency?: string;
  }>;
  organizationCity?: string;
  organizationState?: string;
  organizationCountry?: string;
  organizationStreetAddress?: string;
  organizationPostalCode?: string;
  organizationTechnologyNames?: string[];
  organizationCurrentTechnologies?: Array<{
    uid?: string;
    name?: string;
    category?: string;
  }>;
  organizationKeywords?: string[];
  organizationIndustries?: string[];
  organizationSecondaryIndustries?: string[];
  organizationNumSuborganizations?: number;
  organizationRetailLocationCount?: number;
  organizationAlexaRanking?: number;
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

// --- Fetch Page (server-managed pagination via apollo-service /search/next) ---

export interface ApolloFetchPageResult {
  people: ApolloPersonResult[];
  done: boolean;
  totalEntries: number;
}

export async function apolloFetchPage(options: {
  campaignId: string;
  brandId: string;
  searchParams?: ApolloSearchParams;
  runId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<ApolloFetchPageResult> {
  const headers: Record<string, string> = {};
  if (options.orgId) headers["x-org-id"] = options.orgId;
  if (options.userId) headers["x-user-id"] = options.userId;
  if (options.runId) headers["x-run-id"] = options.runId;
  headers["x-brand-id"] = options.brandId;
  headers["x-campaign-id"] = options.campaignId;
  if (options.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
  if (options.featureSlug) headers["x-feature-slug"] = options.featureSlug;

  const body: Record<string, unknown> = {};
  if (options.searchParams) body.searchParams = options.searchParams;

  return callApolloService<ApolloFetchPageResult>("/search/next", {
    method: "POST",
    body,
    headers,
  });
}

// --- Dry Run (probe filters without persistence — used by strategy-generator LLM loop) ---

export interface ApolloDryRunResult {
  totalEntries: number;
  validationErrors: string[];
}

export async function apolloDryRun(options: {
  filters: ApolloSearchParams;
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string;
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<ApolloDryRunResult> {
  const headers: Record<string, string> = { "x-org-id": options.orgId };
  if (options.userId) headers["x-user-id"] = options.userId;
  if (options.runId) headers["x-run-id"] = options.runId;
  if (options.brandId) headers["x-brand-id"] = options.brandId;
  if (options.campaignId) headers["x-campaign-id"] = options.campaignId;
  if (options.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
  if (options.featureSlug) headers["x-feature-slug"] = options.featureSlug;

  return callApolloService<ApolloDryRunResult>("/search/dry-run", {
    method: "POST",
    body: { filters: options.filters },
    headers,
  });
}

// --- Stats ---

export interface ApolloStats {
  enrichedLeadsCount: number;
  searchCount: number;
  fetchedPeopleCount: number;
  totalMatchingPeople: number;
}

export async function fetchApolloStats(
  filters: { runIds?: string[]; brandIds?: string[]; campaignId?: string },
  orgId?: string | null,
  context?: { userId?: string; runId?: string; campaignId?: string; brandId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloStats> {
  const headers: Record<string, string> = {};
  if (orgId) headers["x-org-id"] = orgId;
  if (context?.userId) headers["x-user-id"] = context.userId;
  if (context?.runId) headers["x-run-id"] = context.runId;
  if (context?.campaignId) headers["x-campaign-id"] = context.campaignId;
  if (context?.brandId) headers["x-brand-id"] = context.brandId;
  if (context?.workflowSlug) headers["x-workflow-slug"] = context.workflowSlug;
  if (context?.featureSlug) headers["x-feature-slug"] = context.featureSlug;

  const result = await callApolloService<{ stats: ApolloStats }>("/stats", {
    method: "POST",
    body: filters,
    headers,
  });
  return result.stats;
}

// --- Match (by name + organization domain) ---

export interface ApolloMatchResult {
  enrichmentId: string | null;
  person: ApolloPersonResult | null;
  cached: boolean;
}

export async function apolloMatch(
  params: { firstName: string; lastName: string; organizationDomain: string },
  options?: { runId?: string | null; orgId?: string | null; userId?: string | null; brandId?: string; campaignId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloMatchResult | null> {
  const headers: Record<string, string> = {};
  if (options?.orgId) headers["x-org-id"] = options.orgId;
  if (options?.userId) headers["x-user-id"] = options.userId;
  if (options?.runId) headers["x-run-id"] = options.runId;
  if (options?.brandId) headers["x-brand-id"] = options.brandId;
  if (options?.campaignId) headers["x-campaign-id"] = options.campaignId;
  if (options?.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
  if (options?.featureSlug) headers["x-feature-slug"] = options.featureSlug;

  return callApolloService<ApolloMatchResult>("/match", {
    method: "POST",
    body: {
      firstName: params.firstName,
      lastName: params.lastName,
      organizationDomain: params.organizationDomain,
    },
    headers,
  });
}

// --- Enrichment ---

export interface ApolloEnrichResult {
  person: ApolloPersonResult;
  cached: boolean;
}

export async function apolloEnrich(
  personId: string,
  options?: { runId?: string | null; orgId?: string | null; userId?: string | null; brandId?: string; campaignId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloEnrichResult | null> {
  const headers: Record<string, string> = {};
  if (options?.orgId) headers["x-org-id"] = options.orgId;
  if (options?.userId) headers["x-user-id"] = options.userId;
  if (options?.runId) headers["x-run-id"] = options.runId;
  if (options?.brandId) headers["x-brand-id"] = options.brandId;
  if (options?.campaignId) headers["x-campaign-id"] = options.campaignId;
  if (options?.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
  if (options?.featureSlug) headers["x-feature-slug"] = options.featureSlug;

  return callApolloService<ApolloEnrichResult>("/enrich", {
    method: "POST",
    body: { apolloPersonId: personId },
    headers,
  });
}
