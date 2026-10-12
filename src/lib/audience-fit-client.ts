import { HUMAN_SERVICE_URL, HUMAN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { AudienceFitVerdict } from "./source-stock.js";

/**
 * Does a person a source found earlier STILL fit the audience they were found for, right now? (STILL-FITS-1012)
 *
 * human-service owns every audience (CRM people pools and segments through crm-service, CSV lists, Apollo criteria),
 * so it is the only one that can say; lead-service never re-grades membership itself. Asked once per stocked find at
 * handover (src/lib/source-stock.ts). Free to ask: nothing is bought, nobody is marked served.
 *
 * Never "fits" by default. A person human-service says it CANNOT judge (422: e.g. the brand's CRM no longer holds
 * anyone at that address) is not shown to fit, so it is set aside with human-service's own words: failing the serve
 * instead would block the whole stock on that one row forever. Every other non-2xx (404 unknown audience, 502 crm
 * down), a network failure or an unreadable verdict throws: the serve fails and the stock stays as it was.
 */

// Deployed wire contract (human-service v0.50.10, STILL-FITS-1012; direct to HUMAN_SERVICE_URL, X-API-Key):
//   POST {HUMAN_SERVICE_URL}/internal/audiences/still-fits
//   Body: { orgId, audienceId, brandId, email, personId: string|null }
//   200:  { fits: true, basis } | { fits: false, reason: "<plain words>", basis, failed: [{code, reason}] }
//   404 audience_not_found · 422 { error, code } the person cannot be judged · 502 crm-service down
const FIT_PATH = "/internal/audiences/still-fits";

export class AudienceFitError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`[lead-service] human-service audience fit check failed: ${status} - ${message}`);
    this.name = "AudienceFitError";
    this.status = status;
  }
}

export async function askAudienceFit(
  question: { audienceId: string; brandId: string; email: string; personId: string | null },
  ctx: { orgId: string; userId?: string | null; runId?: string | null },
): Promise<AudienceFitVerdict> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": HUMAN_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;

  const response = await fetchWithRetry(`${HUMAN_SERVICE_URL}${FIT_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orgId: ctx.orgId, ...question }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (response.status === 422) return cannotJudge(text);
  if (!response.ok) throw new AudienceFitError(response.status, text.slice(0, 300));
  return readVerdict(JSON.parse(text) as unknown, response.status);
}

export function readVerdict(body: unknown, status: number): AudienceFitVerdict {
  const b = body as { fits?: unknown; reason?: unknown } | null;
  if (!b || typeof b.fits !== "boolean") throw new AudienceFitError(status, "answered without a fits verdict");
  if (b.fits) return { fits: true };
  if (typeof b.reason !== "string" || b.reason.trim() === "") {
    throw new AudienceFitError(status, "answered no longer fits without a reason");
  }
  return { fits: false, reason: b.reason.trim() };
}

/** human-service cannot judge the person: not shown to fit, set aside in its own words. */
function cannotJudge(text: string): AudienceFitVerdict {
  let body: { error?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { error?: unknown };
  } catch {
    throw new AudienceFitError(422, `cannot-judge answer unreadable: ${text.slice(0, 300)}`);
  }
  if (typeof body?.error !== "string" || body.error.trim() === "") throw new AudienceFitError(422, "cannot-judge answer without words");
  return { fits: false, reason: body.error.trim() };
}
