/**
 * A lead is a HUMAN at a COMPANY (owner 2026-10-13, LEAD-REFONTE-1013): the human lives in
 * human-service, the company in brand-service, the lead here. Pure halves (no db, no fetch) of
 * the identity sweep (`lead-identity-sweep.ts`), so they carry real unit tests.
 *
 *  - `humanKeysOf`: the keys a lead row holds, stated to human-service together as ONE contact.
 *    Registered emails and E.164 phones are PROOF keys there (they merge humans fleet-wide);
 *    LinkedIn and provider ids only resolve. Nothing guessed: a phone not in E.164 is left out (it
 *    would make human-service refuse the whole call), a provider id is sent under the provider the
 *    serve recorded (`metadata.provider`); rows predating that field came from the Apollo-only path
 *    (the column is `apollo_person_id`), so they are Apollo's.
 *  - `companyInputOf`: the employer row's identity for brand-service (domain, else LinkedIn company
 *    page, else Apollo org id; a NAME is never an identity: brand-service answers `no_safe_identity`).
 *  - `companyFactsOf`: the firmographics an employer row holds, under brand-service's CLOSED fact
 *    keys and types. brand-service refuses a WHOLE batch on one wrong type, so every value is
 *    checked here and dropped when it does not fit (an empty value is absent, never a clear).
 */
import type { CompanyResolveInput } from "./company-client.js";

export interface LeadKeyRow {
  lead_id: string;
  apollo_person_id: string | null;
  provider: string | null;
  linkedin_url: string | null;
  emails: string[] | null;
  phones: string[] | null;
}

export interface HumanKeys {
  emails: string[];
  phones: string[];
  linkedinUrls: string[];
  providerPersonIds: Array<{ provider: "apollo" | "apify"; id: string }>;
}

const E164 = /^\+[1-9]\d{5,14}$/;

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function humanKeysOf(row: LeadKeyRow): HumanKeys {
  const emails = uniq((row.emails ?? []).map((e) => e.trim()).filter((e) => e.includes("@")));
  const phones = uniq((row.phones ?? []).map((p) => p.trim()).filter((p) => E164.test(p)));
  const linkedin = row.linkedin_url?.trim();
  const linkedinUrls = linkedin && /linkedin\.com\/in\//i.test(linkedin) ? [linkedin] : [];
  const providerPersonIds: HumanKeys["providerPersonIds"] = [];
  const pid = row.apollo_person_id?.trim();
  if (pid) {
    const provider = row.provider ?? "apollo";
    if (provider === "apollo" || provider === "apify") providerPersonIds.push({ provider, id: pid });
  }
  return { emails, phones, linkedinUrls, providerPersonIds };
}

export function hasAnyKey(k: HumanKeys): boolean {
  return k.emails.length + k.phones.length + k.linkedinUrls.length + k.providerPersonIds.length > 0;
}

export interface OrganizationRow {
  id: string;
  name: string | null;
  primary_domain: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  apollo_organization_id: string | null;
  short_description: string | null;
  seo_description: string | null;
  logo_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  blog_url: string | null;
  crunchbase_url: string | null;
  angellist_url: string | null;
  industry: string | null;
  industries: string[] | null;
  secondary_industries: string[] | null;
  keywords: string[] | null;
  technology_names: string[] | null;
  founded_year: number | null;
  estimated_num_employees: number | null;
  annual_revenue: string | number | null;
  latest_funding_stage: string | null;
  latest_funding_round_date: string | Date | null;
  total_funding: string | number | null;
  total_funding_printed: string | null;
  funding_events: unknown;
  retail_location_count: number | null;
  num_suborganizations: number | null;
  alexa_ranking: number | null;
  publicly_traded_symbol: string | null;
  publicly_traded_exchange: string | null;
  primary_phone: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  updated_at: Date | string;
}

const blank = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : null;
};

export function companyInputOf(org: OrganizationRow): CompanyResolveInput {
  return {
    ref: org.id,
    domain: blank(org.primary_domain) ?? blank(org.website_url),
    linkedinUrl: blank(org.linkedin_url),
    apolloOrganizationId: blank(org.apollo_organization_id),
    name: blank(org.name),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}
function strs(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
  return out.length > 0 ? out : undefined;
}
function int(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
function day(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  if (typeof v !== "string") return undefined;
  const d = v.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : undefined;
}
function objects(v: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (v.some((x) => x === null || typeof x !== "object" || Array.isArray(x))) return undefined;
  return v as Record<string, unknown>[];
}

/** brand-service fact key -> value, only keys with a value of the right type. */
export function companyFactsOf(org: OrganizationRow): Record<string, unknown> {
  const facts: Record<string, unknown> = {
    name: str(org.name),
    description: str(org.short_description),
    seoDescription: str(org.seo_description),
    websiteUrl: str(org.website_url),
    logoUrl: str(org.logo_url),
    linkedinUrl: str(org.linkedin_url),
    twitterUrl: str(org.twitter_url),
    facebookUrl: str(org.facebook_url),
    blogUrl: str(org.blog_url),
    crunchbaseUrl: str(org.crunchbase_url),
    angellistUrl: str(org.angellist_url),
    industry: str(org.industry),
    industries: strs(org.industries),
    secondaryIndustries: strs(org.secondary_industries),
    keywords: strs(org.keywords),
    technologies: strs(org.technology_names),
    foundedYear: int(org.founded_year),
    employeeCount: int(org.estimated_num_employees),
    annualRevenueUsd: num(org.annual_revenue),
    latestFundingStage: str(org.latest_funding_stage),
    latestFundingRoundDate: day(org.latest_funding_round_date),
    totalFundingUsd: num(org.total_funding),
    totalFundingPrinted: str(org.total_funding_printed),
    fundingEvents: objects(org.funding_events),
    retailLocationCount: int(org.retail_location_count),
    numSuborganizations: int(org.num_suborganizations),
    alexaRanking: int(org.alexa_ranking),
    publiclyTradedSymbol: str(org.publicly_traded_symbol),
    publiclyTradedExchange: str(org.publicly_traded_exchange),
    primaryPhone: str(org.primary_phone),
    streetAddress: str(org.street_address),
    city: str(org.city),
    state: str(org.state),
    postalCode: str(org.postal_code),
    country: str(org.country),
  };
  for (const k of Object.keys(facts)) if (facts[k] === undefined) delete facts[k];
  return facts;
}

/**
 * Free-mail domains name no company (same list as human-service's own-company rule). A personal
 * address is the HUMAN's, never a company identity.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.fr",
  "live.com", "msn.com", "yahoo.com", "yahoo.fr", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "gmx.net", "web.de", "orange.fr", "free.fr", "laposte.net", "yandex.com",
  "yandex.ru", "mail.ru", "zoho.com", "hey.com", "fastmail.com", "qq.com",
  "163.com",
]);

/** The domain of a WORK address, lowercased; null for a free-mail or unreadable address. */
export function workEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (FREE_MAIL_DOMAINS.has(domain)) return null;
  for (const free of FREE_MAIL_DOMAINS) if (domain.endsWith(`.${free}`)) return null;
  return domain;
}
