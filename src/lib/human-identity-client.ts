/**
 * human-service's fleet-wide human identity (owner 2026-10-13, LEAD-REFONTE-1013): WHO a person is
 * is decided there, never here. A lead is a human at a company; this client only asks.
 *
 * Contract (human-service `src/routes/human-identities.ts`, internal, service key):
 *   POST /internal/human-identities/resolve  {emails?, phones?, linkedinUrls?, providerPersonIds?,
 *        source, create, orgId?} -> {humanId, atomicHumanId, created, mergedHumanIds, separatedHumanIds}
 *        The keys given together are ONE contact; a shared email/phone merges humans fleet-wide.
 *   GET  /internal/human-identities/{humanId}[?orgId] -> the human (keys, ACTIVE facts, links);
 *        a merged-away id answers with the human it is now; 404 unknown.
 *   POST /internal/human-identities/{humanId}/facts {kind: opt_out|do_not_contact, source, evidence,
 *        statedByOrgId?, statedAt?} -> {changed, fact}
 *   GET  /internal/human-identities/events?after&limit[&orgId] -> {events, nextCursor, hasMore}
 *
 * Every call goes through `fetchWithRetry` (connect-phase retry) and FAILS LOUD: a non-2xx throws
 * `HumanIdentityError` with the status, never an empty answer.
 */
import { HUMAN_SERVICE_URL, HUMAN_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

/** The source token human-service records on keys and facts this service states. */
export const HUMAN_IDENTITY_SOURCE = "lead-service";

export class HumanIdentityError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HumanIdentityError";
  }
}

export interface ResolveHumanInput {
  emails?: string[];
  phones?: string[];
  linkedinUrls?: string[];
  providerPersonIds?: Array<{ provider: "apollo" | "apify"; id: string }>;
  create: boolean;
  /** Omitted = the fleet view (a lead row is global: orgs share it). */
  orgId?: string;
}

export interface ResolvedHuman {
  humanId: string | null;
  atomicHumanId: string | null;
  created: boolean;
  mergedHumanIds: string[];
  separatedHumanIds: string[];
}

export interface HumanFactView {
  factId: string;
  humanId: string;
  kind: string;
  statedByOrgId: string | null;
  source: string;
  evidence: string;
  statedAt: string;
}

export interface HumanView {
  humanId: string;
  memberHumanIds: string[];
  emails: string[];
  phones: string[];
  facts: HumanFactView[];
}

export type HumanFactKind = "opt_out" | "do_not_contact";

export interface HumanEvent {
  id: string;
  type: string;
  orgId: string | null;
  humanIds: string[];
  data: Record<string, unknown>;
  createdAt: string;
}

export interface HumanEventsPage {
  events: HumanEvent[];
  nextCursor: string;
  hasMore: boolean;
}

const RESOLVE_TIMEOUT_MS = 30_000;

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetchWithRetry(`${HUMAN_SERVICE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-API-Key": HUMAN_SERVICE_API_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HumanIdentityError(`human-service ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

/** The human these keys are (one contact). Throws on any non-2xx (a 400 names an unusable key). */
export async function resolveHuman(input: ResolveHumanInput): Promise<ResolvedHuman> {
  const body: Record<string, unknown> = { source: HUMAN_IDENTITY_SOURCE, create: input.create };
  if (input.emails?.length) body.emails = input.emails.slice(0, 50);
  if (input.phones?.length) body.phones = input.phones.slice(0, 50);
  if (input.linkedinUrls?.length) body.linkedinUrls = input.linkedinUrls.slice(0, 10);
  if (input.providerPersonIds?.length) body.providerPersonIds = input.providerPersonIds.slice(0, 10);
  if (input.orgId) body.orgId = input.orgId;
  return call<ResolvedHuman>("POST", "/internal/human-identities/resolve", body);
}

/** One human in the fleet view; null when human-service does not know the id (404). */
export async function getHuman(humanId: string): Promise<HumanView | null> {
  try {
    return await call<HumanView>("GET", `/internal/human-identities/${encodeURIComponent(humanId)}`);
  } catch (err) {
    if (err instanceof HumanIdentityError && err.status === 404) return null;
    throw err;
  }
}

/** State a fact carried on the human wherever they work (opt-out follows them to every company). */
export async function stateHumanFact(
  humanId: string,
  fact: { kind: HumanFactKind; evidence: string; statedByOrgId?: string | null; statedAt?: string | null },
): Promise<{ changed: boolean; fact: HumanFactView }> {
  const body: Record<string, unknown> = { kind: fact.kind, source: HUMAN_IDENTITY_SOURCE, evidence: fact.evidence };
  if (fact.statedByOrgId) body.statedByOrgId = fact.statedByOrgId;
  if (fact.statedAt) body.statedAt = fact.statedAt;
  return call("POST", `/internal/human-identities/${encodeURIComponent(humanId)}/facts`, body);
}

/** The FLEET events after a cursor (no orgId: a lead row is global, so only fleet merges fold it). */
export async function listHumanEvents(after: string, limit = 500): Promise<HumanEventsPage> {
  const q = new URLSearchParams({ after, limit: String(limit) });
  return call<HumanEventsPage>("GET", `/internal/human-identities/events?${q.toString()}`);
}

/** Withdraw a fact this service stated (its source was taken back). Idempotent at human-service. */
export async function withdrawHumanFact(factId: string, reason: string): Promise<void> {
  await call("POST", `/internal/human-identities/facts/${encodeURIComponent(factId)}/withdraw`, {
    withdrawnBy: HUMAN_IDENTITY_SOURCE,
    reason,
  });
}

/** One human as an ORG sees it (fleet links + that org's own judgment links); null when unknown (404). */
export async function getHumanInOrg(humanId: string, orgId: string): Promise<HumanView | null> {
  try {
    return await call<HumanView>("GET", `/internal/human-identities/${encodeURIComponent(humanId)}?orgId=${encodeURIComponent(orgId)}`);
  } catch (err) {
    if (err instanceof HumanIdentityError && err.status === 404) return null;
    throw err;
  }
}

export interface HumanLinkView {
  linkId: string;
  relation: "same" | "distinct";
  scope: "fleet" | "org";
  orgId: string | null;
  humanIds: string[];
  judgedBy: string;
}

/**
 * State that two humans are (`same`) or are not (`distinct`) one person, in ONE org's view (a judgment
 * never merges the fleet). `judgedBy` = "jev" or "person:<userId>". `link` null = already one human.
 */
export async function stateHumanLink(input: {
  orgId: string;
  relation: "same" | "distinct";
  humanIds: [string, string];
  judgedBy: string;
  evidence: string;
}): Promise<{ changed: boolean; link: HumanLinkView | null; humanIds: string[] }> {
  return call("POST", "/internal/human-identities/links", {
    orgId: input.orgId,
    relation: input.relation,
    humanIds: input.humanIds,
    judgedBy: input.judgedBy,
    statedBy: HUMAN_IDENTITY_SOURCE,
    evidence: input.evidence,
  });
}

/** Undo an org link (the org that stated it). Idempotent at human-service. */
export async function withdrawHumanLink(linkId: string, orgId: string, withdrawnBy: string, reason: string): Promise<{ changed: boolean }> {
  return call("POST", `/internal/human-identities/links/${encodeURIComponent(linkId)}/withdraw`, { orgId, withdrawnBy, reason });
}
