import { HUMAN_SERVICE_URL, HUMAN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Client for human-service's internal bulk audience resolver (#166 / #346).
 *
 * The dashboard Leads page must show each lead's ACTIVE audience for a brand.
 * Resolving that in the browser meant POSTing every brand lead email in one
 * request to human-service `/orgs/audiences/stats` (~7,685 emails ≈ 230KB for a
 * single brand) → past the gateway's 100KB body cap → 413 → blank column. The
 * fix carries the audience ON the lead, resolved server-to-server here.
 *
 * lead-service owns only ~5% of `leads_campaigns.audience_id` tags; historical
 * leads resolve by EMAIL → active-audience membership. Both keys are sent to
 * human-service, which owns the brand-correct pick (audience.brandId +
 * status + membership) and the deprecated→canonical audience mapping. This
 * client is a bulk transport: it sends the brand's distinct audienceIds + emails
 * and returns the two lookup maps human-service produces.
 *
 * Fail-loud: a non-2xx resolver response or a network failure throws. The
 * `GET /orgs/leads` handler resolves the audience BEFORE writing each chunk, so
 * a resolver failure surfaces as a clean 500 (pre-stream) or a destroyed socket
 * (mid-stream) — never a silently-blank "-" that masks the outage (AC4).
 */

// Deployed wire contract (lead-service ↔ human-service, server-to-server, direct
// to HUMAN_SERVICE_URL — NOT via the api-service gateway; the resolver mounts its
// own 25MB parser BEFORE human-service's global 100KB json parser, so no body cap):
//
//   POST {HUMAN_SERVICE_URL}/internal/audiences/resolve
//   Headers: X-API-Key: <internal>   (requireApiKey; orgId travels in the body)
//   Body:    { "orgId": "<uuid>", "brandId": "<uuid>",
//              "audienceIds"?: string[],   // tagged audience_ids on the leads (~5%)
//              "emails"?: string[] }        // lead emails — HISTORICAL key (raw; normalized server-side)
//            (at least one of audienceIds / emails must be non-empty)
//   200:     { "byAudienceId": { "<audienceId>": Card|null },
//              "byEmail":       { "<rawEmail>":  Card|null } }
//   Card = { id, name, avatarUrl: string|null }. Only this brand's active audiences
//   are ever returned (brand-correct); a non-matching / retired key resolves to null.
export interface AudienceCard {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface AudienceResolveContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
}

export interface AudienceResolveResult {
  byAudienceId: Record<string, AudienceCard | null>;
  byEmail: Record<string, AudienceCard | null>;
}

export class AudienceServiceError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(`Audience resolver call failed: ${status} - ${responseText}`);
    this.name = "AudienceServiceError";
    this.status = status;
    this.responseText = responseText;
  }
}

function buildHeaders(ctx: AudienceResolveContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": HUMAN_SERVICE_API_KEY,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  return headers;
}

const EMPTY: AudienceResolveResult = { byAudienceId: {}, byEmail: {} };

/**
 * Resolve, for a single brand, the active-audience card behind each distinct
 * tagged audienceId and/or lead email. Returns human-service's two lookup maps
 * ({ byAudienceId, byEmail }); the caller correlates them back onto each lead.
 * A call with no keys short-circuits (the resolver 400s on an empty request).
 * Throws on any resolver / network failure (fail-loud).
 */
export async function resolveAudiencesForBrand(
  brandId: string,
  keys: { audienceIds: string[]; emails: string[] },
  ctx: AudienceResolveContext,
): Promise<AudienceResolveResult> {
  if (keys.audienceIds.length === 0 && keys.emails.length === 0) return EMPTY;

  const response = await fetchWithRetry(`${HUMAN_SERVICE_URL}/internal/audiences/resolve`, {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify({
      orgId: ctx.orgId,
      brandId,
      audienceIds: keys.audienceIds,
      emails: keys.emails,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new AudienceServiceError(response.status, await response.text());
  }

  const parsed = (await response.json()) as Partial<AudienceResolveResult>;
  return {
    byAudienceId: parsed.byAudienceId ?? {},
    byEmail: parsed.byEmail ?? {},
  };
}
