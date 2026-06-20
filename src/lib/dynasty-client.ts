import {
  FEATURES_SERVICE_URL,
  FEATURES_SERVICE_API_KEY,
  WORKFLOW_SERVICE_URL,
  WORKFLOW_SERVICE_API_KEY,
} from "../config.js";

interface FeatureDynastyEntry {
  dynastySlug: string;
  slugs: string[];
}

interface WorkflowDynastyEntry {
  workflowDynastySlug: string;
  workflowSlugs: string[];
}

function buildHeaders(
  apiKey: string,
  context?: {
    orgId?: string;
    userId?: string;
    runId?: string;
    goal?: string;
    activeGoalId?: string;
    brandProfileId?: string;
    customerPersonaId?: string;
    audienceId?: string;
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };
  if (context?.orgId) headers["x-org-id"] = context.orgId;
  if (context?.userId) headers["x-user-id"] = context.userId;
  if (context?.runId) headers["x-run-id"] = context.runId;
  if (context?.goal) headers["x-goal"] = context.goal;
  if (context?.activeGoalId) headers["x-active-goal-id"] = context.activeGoalId;
  if (context?.brandProfileId) headers["x-brand-profile-id"] = context.brandProfileId;
  if (context?.customerPersonaId) headers["x-customer-persona-id"] = context.customerPersonaId;
  if (context?.audienceId) headers["x-audience-id"] = context.audienceId;
  return headers;
}

/**
 * Resolve a feature dynasty slug to its list of versioned slugs.
 * Returns empty array if resolution fails or dynasty doesn't exist.
 */
export async function resolveFeatureDynastySlugs(
  dynastySlug: string,
  context?: Parameters<typeof buildHeaders>[1],
): Promise<string[]> {
  try {
    const url = `${FEATURES_SERVICE_URL}/features/dynasty/slugs?dynastySlug=${encodeURIComponent(dynastySlug)}`;
    const response = await fetch(url, {
      headers: buildHeaders(FEATURES_SERVICE_API_KEY, context),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      console.warn(`[lead-service] Failed to resolve feature dynasty slug ${dynastySlug}: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as { slugs: string[] };
    return data.slugs ?? [];
  } catch (error) {
    console.error("[lead-service] Error resolving feature dynasty slug:", error);
    return [];
  }
}

/**
 * Resolve a workflow dynasty slug to its list of versioned slugs.
 * Returns empty array if resolution fails or dynasty doesn't exist.
 */
export async function resolveWorkflowDynastySlugs(
  dynastySlug: string,
  context?: Parameters<typeof buildHeaders>[1],
): Promise<string[]> {
  try {
    const url = `${WORKFLOW_SERVICE_URL}/workflows/dynasty/slugs?workflowDynastySlug=${encodeURIComponent(dynastySlug)}`;
    const response = await fetch(url, {
      headers: buildHeaders(WORKFLOW_SERVICE_API_KEY, context),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      console.warn(`[lead-service] Failed to resolve workflow dynasty slug ${dynastySlug}: ${response.status}`);
      return [];
    }
    const data = (await response.json()) as { workflowSlugs: string[] };
    return data.workflowSlugs ?? [];
  } catch (error) {
    console.error("[lead-service] Error resolving workflow dynasty slug:", error);
    return [];
  }
}

/**
 * Fetch all feature dynasties and build a reverse map: slug → dynastySlug.
 */
export async function fetchFeatureDynastyMap(
  context?: Parameters<typeof buildHeaders>[1],
): Promise<Map<string, string>> {
  try {
    const url = `${FEATURES_SERVICE_URL}/features/dynasties`;
    const response = await fetch(url, {
      headers: buildHeaders(FEATURES_SERVICE_API_KEY, context),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      console.warn(`[lead-service] Failed to fetch feature dynasties: ${response.status}`);
      return new Map();
    }
    const data = (await response.json()) as { dynasties: FeatureDynastyEntry[] };
    return buildFeatureSlugToDynastyMap(data.dynasties ?? []);
  } catch (error) {
    console.error("[lead-service] Error fetching feature dynasties:", error);
    return new Map();
  }
}

/**
 * Fetch all workflow dynasties and build a reverse map: slug → dynastySlug.
 */
export async function fetchWorkflowDynastyMap(
  context?: Parameters<typeof buildHeaders>[1],
): Promise<Map<string, string>> {
  try {
    const url = `${WORKFLOW_SERVICE_URL}/workflows/dynasties`;
    const response = await fetch(url, {
      headers: buildHeaders(WORKFLOW_SERVICE_API_KEY, context),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      console.warn(`[lead-service] Failed to fetch workflow dynasties: ${response.status}`);
      return new Map();
    }
    const data = (await response.json()) as { dynasties: WorkflowDynastyEntry[] };
    return buildWorkflowSlugToDynastyMap(data.dynasties ?? []);
  } catch (error) {
    console.error("[lead-service] Error fetching workflow dynasties:", error);
    return new Map();
  }
}

function buildFeatureSlugToDynastyMap(
  dynasties: FeatureDynastyEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.slugs) {
      map.set(slug, d.dynastySlug);
    }
  }
  return map;
}

function buildWorkflowSlugToDynastyMap(
  dynasties: WorkflowDynastyEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of dynasties) {
    for (const slug of d.workflowSlugs) {
      map.set(slug, d.workflowDynastySlug);
    }
  }
  return map;
}
