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

/** Reason returned to the caller when the resolved audience cannot be served. */
export { AUDIENCE_NOT_SERVEABLE_REASON } from "./serve-reasons.js";

/**
 * True when serve-next refused because the audience has no committed provider.
 * human-service returns 422 `{ error: "Audience has no committed provider ..." }`
 * when the campaign-selected audience was never counted/committed. That is a
 * clean terminal "no lead right now" state for this run — NOT a 500. The
 * audience-lifecycle fix lives in human-service; this classifier keeps a stray
 * uncommitted audience from crash-looping the workflow.
 */
export function isAudienceNotServeableError(error: unknown): boolean {
  if (!(error instanceof PeopleServiceError)) return false;
  if (error.status !== 422) return false;
  const body = error.body as { error?: unknown } | null;
  const message = typeof body?.error === "string" ? body.error : error.responseText;
  return message.toLowerCase().includes("committed provider");
}

/**
 * One funding event as the provider reports it. Carried verbatim onto
 * `organizations.funding_events`; nothing here is parsed or recomputed.
 */
export interface PersonFundingEvent {
  id?: string | null;
  date?: string | null;
  type?: string | null;
  investors?: string | null;
  amount?: number | null;
  currency?: string | null;
  news_url?: string | null;
  newsUrl?: string | null;
}

/**
 * Neutral organization (gateway-owned, mirrors lead-service's own
 * `OrganizationView` field names).
 *
 * The eleven fields at the top have always been served. Everything below them is
 * OPTIONAL on the wire: human-service widened the neutral shape to stop dropping
 * what apollo-service already holds (short/seo description, keywords, technology
 * names, industry lists, funding, founded year, addresses, social urls), and a
 * producer that serves none of it still produces a valid person. Absent stays
 * absent — `pickOrgFields` writes only what actually arrived, and lead-service
 * NEVER derives, infers or defaults any of these. The producer owns the values.
 */
export interface PersonOrganization {
  name: string | null;
  domain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  estimatedNumEmployees: number | null;
  annualRevenue: number | null;
  linkedinUrl: string | null;
  logoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;

  // --- Widened surface (all optional; absent under an older producer) ---
  providerOrganizationId?: string | null;
  shortDescription?: string | null;
  seoDescription?: string | null;
  keywords?: string[] | null;
  technologyNames?: string[] | null;
  industries?: string[] | null;
  secondaryIndustries?: string[] | null;
  latestFundingStage?: string | null;
  latestFundingRoundDate?: string | null;
  totalFunding?: number | string | null;
  totalFundingPrinted?: string | null;
  fundingEvents?: PersonFundingEvent[] | null;
  foundedYear?: number | null;
  twitterUrl?: string | null;
  facebookUrl?: string | null;
  blogUrl?: string | null;
  crunchbaseUrl?: string | null;
  angellistUrl?: string | null;
  streetAddress?: string | null;
  postalCode?: string | null;
  primaryPhone?: string | null;
  publiclyTradedSymbol?: string | null;
  publiclyTradedExchange?: string | null;
  numSuborganizations?: number | null;
  retailLocationCount?: number | null;
  alexaRanking?: number | null;
}

/**
 * One role from the person's career history, as the producer reports it.
 *
 * A past employer is known by NAME only — the provider carries no domain for it —
 * so lead-service keys those organization rows on the name. `current` marks the
 * role the person holds now; the top-level `organization` is that same employer,
 * and is the richer of the two (it carries the domain and every widened field).
 */
export interface PersonEmployment {
  organizationName?: string | null;
  title?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  current?: boolean | null;
  description?: string | null;
}

// Neutral Person (gateway-owned, mirrors FullLead). Still slimmer than Apollo's
// raw firehose (single email, no personalEmails[]), but no longer slim on the
// ORGANIZATION or the CAREER HISTORY: both are carried through and persisted.
// `provider` reports which provider human-service used to source the person
// (informational — NOT an input to lead-service).
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
  /**
   * Recipient's IANA timezone (e.g. "America/New_York"), resolved upstream from
   * the person's location. Forwarded onto the lead so the send funnel
   * (email-gateway-service → instantly-service) can schedule cold email in the
   * recipient's local business hours. null when upstream provides none.
   */
  timezone: string | null;
  /**
   * Language(s) this person plausibly conducts business in, as ISO 639-1 codes
   * ("de", "fr", "it"), ORDERED most-plausible-first. Produced by human-service,
   * which owns the derivation; we carry it and never re-derive it. An EMPTY array
   * means the producer had no usable signal — deliberately NOT a guess, and
   * distinct from ["en"] (= known to be English).
   */
  businessLanguages: string[];
  provider: PeopleProvider;
  /** apollo person id (usable for a later enrich). null for apify. */
  providerPersonId: string | null;
  organization: PersonOrganization | null;
  /**
   * Every role the provider returned for this person, current and past, in the
   * order the producer served them. OPTIONAL: absent (or empty) under a producer
   * that serves no career history, in which case the top-level `organization`
   * remains the only employment we can record. Never synthesized here.
   */
  employmentHistory?: PersonEmployment[] | null;
  /**
   * The buying signal this person's audience matched (human-service `BuyingSignal`),
   * or null. OPTIONAL: absent under a producer that does not serve it. Read through
   * `readBuyingSignal` (src/lib/buying-signal.ts) — never trusted raw, never derived.
   */
  buyingSignal?: unknown;
  /**
   * The human-service person this is (its `people.id`), when the producer states
   * one. OPTIONAL: absent under a producer that does not serve it. Read through
   * `readServedPersonId` (src/lib/served-person-id.ts), never derived.
   */
  personId?: unknown;
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
