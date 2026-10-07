/**
 * The CATALOGUE of probes a qualification criterion can use. Pure: what a probe is, which ones
 * are built in, and how a treg catalogue endpoint is bound to the company facts we hold.
 *
 * A criterion = ONE probe + ONE yes/no question (src/lib/qualification.ts). The AI that suggests
 * criteria chooses a probe from this catalogue, it never composes a pipeline, so the price of a
 * row is known before a client turns a criterion on.
 *
 * Two families:
 *  - `company_data`: the firmographics already stored on the lead's organization. No paid call;
 *    labelled "already in our data".
 *  - `treg`: any endpoint of the treg catalogue (one cost name, `treg-micro-usd`, for all of
 *    them) that takes the company as input. The built-in probes are curated treg provider lists (first
 *    provider that answers wins); a suggestion may also name any other priced treg endpoint whose
 *    required inputs bind to what we hold about the company.
 *
 * Binding is DETERMINISTIC: a parameter is filled only from a placeholder naming a company fact
 * (`{domain}`, `{websiteUrl}`, `{companyName}`, `{companyLinkedinUrl}`). An endpoint that needs
 * any other required input is not usable, never guessed at.
 */

/** mention = the evidence is offered to the email writer, nobody is dropped; must_pass = a company failing it is not worth its reveal. */
export const QUALIFICATION_MODES = ["mention", "must_pass"] as const;
export type QualificationMode = (typeof QUALIFICATION_MODES)[number];
export const QUALIFICATION_VERDICTS = ["yes", "no", "unavailable"] as const;
export type QualificationVerdict = (typeof QUALIFICATION_VERDICTS)[number];
/** Most leads one sample run checks (a synchronous request). */
export const MAX_SAMPLE = 25;

export const COMPANY_FACTS = ["domain", "websiteUrl", "companyName", "companyLinkedinUrl"] as const;
export type CompanyFact = (typeof COMPANY_FACTS)[number];

export interface CompanySubject {
  domain: string;
  websiteUrl: string;
  companyName: string | null;
  companyLinkedinUrl: string | null;
}

export type ParamValue = string | number | boolean;

/** One treg call: endpoint id, HTTP method, and where the parameters go. */
export interface TregCall {
  endpointId: string;
  method: "GET" | "POST";
  /** Query parameters (GET) or JSON body fields (POST). Strings may carry `{fact}` placeholders. */
  params: Record<string, ParamValue>;
  /** Hold per call, micro-USD: the catalogue price plus headroom. treg refuses above it (402, unbilled). */
  maxMicro: number;
}

/** What the probe hands the judge. */
export type ProbeReading = "text" | "screenshot";

export type ProbeSpec =
  | { kind: "company_data" }
  | {
      kind: "treg";
      /** Plain words shown to the client, e.g. "Homepage content". */
      label: string;
      reading: ProbeReading;
      /** Tried in order; the first provider that answers is the observation. */
      calls: TregCall[];
    };

export const BUILTIN_PROBE_KEYS = [
  "company_data",
  "homepage_text",
  "homepage_screenshot",
  "job_postings",
  "linkedin_company_posts",
] as const;
export type BuiltinProbeKey = (typeof BUILTIN_PROBE_KEYS)[number];

/**
 * Curated provider lists. Prices are treg's catalogue prices (2026-10-07), held with headroom; the
 * ESTIMATE shown to a client is read live from the catalogue, never from these numbers.
 */
export const BUILTIN_PROBES: Record<BuiltinProbeKey, { description: string; spec: ProbeSpec }> = {
  company_data: {
    description:
      "Firmographics we already hold on the company: industry, size, revenue, location, technologies used, keywords, funding, founding year.",
    spec: { kind: "company_data" },
  },
  homepage_text: {
    description: "The text content of the company's homepage (what they say they do, offers, sign-up forms, newsletter, careers links).",
    spec: {
      kind: "treg",
      label: "Homepage content",
      reading: "text",
      calls: [
        { endpointId: "crawl4ai.web.scrape", method: "POST", params: { url: "{websiteUrl}", format: "md" }, maxMicro: 3_000 },
        { endpointId: "olostep.web.scrape", method: "POST", params: { url_to_scrape: "{websiteUrl}" }, maxMicro: 4_000 },
        { endpointId: "keenable.web.fetch", method: "POST", params: { url: "{websiteUrl}" }, maxMicro: 6_000 },
      ],
    },
  },
  homepage_screenshot: {
    description:
      "A screenshot of the first screen of the company's homepage, read by a vision model (is the key message clear above the fold, does it look modern, is there a clear call to action).",
    spec: {
      kind: "treg",
      label: "Homepage first screen",
      reading: "screenshot",
      calls: [{ endpointId: "branddev.brand.screenshot", method: "GET", params: { domain: "{domain}" }, maxMicro: 5_000 }],
    },
  },
  job_postings: {
    description: "The company's open job postings (titles, locations, dates): who they are hiring right now.",
    spec: {
      kind: "treg",
      label: "Open job postings",
      reading: "text",
      calls: [
        {
          endpointId: "treg.companies.jobs.search",
          method: "POST",
          params: { domain: "{domain}", name: "{companyName}", limit: 20 },
          maxMicro: 60_000,
        },
      ],
    },
  },
  linkedin_company_posts: {
    description: "The company's recent LinkedIn page posts, with their dates: do they post, how often, about what.",
    spec: {
      kind: "treg",
      label: "Recent LinkedIn posts",
      reading: "text",
      calls: [
        { endpointId: "scrapecreators.x.v1-linkedin-company-posts", method: "GET", params: { url: "{companyLinkedinUrl}" }, maxMicro: 3_000 },
        { endpointId: "tikhub.x.linkedin-web-v2-get-company-posts", method: "GET", params: { url: "{companyLinkedinUrl}" }, maxMicro: 2_000 },
        { endpointId: "harvestapi.linkedin.company.posts", method: "GET", params: { companyUniversalName: "{companyLinkedinSlug}" }, maxMicro: 5_000 },
      ],
    },
  },
};

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/** A `{companyLinkedinSlug}` is derived from the LinkedIn URL; everything else is a stored fact. */
const DERIVED_FACTS = ["companyLinkedinSlug"] as const;
const KNOWN_PLACEHOLDERS = new Set<string>([...COMPANY_FACTS, ...DERIVED_FACTS]);

export function linkedinCompanySlug(url: string | null): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/(?:company|showcase|school)\/([^/?#]+)/i.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Placeholders a call needs, so a subject missing one is `unavailable` before anything is paid. */
export function placeholdersOf(call: TregCall): string[] {
  const out = new Set<string>();
  for (const v of Object.values(call.params)) {
    if (typeof v !== "string") continue;
    for (const m of v.matchAll(PLACEHOLDER)) out.add(m[1]);
  }
  return [...out];
}

export class MissingCompanyFactError extends Error {
  constructor(public readonly fact: string) {
    super(`the company has no ${fact}`);
    this.name = "MissingCompanyFactError";
  }
}

/** Fill a call's placeholders from the subject. A missing fact throws; nothing is invented. */
export function bindCall(call: TregCall, subject: CompanySubject): Record<string, ParamValue> {
  const facts: Record<string, string | null> = {
    domain: subject.domain,
    websiteUrl: subject.websiteUrl,
    companyName: subject.companyName,
    companyLinkedinUrl: subject.companyLinkedinUrl,
    companyLinkedinSlug: linkedinCompanySlug(subject.companyLinkedinUrl),
  };
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(call.params)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    out[k] = v.replace(PLACEHOLDER, (_m, name: string) => {
      const value = facts[name];
      if (!value) throw new MissingCompanyFactError(name);
      return value;
    });
  }
  return out;
}

/** Validate a probe spec stored or proposed: every placeholder known, every call well formed. */
export function probeSpecProblems(spec: ProbeSpec): string[] {
  if (spec.kind === "company_data") return [];
  const problems: string[] = [];
  if (spec.calls.length === 0) problems.push("a treg probe needs at least one call");
  for (const call of spec.calls) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(call.endpointId)) problems.push(`bad endpoint id ${call.endpointId}`);
    if (!Number.isInteger(call.maxMicro) || call.maxMicro <= 0) problems.push(`${call.endpointId}: maxMicro must be a positive integer`);
    for (const p of placeholdersOf(call)) {
      if (!KNOWN_PLACEHOLDERS.has(p)) problems.push(`${call.endpointId}: unknown placeholder {${p}}`);
    }
  }
  return problems;
}

/**
 * Stable identity of WHAT is observed (the provider list, not the question): two criteria using the same
 * probe on the same domain share one observation, across brands and orgs.
 */
export function probeKey(spec: ProbeSpec): string {
  if (spec.kind === "company_data") return "company_data";
  return `treg:${spec.reading}:${spec.calls.map((c) => `${c.endpointId}?${stableStringify(c.params)}`).join("|")}`;
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

// ---------------------------------------------------------------------------------------------
// The treg catalogue at large: which endpoints a suggestion may use, and how they bind.
// ---------------------------------------------------------------------------------------------

/** The slice of `GET https://treg.to/catalog/endpoints/{id}` this service reads. */
export interface TregCatalogEntry {
  id: string;
  method: string;
  summary?: string | null;
  name?: string | null;
  platform?: string | null;
  platform_eligible?: boolean | null;
  async?: unknown;
  status?: string | null;
  superseded_by?: string | null;
  cost?: { type?: string | null; usd?: number | null; unit?: string | null } | null;
  input?: {
    queryParams?: Record<string, { required?: boolean } | undefined> | null;
    body?: Record<string, { required?: boolean } | undefined> | null;
  } | null;
}

/** Parameter names that ARE a company fact. Anything else required makes the endpoint unusable. */
const PARAM_FACT: Record<string, CompanyFact> = {
  domain: "domain",
  company_domain: "domain",
  companydomain: "domain",
  website_domain: "domain",
  website: "websiteUrl",
  website_url: "websiteUrl",
  websiteurl: "websiteUrl",
  url_to_scrape: "websiteUrl",
  company_name: "companyName",
  companyname: "companyName",
  company: "companyName",
  name: "companyName",
  company_url: "companyLinkedinUrl",
  companyurl: "companyLinkedinUrl",
  companyurlorurn: "companyLinkedinUrl",
  company_profile_url: "companyLinkedinUrl",
  linkedin_url: "companyLinkedinUrl",
  linkedinurl: "companyLinkedinUrl",
};

/** Only per-call prices are bounded per row; a per-row/per-record price has no ceiling we can state. */
const BOUNDED_COST_TYPES = new Set(["per_call", "per_success", "free"]);

export type CatalogUnusableReason =
  | "not_on_platform_key"
  | "async_task"
  | "withdrawn"
  | "unbounded_price"
  | "no_price"
  | "unbindable_input"
  | "takes_no_company_input";

/**
 * Turn a catalogue entry into a probe call, or say why it cannot be one. A `url` parameter is the
 * company's LinkedIn page on a LinkedIn endpoint, its website everywhere else.
 */
export function catalogEntryToCall(
  entry: TregCatalogEntry,
): { ok: true; call: TregCall; vendorUsd: number } | { ok: false; reason: CatalogUnusableReason } {
  if (entry.platform_eligible !== true) return { ok: false, reason: "not_on_platform_key" };
  if (entry.async) return { ok: false, reason: "async_task" };
  if (entry.superseded_by || (entry.status && entry.status !== "ok" && entry.status !== "active")) {
    return { ok: false, reason: "withdrawn" };
  }
  const costType = entry.cost?.type ?? null;
  if (!costType || !BOUNDED_COST_TYPES.has(costType)) return { ok: false, reason: "unbounded_price" };
  const usd = costType === "free" ? 0 : entry.cost?.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return { ok: false, reason: "no_price" };

  const method = entry.method.toUpperCase() === "GET" ? "GET" : "POST";
  const fields = method === "GET" ? entry.input?.queryParams ?? {} : entry.input?.body ?? entry.input?.queryParams ?? {};
  const isLinkedin = /linkedin/i.test(`${entry.id} ${entry.platform ?? ""}`);
  const params: Record<string, ParamValue> = {};
  for (const [name, meta] of Object.entries(fields ?? {})) {
    const key = name.toLowerCase();
    const fact: CompanyFact | undefined = key === "url" ? (isLinkedin ? "companyLinkedinUrl" : "websiteUrl") : PARAM_FACT[key];
    if (fact) {
      params[name] = `{${fact}}`;
    } else if (meta?.required) {
      return { ok: false, reason: "unbindable_input" };
    }
  }
  if (Object.keys(params).length === 0) return { ok: false, reason: "takes_no_company_input" };
  // Headroom: twice the list price, at least 1,000 micro-USD ($0.001).
  const maxMicro = Math.max(1_000, Math.ceil(usd * 1_000_000 * 2));
  return { ok: true, call: { endpointId: entry.id, method, params, maxMicro }, vendorUsd: usd };
}
