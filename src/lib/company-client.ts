/**
 * brand-service is the home of the COMPANY a lead works at (owner 2026-10-13, LEAD-REFONTE-1013):
 * a prospect's company is a brand row like any other (same domain = same brand id), nobody's client.
 * Its identity facts (name, size, funding, industry...) live there; facts about the company as a
 * BUYER (client of brand X, "not our target") stay here and are never written there.
 *
 * Contract (brand-service `src/routes/companies.routes.ts`, internal, service key, no org, max 1000):
 *   POST /internal/companies/resolve {companies: [{ref?, domain?, linkedinUrl?, apolloOrganizationId?, name?}]}
 *        -> {companies: [{index, ref, brandId|null, domain, matchedBy, created, unresolvedReason, conflictingIdentifiers}]}
 *        A NAME is never an identity: name-only = `no_safe_identity`, nothing created.
 *   PUT  /internal/companies/facts {companies: [{brandId, source, observedAt?, facts}]} -> {written, skippedAbsent, keptNewer}
 *        Closed key list; null/blank/empty = absent, never clears; a newer stored observation is kept.
 *   POST /internal/companies/batch {brandIds} -> {companies: [{brandId, domain, name, identifiers, facts}]}
 *
 * FAIL LOUD: any non-2xx throws `CompanyServiceError`.
 */
import { BRAND_SERVICE_URL, BRAND_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export const MAX_COMPANIES_PER_REQUEST = 1000;

export class CompanyServiceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "CompanyServiceError";
  }
}

export interface CompanyResolveInput {
  ref?: string;
  domain?: string | null;
  linkedinUrl?: string | null;
  apolloOrganizationId?: string | null;
  name?: string | null;
}

export interface CompanyResolution {
  index: number;
  ref: string | null;
  brandId: string | null;
  domain: string | null;
  matchedBy: "domain" | "linkedin_company" | "apollo_organization" | null;
  created: boolean;
  unresolvedReason: "no_safe_identity" | "invalid_domain" | null;
}

export interface CompanyFactsWrite {
  brandId: string;
  source: string;
  observedAt?: string | null;
  facts: Record<string, unknown>;
}

export interface CompanyRecord {
  brandId: string;
  domain: string | null;
  name: string | null;
  facts: Record<string, { value: unknown; source: string; observedAt: string }>;
}

const TIMEOUT_MS = 60_000;

async function call<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`${BRAND_SERVICE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": BRAND_SERVICE_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CompanyServiceError(`brand-service ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`, res.status);
  }
  return (await res.json()) as T;
}

function assertBatch(n: number): void {
  if (n > MAX_COMPANIES_PER_REQUEST) {
    throw new Error(`[company-client] ${n} companies in one call; brand-service takes at most ${MAX_COMPANIES_PER_REQUEST}`);
  }
}

/** One result per input, input order. */
export async function resolveCompanies(companies: CompanyResolveInput[]): Promise<CompanyResolution[]> {
  if (companies.length === 0) return [];
  assertBatch(companies.length);
  const r = await call<{ companies: CompanyResolution[] }>("POST", "/internal/companies/resolve", { companies });
  if (r.companies.length !== companies.length) {
    throw new CompanyServiceError(
      `brand-service resolve answered ${r.companies.length} results for ${companies.length} companies`,
      null,
    );
  }
  return [...r.companies].sort((a, b) => a.index - b.index);
}

export async function writeCompanyFacts(
  companies: CompanyFactsWrite[],
): Promise<{ written: number; skippedAbsent: number; keptNewer: number }> {
  if (companies.length === 0) return { written: 0, skippedAbsent: 0, keptNewer: 0 };
  assertBatch(companies.length);
  return call("PUT", "/internal/companies/facts", { companies });
}

export async function getCompanies(brandIds: string[]): Promise<CompanyRecord[]> {
  if (brandIds.length === 0) return [];
  assertBatch(brandIds.length);
  const r = await call<{ companies: CompanyRecord[] }>("POST", "/internal/companies/batch", { brandIds });
  return r.companies;
}
