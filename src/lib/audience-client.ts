import { HUMAN_SERVICE_URL, HUMAN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Client for human-service's server-to-server audience resolver.
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
 * status='active' + membership) and the deterministic tie-break. This client is
 * purely a bulk transport: it batches the identity set, calls the resolver, and
 * returns a leadId → { id, name, avatarUrl } map. leadIds with no active
 * audience for the brand are simply absent from the map (⟹ null on the lead).
 *
 * Fail-loud: a non-2xx resolver response or a network failure throws. The
 * `GET /orgs/leads` handler resolves the audience BEFORE writing each chunk, so
 * a resolver failure surfaces as a clean 500 (pre-stream) or a destroyed socket
 * (mid-stream) — never a silently-blank "-" that masks the outage (AC4).
 */

// Locked wire contract (lead-service ↔ human-service, server-to-server, direct
// to HUMAN_SERVICE_URL — NOT via the api-service gateway, so no 100KB body cap):
//
//   POST {HUMAN_SERVICE_URL}/orgs/audiences/resolve
//   Headers: X-API-Key: <internal>, x-org-id: <orgId>
//   Body:    { "brandId": "<uuid>",
//              "leads": [ { "leadId": "<opaque string>",
//                           "email": "<string|null>",
//                           "audienceId": "<uuid|null>" } ] }   // lead-service batches ≤ RESOLVE_BATCH_SIZE
//   200:     { "audiences": { "<leadId>": { "id","name","avatarUrl": string|null } } }
//            (a leadId is present only when it maps to an ACTIVE audience for brandId;
//             absent ⟹ the lead has no active audience for the brand ⟹ null.)
export interface AudienceCard {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface AudienceResolveLead {
  leadId: string;
  email: string | null;
  audienceId: string | null;
}

export interface AudienceResolveContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
}

interface ResolveResponse {
  audiences: Record<string, AudienceCard>;
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

// One brand's identity set per call. A single leads chunk (LEADS_STREAM_CHUNK_SIZE,
// default 500) stays well under this, but keep the batch bounded so a large chunk
// or a future bigger chunk size never sends an unbounded body / query to a
// Neon-backed sibling.
const RESOLVE_BATCH_SIZE = Math.max(1, Number(process.env.AUDIENCE_RESOLVE_BATCH_SIZE) || 1000);

function buildHeaders(ctx: AudienceResolveContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": HUMAN_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  return headers;
}

async function resolveBatch(
  brandId: string,
  leads: AudienceResolveLead[],
  ctx: AudienceResolveContext,
): Promise<Record<string, AudienceCard>> {
  const response = await fetchWithRetry(`${HUMAN_SERVICE_URL}/orgs/audiences/resolve`, {
    method: "POST",
    headers: buildHeaders(ctx),
    body: JSON.stringify({ brandId, leads }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new AudienceServiceError(response.status, await response.text());
  }

  const parsed = (await response.json()) as ResolveResponse;
  return parsed.audiences ?? {};
}

/**
 * Resolve the active audience card for each lead of a single brand, batching
 * internally. Returns a leadId → AudienceCard map; leads without an active
 * audience are absent. Throws on any resolver / network failure (fail-loud).
 */
export async function resolveAudiences(
  brandId: string,
  leads: AudienceResolveLead[],
  ctx: AudienceResolveContext,
): Promise<Map<string, AudienceCard>> {
  const map = new Map<string, AudienceCard>();
  if (leads.length === 0) return map;

  for (let i = 0; i < leads.length; i += RESOLVE_BATCH_SIZE) {
    const batch = leads.slice(i, i + RESOLVE_BATCH_SIZE);
    const audiences = await resolveBatch(brandId, batch, ctx);
    for (const [leadId, card] of Object.entries(audiences)) {
      map.set(leadId, card);
    }
  }

  return map;
}
