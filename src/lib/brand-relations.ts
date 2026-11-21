/**
 * WHO a population is TO THE BRAND beyond "buyers of offer X" (OUTREACH-3WAYS-1121, owner 2026-11-21).
 *
 * human-service owns the notion (an audience's `relation`, no offer) and builds the populations done-for-you; this is
 * its vocabulary, carried verbatim as `population` values on `POST /orgs/buffer/next` (the sourcing script's tactic):
 *   investors      : the brand's equity investors (business angels, early-stage VCs).
 *   industry_peers : founders and leaders of companies in the brand's industry, competitors included.
 * Dependency-free so schemas.ts publishes it as an OpenAPI enum. A relation human-service adds later = one entry here.
 */
export const BRAND_RELATIONS = ["investors", "industry_peers"] as const;
export type BrandRelation = (typeof BRAND_RELATIONS)[number];

export function isBrandRelation(value: unknown): value is BrandRelation {
  return typeof value === "string" && (BRAND_RELATIONS as readonly string[]).includes(value);
}
