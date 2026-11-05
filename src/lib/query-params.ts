/**
 * A read that takes query filters REFUSES a parameter it does not know (LEADS-UNKNOWN-FILTER-1105).
 *
 * Express hands every query parameter to the route and a route reads only the ones it knows, so a
 * filter the route never heard of used to vanish: the read answered as if unfiltered. Prod
 * 2026-11-04: an AI assistant asked the leads list for `replyClassification=positive`, got the whole
 * brand back, and told a client a prospect who never replied "replied positively". An unknown VALUE
 * was already a 400 naming the valid values; an unknown NAME now is too, naming the accepted ones,
 * so a caller (often an LLM agent) can correct itself. Nothing is guessed or aliased.
 *
 * Each route states its accepted list next to the code that reads it. A parameter a live caller
 * sends must be on that list (tests/unit/query-params-callers.test.ts pins what each one sends).
 */
import type { Response } from "express";

export const UNKNOWN_QUERY_PARAMETER = "unknown_query_parameter";

/** The query parameter names `query` carries that `accepted` does not list, in request order. */
export function unknownQueryParams(query: Record<string, unknown>, accepted: readonly string[]): string[] {
  return Object.keys(query).filter((name) => !accepted.includes(name));
}

/** The refusal body: which names are unknown, which are accepted, in one readable sentence too. */
export function unknownQueryParamsBody(unknown: readonly string[], accepted: readonly string[]) {
  return {
    error:
      `unknown query parameter(s): ${unknown.join(", ")}; accepted: ${accepted.join(", ")}. ` +
      "Nothing was read: a filter this read does not know is refused, never ignored.",
    code: UNKNOWN_QUERY_PARAMETER,
    unknown: [...unknown],
    accepted: [...accepted],
  };
}

/**
 * Answers 400 and returns true when the request names a query parameter outside `accepted`; returns
 * false (nothing written) otherwise. Call it first, before any work starts.
 */
export function refuseUnknownQueryParams(
  query: Record<string, unknown>,
  res: Response,
  accepted: readonly string[],
): boolean {
  const unknown = unknownQueryParams(query, accepted);
  if (unknown.length === 0) return false;
  res.status(400).json(unknownQueryParamsBody(unknown, accepted));
  return true;
}

/**
 * Who the call is FOR, on every read: a staff key names its target org on the query (`orgId`; the
 * MCP's `withTarget` appends it, the gateway forwards the query verbatim). Accepted everywhere; a
 * read that scopes on it (`GET /orgs/leads`) lists it among its own filters too.
 */
export const TARGET_QUERY_PARAMS = ["orgId"] as const;

/**
 * Express middleware form: `router.get(path, apiKeyAuth, requireOrgId, acceptQuery(LIST), handler)`.
 * `accepted` is the route's own vocabulary; `orgId` (TARGET_QUERY_PARAMS) is always added.
 */
export function acceptQuery(accepted: readonly string[]) {
  const all = [...new Set([...accepted, ...TARGET_QUERY_PARAMS])];
  return (req: { query: Record<string, unknown> }, res: Response, next: () => void) => {
    if (refuseUnknownQueryParams(req.query, res, all)) return;
    next();
  };
}
