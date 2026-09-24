/**
 * The customer's own CRM, as crm-service mirrors it.
 *
 * crm-service owns the connection, the credential and every shape below; nothing here re-derives
 * any of it and nothing here ever writes back — no service in this fleet has a write path into a
 * customer's CRM, by design.
 *
 * Three reads, all brand-scoped, because a GoHighLevel sub-account is keyed to exactly one brand
 * (crm-service's `ghl_connections` is UNIQUE on `(org_id, brand_id)`):
 *
 *   - `fetchCrmConnection`   — does this brand have a mirrored CRM at all
 *   - `streamCrmContacts`    — their contacts, a page at a time, never all in memory
 *   - `fetchCrmOpportunities` — their opportunities, flattened out of the pipeline view
 *
 * FAIL LOUD: every failure throws `CrmServiceError` and the route answers 502. A CRM we could not
 * read and a CRM holding nothing are different facts, and collapsing them would tell a customer
 * their CRM is empty.
 */
import { CRM_SERVICE_API_KEY, CRM_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { canonicalizeOpportunityState, type CrmOpportunityState } from "./crm-pairing.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** crm-service caps a contacts page at 1000. Their whole population is a few thousand rows. */
export const CRM_CONTACT_PAGE_SIZE = 1_000;

export class CrmServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmServiceError";
  }
}

export interface CrmIdentityContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

function headersFor(ctx: CrmIdentityContext): Record<string, string> {
  const headers: Record<string, string> = {
    "X-API-Key": CRM_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  return headers;
}

async function getJson<T>(path: string, ctx: CrmIdentityContext): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithRetry(`${CRM_SERVICE_URL}${path}`, {
      method: "GET",
      headers: headersFor(ctx),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CrmServiceError(`crm-service unreachable for ${path}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CrmServiceError(`crm-service ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new CrmServiceError(
      `crm-service answer for ${path} was not readable JSON: ${(error as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export interface CrmConnection {
  id: string;
  brandId: string;
  locationId: string;
  status: string;
  synced: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/** The brand's mirrored CRM, or null when it has none. Null is an ANSWER, not a failure. */
export async function fetchCrmConnection(
  brandId: string,
  ctx: CrmIdentityContext,
): Promise<CrmConnection | null> {
  const body = await getJson<{ connections?: CrmConnection[] }>(
    `/orgs/gohighlevel/connections?brandId=${encodeURIComponent(brandId)}`,
    ctx,
  );
  const connections = Array.isArray(body.connections) ? body.connections : [];
  return connections[0] ?? null;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Where a contact's record came from, in THEIR CRM, in THEIR words.
 *
 * crm-service serves this per contact under `record` (GoHighLevel's contact type, lead source,
 * tags, created/updated dates and the attribution origin it captured). Every value is the
 * customer's own free text, carried verbatim and never mapped onto any vocabulary of ours; a
 * field their CRM does not hold reads `null`, never a default.
 */
export interface CrmContactRecord {
  type: string | null;
  leadSource: string | null;
  tags: string[] | null;
  createdAt: string | null;
  updatedAt: string | null;
  origin: {
    medium: string | null;
    url: string | null;
    referrer: string | null;
  };
}

/** One contact as this service reads it, normalized out of crm-service's served shape. */
export interface CrmContact {
  id: string;
  brandId: string;
  externalId: string | null;
  primaryEmail: string | null;
  phoneE164: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  unsubscribed: boolean;
  companyName?: string | null;
  /** The company's website, when their CRM holds one. Feeds the matcher's domain tier. */
  companyUrl?: string | null;
  /** Provenance. Always present on a contact read through `fetchCrmContactsPage`. */
  record?: CrmContactRecord;
  lastRebuiltAt?: string | null;
}

/**
 * crm-service's served contact. It groups company and provenance into nested objects
 * (`company: { name, website }`, `record: {...}`); an older build served `companyName` flat.
 * BOTH spellings are read, because reading only the flat one is what silently blanked every
 * contact's company once the nested shape shipped.
 */
interface RawCrmContact {
  id: string;
  brandId: string;
  externalId?: string | null;
  primaryEmail?: string | null;
  phoneE164?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  unsubscribed?: boolean;
  lastRebuiltAt?: string | null;
  companyName?: string | null;
  company?: { name?: string | null; website?: string | null } | null;
  record?: {
    type?: unknown;
    leadSource?: unknown;
    tags?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    origin?: { medium?: unknown; url?: unknown; referrer?: unknown } | null;
  } | null;
}

function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** Tags are a list of their words. Anything that is not a list of strings is "not held", not coerced. */
function tagsOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((t) => typeof t === "string") ? (v as string[]) : null;
}

export function normalizeCrmContact(raw: RawCrmContact): CrmContact {
  const record = raw.record ?? null;
  const origin = record?.origin ?? null;
  return {
    id: raw.id,
    brandId: raw.brandId,
    externalId: raw.externalId ?? null,
    primaryEmail: raw.primaryEmail ?? null,
    phoneE164: raw.phoneE164 ?? null,
    fullName: raw.fullName ?? null,
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    unsubscribed: raw.unsubscribed === true,
    lastRebuiltAt: raw.lastRebuiltAt ?? null,
    companyName: textOrNull(raw.company?.name) ?? textOrNull(raw.companyName),
    companyUrl: textOrNull(raw.company?.website),
    record: {
      type: textOrNull(record?.type),
      leadSource: textOrNull(record?.leadSource),
      tags: tagsOrNull(record?.tags),
      createdAt: textOrNull(record?.createdAt),
      updatedAt: textOrNull(record?.updatedAt),
      origin: {
        medium: textOrNull(origin?.medium),
        url: textOrNull(origin?.url),
        referrer: textOrNull(origin?.referrer),
      },
    },
  };
}

export async function fetchCrmContactsPage(
  brandId: string,
  limit: number,
  offset: number,
  ctx: CrmIdentityContext,
): Promise<CrmContact[]> {
  const body = await getJson<{ contacts?: RawCrmContact[] }>(
    `/orgs/gohighlevel/contacts?brandId=${encodeURIComponent(brandId)}&limit=${limit}&offset=${offset}`,
    ctx,
  );
  return Array.isArray(body.contacts) ? body.contacts.map(normalizeCrmContact) : [];
}

/**
 * Their whole contact population, a page at a time. The caller folds each page into counters and
 * drops it — nothing accumulates a list, so a summary costs the same on a CRM of any size.
 * `startOffset` resumes the walk at a position in their list (a filtered read's cursor).
 */
export async function* streamCrmContacts(
  brandId: string,
  ctx: CrmIdentityContext,
  startOffset = 0,
): AsyncGenerator<CrmContact[]> {
  let offset = startOffset;
  for (;;) {
    const page = await fetchCrmContactsPage(brandId, CRM_CONTACT_PAGE_SIZE, offset, ctx);
    if (page.length === 0) return;
    yield page;
    if (page.length < CRM_CONTACT_PAGE_SIZE) return;
    offset += page.length;
  }
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

interface RawOpportunity {
  id: string;
  externalId: string | null;
  name: string | null;
  status: string | null;
  monetaryValue: string | number | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  contactId: string | null;
  externalContactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * One opportunity, with their state canonicalized and their stage left exactly as they wrote it.
 *
 * A contact routinely carries SEVERAL of these at once, in different pipelines, in conflicting
 * states — on the first mirrored account one real person is simultaneously a closed-won deal, a
 * free-trial client and a past event attendee. Their status is a SET, not a value, so nothing here
 * reduces it to one.
 */
export interface CrmOpportunity {
  id: string;
  externalId: string | null;
  name: string | null;
  /** `open` | `won` | `lost` | `abandoned`, or null when it is a word we do not recognise. */
  state: CrmOpportunityState | null;
  /** Their word, verbatim, so a null `state` is auditable rather than mysterious. */
  stateRaw: string | null;
  monetaryValue: number | null;
  pipelineName: string | null;
  /** Free text they chose. Never mapped to any step vocabulary of ours — see crm-pairing.ts. */
  stageName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function normalizeOpportunity(raw: RawOpportunity): CrmOpportunity {
  const value =
    raw.monetaryValue === null || raw.monetaryValue === undefined
      ? null
      : Number(raw.monetaryValue);
  return {
    id: raw.id,
    externalId: raw.externalId ?? null,
    name: raw.name ?? null,
    state: canonicalizeOpportunityState(raw.status),
    stateRaw: raw.status ?? null,
    monetaryValue: Number.isFinite(value) ? (value as number) : null,
    pipelineName: raw.pipelineName ?? null,
    stageName: raw.stageName ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
  };
}

/**
 * Every opportunity the brand's CRM holds, keyed by the crm-service contact id it hangs off.
 *
 * crm-service serves them as a PIPELINE VIEW (pipelines -> stages -> opportunities, plus an
 * `ungrouped` bucket); this flattens it, because a pairing surface reads per PERSON. An
 * opportunity with no contact id belongs to nobody we can pair and is dropped rather than guessed
 * onto someone.
 */
export async function fetchCrmOpportunitiesByContact(
  brandId: string,
  ctx: CrmIdentityContext,
): Promise<Map<string, CrmOpportunity[]>> {
  const body = await getJson<{
    pipelines?: Array<{ stages?: Array<{ opportunities?: RawOpportunity[] }> }>;
    ungrouped?: RawOpportunity[];
  }>(`/orgs/gohighlevel/opportunities?brandId=${encodeURIComponent(brandId)}`, ctx);

  const byContact = new Map<string, CrmOpportunity[]>();
  const push = (raw: RawOpportunity) => {
    if (!raw?.contactId) return;
    const list = byContact.get(raw.contactId);
    const normalized = normalizeOpportunity(raw);
    if (list) list.push(normalized);
    else byContact.set(raw.contactId, [normalized]);
  };

  for (const pipeline of body.pipelines ?? []) {
    for (const stage of pipeline.stages ?? []) {
      for (const raw of stage.opportunities ?? []) push(raw);
    }
  }
  for (const raw of body.ungrouped ?? []) push(raw);

  return byContact;
}
