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
  organizationSizeRanges?: string[];
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
  // Verbatim Apollo person payload (snake_case, includes any field Apollo returns)
  raw?: Record<string, unknown>;
  // Allow any additional fields Apollo adds in the future
  [key: string]: unknown;
}

export interface ApolloSearchResult {
  people: ApolloPersonResult[];
  pagination: {
    page: number;
    totalPages: number;
    totalEntries: number;
  };
}

interface ApolloSearchRawResponse {
  people?: ApolloPersonResult[];
  pagination?: ApolloSearchResult["pagination"];
  total_entries?: number;
  totalEntries?: number;
  per_page?: number;
  perPage?: number;
  [key: string]: unknown;
}

export async function apolloSearch(
  params: ApolloSearchParams,
  page: number = 1,
  options?: { runId?: string | null; orgId?: string | null; userId?: string | null; brandId?: string; campaignId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloSearchResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (options?.orgId) headers["x-org-id"] = options.orgId;
    if (options?.userId) headers["x-user-id"] = options.userId;
    if (options?.runId) headers["x-run-id"] = options.runId;
    if (options?.brandId) headers["x-brand-id"] = options.brandId;
    if (options?.campaignId) headers["x-campaign-id"] = options.campaignId;
    if (options?.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
    if (options?.featureSlug) headers["x-feature-slug"] = options.featureSlug;

    const raw = await callApolloService<ApolloSearchRawResponse>("/search", {
      method: "POST",
      body: {
        ...params,
        page,
      },
      headers,
    });

    const people = raw.people ?? [];
    const pagination = raw.pagination ?? {
      page,
      totalEntries: raw.total_entries ?? raw.totalEntries ?? 0,
      totalPages: Math.ceil((raw.total_entries ?? raw.totalEntries ?? 0) / (raw.per_page ?? raw.perPage ?? 25)),
    };

    const result: ApolloSearchResult = { people, pagination };
    return result;
  } catch (error) {
    console.error("[apollo-client] Search failed:", error);
    throw error;
  }
}

// --- Search Next (server-managed pagination) ---

export interface ApolloSearchNextResult {
  people: ApolloPersonResult[];
  done: boolean;
  totalEntries: number;
}

export async function apolloSearchNext(options: {
  campaignId: string;
  brandId: string;
  searchParams?: ApolloSearchParams;
  runId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<ApolloSearchNextResult | null> {
  try {
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

    return await callApolloService<ApolloSearchNextResult>("/search/next", {
      method: "POST",
      body,
      headers,
    });
  } catch (error) {
    console.error("[apollo-client] SearchNext failed:", error);
    throw error;
  }
}

// --- Search Params (LLM-powered search filter generation) ---

export interface ApolloSearchParamsResult {
  searchParams: ApolloSearchParams;
  totalResults: number;
  attempts: number;
}

export async function apolloSearchParams(options: {
  context: string;
  runId: string;
  brandId: string;
  campaignId: string;
  orgId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<ApolloSearchParamsResult> {
  const headers: Record<string, string> = {};
  if (options.orgId) headers["x-org-id"] = options.orgId;
  if (options.userId) headers["x-user-id"] = options.userId;
  headers["x-run-id"] = options.runId;
  headers["x-brand-id"] = options.brandId;
  headers["x-campaign-id"] = options.campaignId;
  if (options.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
  if (options.featureSlug) headers["x-feature-slug"] = options.featureSlug;

  return callApolloService<ApolloSearchParamsResult>("/search/params", {
    method: "POST",
    body: {
      context: options.context,
    },
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
  filters: { runIds?: string[]; brandId?: string; campaignId?: string },
  orgId?: string | null,
  context?: { userId?: string; runId?: string; campaignId?: string; brandId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloStats> {
  try {
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
  } catch (error) {
    console.error("[apollo-client] Stats fetch failed:", error);
    return { enrichedLeadsCount: 0, searchCount: 0, fetchedPeopleCount: 0, totalMatchingPeople: 0 };
  }
}

// --- Enrichment ---

export interface ApolloEnrichResult {
  person: ApolloPersonResult;
}

// --- Person Match (by name + organization domain) ---

export interface ApolloMatchResult {
  enrichmentId: string | null;
  person: ApolloPersonResult | null;
  cached: boolean;
}

export async function apolloMatch(
  params: { firstName: string; lastName: string; organizationDomain: string },
  options?: { runId?: string | null; orgId?: string | null; userId?: string | null; brandId?: string; campaignId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloMatchResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (options?.orgId) headers["x-org-id"] = options.orgId;
    if (options?.userId) headers["x-user-id"] = options.userId;
    if (options?.runId) headers["x-run-id"] = options.runId;
    if (options?.brandId) headers["x-brand-id"] = options.brandId;
    if (options?.campaignId) headers["x-campaign-id"] = options.campaignId;
    if (options?.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
    if (options?.featureSlug) headers["x-feature-slug"] = options.featureSlug;

    return await callApolloService<ApolloMatchResult>("/match", {
      method: "POST",
      body: {
        firstName: params.firstName,
        lastName: params.lastName,
        organizationDomain: params.organizationDomain,
      },
      headers,
    });
  } catch (error) {
    console.error(`[apollo-client] Match failed for ${params.firstName} ${params.lastName} @ ${params.organizationDomain}:`, error);
    throw error;
  }
}

// --- Enrichment ---

export async function apolloEnrich(
  personId: string,
  options?: { runId?: string | null; orgId?: string | null; userId?: string | null; brandId?: string; campaignId?: string; workflowSlug?: string; featureSlug?: string }
): Promise<ApolloEnrichResult | null> {
  try {
    const headers: Record<string, string> = {};
    if (options?.orgId) headers["x-org-id"] = options.orgId;
    if (options?.userId) headers["x-user-id"] = options.userId;
    if (options?.runId) headers["x-run-id"] = options.runId;
    if (options?.brandId) headers["x-brand-id"] = options.brandId;
    if (options?.campaignId) headers["x-campaign-id"] = options.campaignId;
    if (options?.workflowSlug) headers["x-workflow-slug"] = options.workflowSlug;
    if (options?.featureSlug) headers["x-feature-slug"] = options.featureSlug;

    const result = await callApolloService<ApolloEnrichResult>("/enrich", {
      method: "POST",
      body: {
        apolloPersonId: personId,
      },
      headers,
    });

    return result;
  } catch (error) {
    console.error(`[apollo-client] Enrich failed for personId=${personId}:`, error);
    throw error;
  }
}
