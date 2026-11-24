/**
 * Provider reads of our Units (ENGINE-GET-ASK-1123): the PURE half (vocabulary, query parsing, cursor).
 *
 * This service declares these outcomes on runs-service's ledger and is their Provider: `lead_found` (a serve that
 * FOUND a person), `company_researched` (a run that paid new research on a company) and the fact outcomes a lead
 * reaches (`FACT_OUTCOME_KEYS`, run-outcomes.ts). A Script asks, before it acts, which Units already exist:
 * workflow-service finds each read by its OpenAPI TAG (`provider:<outcome key>`) in our served `openapi.json` and
 * calls it as the script's run. NEVER rename a path, a tag or an operationId once shipped.
 *
 * No import of the database here: `src/schemas.ts` reads this module and `generate:openapi` runs with no database.
 * The SQL lives in provider-units.ts.
 */

export const UNITS_DEFAULT_LIMIT = 100;
export const UNITS_MAX_LIMIT = 1000;
export const UNITS_MAX_FILTER_VALUES = 100;
export const UNIT_SUBJECT_SERVICE = "lead-service" as const;
export const NOT_SERVED_TO_ANY = "any_campaign" as const;

/** Mirrors `FACT_OUTCOME_KEYS` (run-outcomes.ts, which imports the database); a unit test holds the two equal. */
export const FACT_UNIT_OUTCOMES = [
  "website_visit",
  "signup",
  "form_submitted",
  "purchase",
  "meeting_booked",
  "meeting_attended",
  "paid_client",
] as const;
export type FactUnitOutcome = (typeof FACT_UNIT_OUTCOMES)[number];
export type ProviderUnitOutcome = "lead_found" | "company_researched" | FactUnitOutcome;
export type ProviderUnitKind = "lead_found" | "company_researched" | "fact";

export interface ProviderUnitRead {
  outcome: ProviderUnitOutcome;
  kind: ProviderUnitKind;
  path: string;
  operationId: string;
  tag: string;
  /** The key of this read in READ_QUERY_PARAMS. */
  vocabularyKey: string;
}

const pascal = (outcome: string) => outcome.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const readOf = (outcome: ProviderUnitOutcome, kind: ProviderUnitKind): ProviderUnitRead => {
  const path = `/orgs/units/${outcome.replace(/_/g, "-")}`;
  return { outcome, kind, path, operationId: `list${pascal(outcome)}Units`, tag: `provider:${outcome}`, vocabularyKey: `GET ${path}` };
};

/** Every Provider read this service serves. Order = the order they are registered and documented in. */
export const PROVIDER_UNIT_READS: readonly ProviderUnitRead[] = [
  readOf("lead_found", "lead_found"),
  readOf("company_researched", "company_researched"),
  ...FACT_UNIT_OUTCOMES.map((o) => readOf(o, "fact")),
];

/** The query parameters each kind of read accepts (READ_QUERY_PARAMS lists them per path). */
export const UNIT_QUERY_PARAMS: Record<ProviderUnitKind, readonly string[]> = {
  lead_found: ["emails", "leadIds", "domains", "brandId", "campaignId", "since", "until", "notServedTo", "limit", "cursor"],
  fact: ["emails", "leadIds", "domains", "brandId", "since", "until", "limit", "cursor"],
  company_researched: ["domains", "brandId", "since", "until", "limit", "cursor"],
};

/** A query the caller must fix: the route answers 400 `{error: code, message}`. */
export class UnitsQueryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UnitsQueryError";
  }
}

export interface UnitsFilters {
  orgId: string;
  emails: string[];
  leadIds: string[];
  domains: string[];
  brandId?: string;
  campaignId?: string;
  /** ISO 8601 UTC. Inclusive lower bound on the Unit's `at`. */
  since?: string;
  /** ISO 8601 UTC. Exclusive upper bound. */
  until?: string;
  /** lead_found only: `any_campaign` or a campaign id. */
  notServedTo?: string;
  limit: number;
  cursor?: UnitCursor;
}

export type RawUnitsQuery = Record<string, unknown>;

/** `a,b` / `["a","b,c"]` -> trimmed, non-empty, de-duplicated values in order. */
export function splitList(value: unknown): string[] {
  if (value == null) return [];
  const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => String(v).split(","));
  const seen = new Set<string>();
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

function boundedList(name: string, values: string[]): string[] {
  if (values.length > UNITS_MAX_FILTER_VALUES) {
    throw new UnitsQueryError("too_many_values", `${name}: at most ${UNITS_MAX_FILTER_VALUES} values per request (got ${values.length})`);
  }
  return values;
}

/** An ISO 8601 date or datetime -> ISO UTC. A datetime with no zone is read as UTC. */
function instant(name: string, value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const raw = String(Array.isArray(value) ? value[0] : value).trim();
  const shaped = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(raw);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = shaped ? new Date(dateOnly || zoned ? raw.replace(" ", "T") : `${raw.replace(" ", "T")}Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new UnitsQueryError(`invalid_${name}`, `${name}: not an ISO 8601 datetime (${raw})`);
  }
  return parsed.toISOString();
}

function single(value: unknown): string | undefined {
  if (value == null) return undefined;
  const raw = String(Array.isArray(value) ? value[0] : value).trim();
  return raw === "" ? undefined : raw;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Normalises and validates a query. Throws `UnitsQueryError` (400). Unknown parameter NAMES are refused before it (acceptQuery). */
export function parseUnitsQuery(kind: ProviderUnitKind, orgId: string, raw: RawUnitsQuery): UnitsFilters {
  const takes = (name: string) => UNIT_QUERY_PARAMS[kind].includes(name);

  const emails = takes("emails") ? boundedList("emails", [...new Set(splitList(raw.emails).map((e) => e.toLowerCase()))]) : [];
  const notAddresses = emails.filter((e) => !/^[^@\s]+@[^@\s]+$/.test(e));
  if (notAddresses.length > 0) throw new UnitsQueryError("invalid_emails", `emails: not an address: ${notAddresses.join(", ")}`);

  const leadIds = takes("leadIds") ? boundedList("leadIds", [...new Set(splitList(raw.leadIds).map((id) => id.toLowerCase()))]) : [];
  const notIds = leadIds.filter((id) => !UUID.test(id));
  if (notIds.length > 0) throw new UnitsQueryError("invalid_leadIds", `leadIds: not a lead id (uuid): ${notIds.join(", ")}`);

  const domains = boundedList(
    "domains",
    [...new Set(splitList(raw.domains).map((d) => d.toLowerCase().replace(/^@+/, "")))].filter((d) => d !== ""),
  );
  const notDomains = domains.filter((d) => /[@\s/]/.test(d));
  if (notDomains.length > 0) {
    throw new UnitsQueryError("invalid_domains", `domains: a company domain is the part after '@', no scheme or path (got ${notDomains.join(", ")})`);
  }

  const brandId = single(raw.brandId);
  if (emails.length === 0 && leadIds.length === 0 && domains.length === 0 && brandId === undefined) {
    throw new UnitsQueryError(
      "person_or_brand_filter_required",
      kind === "company_researched"
        ? "Name what you ask about: at least one of domains, brandId is required"
        : "Name who you ask about: at least one of emails, leadIds, domains, brandId is required",
    );
  }

  let limit = UNITS_DEFAULT_LIMIT;
  const rawLimit = single(raw.limit);
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > UNITS_MAX_LIMIT) {
      throw new UnitsQueryError("invalid_limit", `limit: an integer from 1 to ${UNITS_MAX_LIMIT}`);
    }
  }

  const rawCursor = single(raw.cursor);
  return {
    orgId,
    emails,
    leadIds,
    domains,
    brandId,
    campaignId: takes("campaignId") ? single(raw.campaignId) : undefined,
    since: instant("since", raw.since),
    until: instant("until", raw.until),
    notServedTo: takes("notServedTo") ? single(raw.notServedTo) : undefined,
    limit,
    cursor: rawCursor === undefined ? undefined : decodeUnitCursor(rawCursor),
  };
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

/** Keyset position: the last Unit's instant at full microsecond precision + its id. */
export interface UnitCursor {
  /** `YYYY-MM-DDTHH:MM:SS.ffffff`, UTC, no zone (as Postgres printed it). */
  at: string;
  unitId: string;
}

export const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

export function encodeUnitCursor(cursor: UnitCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.unitId]), "utf8").toString("base64url");
}

/** Throws `UnitsQueryError` `invalid_cursor` on a cursor this service did not mint. */
export function decodeUnitCursor(cursor: string): UnitCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    !CURSOR_AT.test(parsed[0]) ||
    parsed[1] === ""
  ) {
    throw new UnitsQueryError("invalid_cursor", "cursor: not a cursor this read issued; pass the previous page's nextCursor verbatim");
  }
  return { at: parsed[0], unitId: parsed[1] };
}
