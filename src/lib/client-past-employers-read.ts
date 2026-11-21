/**
 * IO half of BRAND-PROOF-LOGOS-1121 (rules in `client-past-employers.ts`).
 *
 * READ (never spends): the brand's paying clients at (org, brand), the employment rows we hold on every lead of each
 * client's human, grouped into companies with their trace.
 *
 * FILL (spends, org-billed on the caller's run): for a paying client with NO employment row on any of their leads, the
 * cheapest path first: our stock (the human's other leads, already read), then treg `people.enrich` by email (only to
 * learn the LinkedIn profile when no lead of theirs holds one), then treg `linkedin.user.profile` for the experience
 * list, written through `recordEmploymentHistory` like any sourced career. Apollo is NEVER called here (owner
 * 2026-11-19: « je ne veux plus qu'on utilise Apollo autant que possible »). Each client is looked up ONCE
 * (`client_history_lookups`, keyed on the lead: a person's career is the person's, not the org's), a lookup that found
 * nothing is asked again after `LOOKUP_RETRY_AFTER_DAYS`; a call that failed (treg/network) records nothing and is
 * asked again on the next call. Idempotent, safe to call daily.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { STEP_REACHED_EVIDENCE, rowReaches } from "./step-reached.js";
import { assertCrmCopyCaughtUp } from "./step-reached-read.js";
import { isStaffEmail } from "./staff-identity.js";
import { groupPastEmployers, readProfileRoles, type EmploymentRow, type PastEmployerCompany } from "./client-past-employers.js";
import { InsufficientCreditError, TregMeter, isTregRefusal, type SpendIdentity } from "./treg-client.js";
import { readEnrichOutput } from "./named-lead-serve.js";
import { ENRICH_ENDPOINT } from "./relationship-company.js";
import { recordEmploymentHistory } from "./leads-registry.js";
import type { Person } from "./people-client.js";

export const PROFILE_ENDPOINT = "treg.linkedin.user.profile";
/** Ceiling per profile read ($0.01): the routed tool's providers answer $0.0012-$0.0042 a hit. */
export const PROFILE_MAX_MICRO = 10_000;
export const LOOKUP_RETRY_AFTER_DAYS = 90;
/**
 * One fill call stays inside a caller's 5 minutes: no client is STARTED past this budget, and a started one makes at
 * most two treg calls of 90 s each (treg-client CALL_TIMEOUT_MS), so 100 s + 180 s < 300 s.
 */
export const FILL_BUDGET_MS = 100_000;
export const FILL_MAX_CLIENTS = 40;
const FILL_CONCURRENCY = 4;

const PAID = STEP_REACHED_EVIDENCE.paid_client;

export interface PayingClient {
  leadId: string;
  name: string | null;
  email: string | null;
  linkedinUrl: string | null;
  paidAt: string | null;
}

/**
 * The brand's paying clients: leads holding a live attributed ledger sale/purchase at (org, brand), or a lead of the
 * brand holding the address of a CRM sale / standing payment of (org, brand). Not a person (`not_a_person_marks`) and
 * staff addresses are out. One row per lead.
 */
export async function loadPayingClients(orgId: string, brandId: string): Promise<PayingClient[]> {
  // A copy still filling would answer fewer payers than the brand has: refused (503), never a short list.
  await assertCrmCopyCaughtUp();
  const rows = (await db.execute(sql`
    SELECT ce.matched_lead_id::text AS lead_id, ce.event AS type, NULL::jsonb AS payload, ce.received_at AS at
    FROM conversion_events ce
    WHERE ce.org_id = ${orgId} AND ce.brand_id = ${brandId}
      AND ce.event = ANY(${sql.param([...PAID.ledgerEvents])}::text[])
      AND ce.withdrawn_at IS NULL AND ce.attribution_status = 'attributed' AND ce.matched_lead_id IS NOT NULL
    UNION ALL
    SELECT m.lead_id::text, f.type, f.payload, f.occurred_at
    FROM crm_facts f
    CROSS JOIN LATERAL unnest(f.emails) AS e(addr)
    JOIN lead_contact_methods m ON m.channel = 'email' AND lower(m.value) = lower(trim(e.addr))
    WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
      AND f.type = ANY(${sql.param([...PAID.crmFactTypes])}::text[])
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
      AND EXISTS (
        SELECT 1 FROM leads_campaigns lc
        WHERE lc.lead_id = m.lead_id AND lc.org_id = f.org_id AND f.brand_id = ANY(lc.brand_ids)
      )
  `)) as unknown as Array<{ lead_id: string; type: string; payload: Record<string, unknown> | null; at: RawTimestamp }>;

  const paidAt = new Map<string, string | null>();
  for (const r of rows) {
    if (!rowReaches({ emails: [], name: null, phones: [], at: null, type: r.type, payload: r.payload })) continue;
    const at = r.at === null ? null : toIsoTimestamp(r.at);
    const prior = paidAt.get(r.lead_id);
    if (!paidAt.has(r.lead_id) || (at !== null && (prior === null || prior === undefined || at < prior))) paidAt.set(r.lead_id, at);
  }
  if (paidAt.size === 0) return [];

  const ids = [...paidAt.keys()];
  const people = (await db.execute(sql`
    SELECT l.id::text AS lead_id, l.human_id::text AS human_id,
      NULLIF(trim(concat_ws(' ', l.first_name, l.last_name)), '') AS name,
      ARRAY(SELECT lower(cm.value) FROM lead_contact_methods cm
            WHERE cm.lead_id = l.id AND cm.channel = 'email' ORDER BY cm.created_at, cm.id) AS emails,
      ARRAY(SELECT lower(cm.value) FROM leads x JOIN lead_contact_methods cm ON cm.lead_id = x.id AND cm.channel = 'email'
            WHERE x.id <> l.id AND l.human_id IS NOT NULL AND x.human_id = l.human_id
            ORDER BY cm.created_at, cm.id) AS human_emails,
      (SELECT x.linkedin_url FROM leads x
        WHERE (x.id = l.id OR (l.human_id IS NOT NULL AND x.human_id = l.human_id)) AND x.linkedin_url IS NOT NULL
        ORDER BY (x.id = l.id) DESC LIMIT 1) AS linkedin_url,
      EXISTS (SELECT 1 FROM not_a_person_marks npm
              WHERE npm.org_id = ${orgId} AND npm.lead_id = l.id AND npm.withdrawn_at IS NULL) AS not_a_person
    FROM leads l
    WHERE l.id = ANY(${sql.param(ids)}::uuid[])
  `)) as unknown as PayingLeadRow[];

  return payingClientsOf(
    people.map((p) => ({ ...p, paid_at: paidAt.get(p.lead_id) ?? null })),
  );
}

export interface PayingLeadRow {
  lead_id: string;
  human_id: string | null;
  name: string | null;
  emails: string[] | null;
  /** Every address of the human's OTHER leads. */
  human_emails: string[] | null;
  linkedin_url: string | null;
  not_a_person: boolean;
  paid_at?: string | null;
}

/**
 * PURE. One paying client per PERSON (human-service's human; no human = the lead alone): the lead that paid first
 * holds the client (ties: lowest lead id). A person any of whose addresses (any lead of theirs) is staff is us, never
 * a client (Kevin's own human held 7 leads, 3 of them counted as payers). The lookup address is the client lead's
 * first non-staff address, else one of the human's other leads.
 */
export function payingClientsOf(rows: ReadonlyArray<PayingLeadRow & { paid_at: string | null }>): PayingClient[] {
  const byPerson = new Map<string, Array<PayingLeadRow & { paid_at: string | null }>>();
  for (const r of rows) {
    if (r.not_a_person) continue;
    const key = r.human_id ? `human:${r.human_id}` : `lead:${r.lead_id}`;
    byPerson.set(key, [...(byPerson.get(key) ?? []), r]);
  }
  const out: PayingClient[] = [];
  for (const group of byPerson.values()) {
    const all = group.flatMap((r) => [...(r.emails ?? []), ...(r.human_emails ?? [])]);
    if (all.some((e) => isStaffEmail(e))) continue;
    const sorted = [...group].sort(
      (a, b) =>
        (a.paid_at === null ? 1 : 0) - (b.paid_at === null ? 1 : 0) ||
        (a.paid_at ?? "").localeCompare(b.paid_at ?? "") ||
        a.lead_id.localeCompare(b.lead_id),
    );
    const holder = sorted[0];
    const own = holder.emails ?? [];
    out.push({
      leadId: holder.lead_id,
      name: holder.name ?? sorted.find((r) => r.name)?.name ?? null,
      email: own[0] ?? all[0] ?? null,
      linkedinUrl: holder.linkedin_url ?? sorted.find((r) => r.linkedin_url)?.linkedin_url ?? null,
      paidAt: holder.paid_at,
    });
  }
  return out.sort((a, b) => a.leadId.localeCompare(b.leadId));
}

/** Every role we hold on any lead of each client's human. */
export async function loadClientEmployment(clientLeadIds: readonly string[]): Promise<EmploymentRow[]> {
  if (clientLeadIds.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT c.client_lead_id::text AS client_lead_id, lo.lead_id::text AS lead_id, o.id::text AS organization_id,
      o.company_id::text AS company_id, o.name, o.primary_domain AS domain, o.logo_url, o.linkedin_url,
      lo.title, lo.start_date::text AS start_date, lo.end_date::text AS end_date, lo.current
    FROM unnest(${sql.param([...clientLeadIds])}::uuid[]) AS c(client_lead_id)
    JOIN leads l ON l.id = c.client_lead_id
    JOIN LATERAL (
      SELECT l.id
      UNION
      SELECT x.id FROM leads x WHERE l.human_id IS NOT NULL AND x.human_id = l.human_id
    ) AS h(id) ON true
    JOIN leads_organizations lo ON lo.lead_id = h.id
    JOIN organizations o ON o.id = lo.organization_id
  `)) as unknown as Array<{
    client_lead_id: string; lead_id: string; organization_id: string; company_id: string | null; name: string | null;
    domain: string | null; logo_url: string | null; linkedin_url: string | null; title: string | null;
    start_date: string | null; end_date: string | null; current: boolean;
  }>;
  return rows.map((r) => ({
    clientLeadId: r.client_lead_id,
    leadId: r.lead_id,
    organizationId: r.organization_id,
    companyId: r.company_id,
    name: r.name,
    domain: r.domain,
    logoUrl: r.logo_url,
    linkedinUrl: r.linkedin_url,
    title: r.title,
    startDate: r.start_date,
    endDate: r.end_date,
    current: r.current,
  }));
}

export type LookupStatus = "history_found" | "no_linkedin" | "no_experience" | "profile_unreadable";

interface LookupRow {
  lead_id: string;
  status: LookupStatus;
  looked_up_at: RawTimestamp;
}

async function loadLookups(leadIds: readonly string[]): Promise<Map<string, { status: LookupStatus; lookedUpAt: string }>> {
  if (leadIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT lead_id::text AS lead_id, status, looked_up_at FROM client_history_lookups
    WHERE lead_id = ANY(${sql.param([...leadIds])}::uuid[])
  `)) as unknown as LookupRow[];
  return new Map(rows.map((r) => [r.lead_id, { status: r.status, lookedUpAt: toIsoTimestamp(r.looked_up_at)! }]));
}

export type ClientHistoryState = "has_history" | "not_looked_up" | "looked_up_none";

export interface ClientPastEmployersAnswer {
  brandId: string;
  payingClients: number;
  clientsWithHistory: number;
  companyCount: number;
  /** Why `companies` is empty: `no_paying_clients` | `no_employment_history`; null when it is not. */
  reason: "no_paying_clients" | "no_employment_history" | null;
  companies: PastEmployerCompany[];
  clients: Array<{
    leadId: string;
    name: string | null;
    paidAt: string | null;
    history: ClientHistoryState;
    lookup: { status: LookupStatus; lookedUpAt: string } | null;
    companyKeys: string[];
  }>;
}

export async function readClientPastEmployers(orgId: string, brandId: string): Promise<ClientPastEmployersAnswer> {
  const clients = await loadPayingClients(orgId, brandId);
  const ids = clients.map((c) => c.leadId);
  const [rows, lookups] = await Promise.all([loadClientEmployment(ids), loadLookups(ids)]);
  const companies = groupPastEmployers(rows);
  const keysByClient = new Map<string, string[]>();
  for (const c of companies) for (const cl of c.clients) keysByClient.set(cl.leadId, [...(keysByClient.get(cl.leadId) ?? []), c.companyKey]);
  const withHistory = new Set(rows.map((r) => r.clientLeadId));
  return {
    brandId,
    payingClients: clients.length,
    clientsWithHistory: withHistory.size,
    companyCount: companies.length,
    reason: clients.length === 0 ? "no_paying_clients" : companies.length === 0 ? "no_employment_history" : null,
    companies,
    clients: clients.map((c) => {
      const lookup = lookups.get(c.leadId) ?? null;
      return {
        leadId: c.leadId,
        name: c.name,
        paidAt: c.paidAt,
        history: withHistory.has(c.leadId) ? "has_history" : lookup ? "looked_up_none" : "not_looked_up",
        lookup,
        companyKeys: keysByClient.get(c.leadId) ?? [],
      };
    }),
  };
}

export interface FillSummary {
  attempted: number;
  historyFound: number;
  noLinkedin: number;
  noExperience: number;
  profileUnreadable: number;
  failed: number;
  /** Clients still owed a lookup after this call (budget or failures): call again. */
  remaining: number;
  chargedMicro: number;
}

/** PURE. Who is owed a lookup now: no history, and no lookup or a non-finding one older than the retry window. */
export function clientsToLookUp(
  clients: readonly PayingClient[],
  withHistory: ReadonlySet<string>,
  lookups: ReadonlyMap<string, { status: LookupStatus; lookedUpAt: string }>,
  now: Date,
): PayingClient[] {
  const retryBefore = now.getTime() - LOOKUP_RETRY_AFTER_DAYS * 86_400_000;
  return clients.filter((c) => {
    if (withHistory.has(c.leadId)) return false;
    if (!c.email && !c.linkedinUrl) return false;
    const l = lookups.get(c.leadId);
    if (!l) return true;
    return l.status !== "history_found" && Date.parse(l.lookedUpAt) < retryBefore;
  });
}

async function recordLookup(p: {
  leadId: string; identity: SpendIdentity; status: LookupStatus; linkedinUrl: string | null; chargedMicro: number;
  servedBy: string | null; roles: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO client_history_lookups (lead_id, paid_by_org_id, run_id, status, linkedin_url, roles_found, charged_micro, served_by, looked_up_at)
    VALUES (${p.leadId}::uuid, ${p.identity.orgId}, ${p.identity.runId}, ${p.status}, ${p.linkedinUrl}, ${p.roles}, ${p.chargedMicro}, ${p.servedBy}, now())
    ON CONFLICT (lead_id) DO UPDATE SET
      paid_by_org_id = EXCLUDED.paid_by_org_id, run_id = EXCLUDED.run_id, status = EXCLUDED.status,
      linkedin_url = EXCLUDED.linkedin_url, roles_found = EXCLUDED.roles_found,
      charged_micro = client_history_lookups.charged_micro + EXCLUDED.charged_micro,
      served_by = EXCLUDED.served_by, looked_up_at = now()
  `);
}

function servedByOf(body: unknown): string | null {
  const v = (body as { _treg?: { served_by?: unknown } } | null)?._treg?.served_by;
  return typeof v === "string" ? v : null;
}

export class TransientLookupError extends Error {}

/** A metered treg call (the caller's `TregMeter.call`), injectable for tests. */
export type TregCall = TregMeter["call"];

/**
 * Providers treg must never route a career lookup to: Apollo (owner 2026-11-19: « je ne veux plus qu'on utilise Apollo
 * autant que possible »). Sent on every routed call as `X-Treg-Route-Exclude`, whatever the ceiling.
 */
export const NEVER_ROUTE_TO: readonly string[] = ["apollo"];
/**
 * Ceiling of ONE routed `people.enrich` call (the whole waterfall). The $0.003 of the serve path only reaches the
 * four cheapest email providers, which knew none of distribute.you's 25 payers (2026-11-21: 24 misses, 1 hit without
 * a profile); the providers that do (companyenrich $0.049 a hit) sit higher. Misses are free.
 */
export const CAREER_ENRICH_MAX_MICRO = 60_000;
/** A hit naming the person but no LinkedIn profile is asked again WITHOUT that provider, at most this many calls. */
export const CAREER_ENRICH_ROUNDS = 3;
/** What ONE client's lookup may spend in total, every call included ($0.15). */
export const CAREER_LOOKUP_MAX_MICRO = 150_000;

/** The provider a routed answer was served by (`_treg.tried[].provider` of the hit), or null on a miss. */
export function servedProviderOf(body: unknown): string | null {
  const t = (body as { _treg?: { served_by?: unknown; tried?: unknown } } | null)?._treg;
  const servedBy = typeof t?.served_by === "string" ? t.served_by : null;
  if (!servedBy) return null;
  const tried = Array.isArray(t?.tried) ? (t!.tried as Array<Record<string, unknown>>) : [];
  const hit = tried.find((x) => x && x.endpoint_id === servedBy && typeof x.provider === "string");
  return hit ? (hit.provider as string) : servedBy.split(".")[0] || null;
}

/** Status of a routed answer that IS treg's answer: 200 (hit or miss). Anything else = nothing learnt. */
function isAnswer(status: number): boolean {
  return status === 200;
}

export interface EmailLookupAnswer {
  linkedinUrl: string | null;
  /** The current employer an answer named, when no profile was found (a logo too: « pas forcément les actuelles »). */
  employer: { name: string; domain: string | null; title: string | null } | null;
  charged: number;
}

/**
 * Who this email belongs to, through treg's routed `people.enrich` (Apollo excluded). Only a 200 is an answer; a
 * refusal, an error, a pending task or a timeout THROWS (`TransientLookupError`, or the meter's own error) so the
 * caller records nothing and asks again on the next call. A hit with no profile is asked again without its provider.
 */
export async function findProfileByEmail(email: string, call: TregCall): Promise<EmailLookupAnswer> {
  let charged = 0;
  let employer: EmailLookupAnswer["employer"] = null;
  const exclude = [...NEVER_ROUTE_TO];
  for (let round = 0; round < CAREER_ENRICH_ROUNDS; round++) {
    const maxMicro = Math.min(CAREER_ENRICH_MAX_MICRO, CAREER_LOOKUP_MAX_MICRO - charged);
    if (maxMicro <= 0) break;
    const r = await call({ endpointId: ENRICH_ENDPOINT, method: "POST", params: { email }, maxMicro, routeExclude: [...exclude] });
    charged += r.chargedMicro;
    if (!isAnswer(r.status)) throw new TransientLookupError(`people.enrich answered ${r.status} (charged ${charged} micro-USD so far)`);
    const found = readEnrichOutput(r.body);
    if (found.linkedinUrl) return { linkedinUrl: found.linkedinUrl, employer, charged };
    if (!employer && found.companyName) employer = { name: found.companyName, domain: found.companyDomain, title: found.title };
    const provider = servedProviderOf(r.body);
    if (!provider) break; // every provider within the ceiling missed: a real « nobody knows this address »
    exclude.push(provider);
  }
  return { linkedinUrl: null, employer, charged };
}

/** Look one client up. Throws InsufficientCreditError (stop the pass) or TransientLookupError (nothing recorded). */
async function lookUpOne(client: PayingClient, call: TregCall, identity: SpendIdentity): Promise<{ status: LookupStatus; charged: number }> {
  let charged = 0;
  let linkedinUrl = client.linkedinUrl;
  if (!linkedinUrl && client.email) {
    const found = await findProfileByEmail(client.email, call);
    charged += found.charged;
    linkedinUrl = found.linkedinUrl;
    if (linkedinUrl) {
      await db.execute(sql`UPDATE leads SET linkedin_url = COALESCE(linkedin_url, ${linkedinUrl}) WHERE id = ${client.leadId}::uuid`);
    } else if (found.employer) {
      await recordEmploymentHistory({
        leadId: client.leadId,
        person: {
          firstName: null, lastName: null, name: null, title: found.employer.title, email: client.email,
          organization: {
            name: found.employer.name, domain: found.employer.domain, websiteUrl: null, industry: null, estimatedNumEmployees: null,
            annualRevenue: null, linkedinUrl: null, logoUrl: null, city: null, state: null, country: null,
          },
          employmentHistory: [],
        } as unknown as Person,
      });
    }
  }
  if (!linkedinUrl) {
    await recordLookup({ leadId: client.leadId, identity, status: "no_linkedin", linkedinUrl: null, chargedMicro: charged, servedBy: null, roles: 0 });
    return { status: "no_linkedin", charged };
  }
  const p = await call({ endpointId: PROFILE_ENDPOINT, method: "POST", params: { linkedin_url: linkedinUrl }, maxMicro: PROFILE_MAX_MICRO, routeExclude: NEVER_ROUTE_TO });
  charged += p.chargedMicro;
  // Only the PROVIDER saying it has no readable profile (404/410/422, not treg's own refusal) is a final answer.
  const providerHasNone = (p.status === 404 || p.status === 410 || p.status === 422) && !isTregRefusal(p.status, p.body);
  if (!isAnswer(p.status) && !providerHasNone) throw new TransientLookupError(`linkedin.user.profile answered ${p.status}`);
  if (providerHasNone) {
    await recordLookup({ leadId: client.leadId, identity, status: "profile_unreadable", linkedinUrl, chargedMicro: charged, servedBy: servedByOf(p.body), roles: 0 });
    return { status: "profile_unreadable", charged };
  }
  const roles = readProfileRoles(p.body);
  if (roles.length === 0) {
    await recordLookup({ leadId: client.leadId, identity, status: "no_experience", linkedinUrl, chargedMicro: charged, servedBy: servedByOf(p.body), roles: 0 });
    return { status: "no_experience", charged };
  }
  const current = roles.find((r) => r.current) ?? null;
  const person = {
    firstName: null,
    lastName: null,
    name: null,
    title: current?.title ?? null,
    email: client.email,
    organization: current
      ? {
          name: current.organizationName, domain: null, websiteUrl: null, industry: null, estimatedNumEmployees: null,
          annualRevenue: null, linkedinUrl: current.companyLinkedinUrl, logoUrl: null, city: null, state: null, country: null,
        }
      : null,
    employmentHistory: roles.map((r) => ({
      organizationName: r.organizationName, title: r.title, startDate: r.startDate, endDate: r.endDate, current: r.current, description: null,
    })),
  } as unknown as Person;
  await recordEmploymentHistory({ leadId: client.leadId, person });
  await recordLookup({ leadId: client.leadId, identity, status: "history_found", linkedinUrl, chargedMicro: charged, servedBy: servedByOf(p.body), roles: roles.length });
  return { status: "history_found", charged };
}

/** Fill missing careers of the brand's paying clients, within one call's budget. */
export async function fillClientHistories(identity: SpendIdentity, brandId: string, now = new Date()): Promise<FillSummary> {
  const clients = await loadPayingClients(identity.orgId, brandId);
  const ids = clients.map((c) => c.leadId);
  const [rows, lookups] = await Promise.all([loadClientEmployment(ids), loadLookups(ids)]);
  const owed = clientsToLookUp(clients, new Set(rows.map((r) => r.clientLeadId)), lookups, now);
  const summary: FillSummary = { attempted: 0, historyFound: 0, noLinkedin: 0, noExperience: 0, profileUnreadable: 0, failed: 0, remaining: 0, chargedMicro: 0 };
  const meter = new TregMeter({ ...identity, brandId });
  const deadline = Date.now() + FILL_BUDGET_MS;
  const queue = owed.slice(0, FILL_MAX_CLIENTS);
  let creditError: InsufficientCreditError | null = null;
  const worker = async () => {
    while (queue.length > 0 && Date.now() < deadline && !creditError) {
      const client = queue.shift()!;
      summary.attempted += 1;
      try {
        const r = await lookUpOne(client, (req) => meter.call(req), identity);
        summary.chargedMicro += r.charged;
        if (r.status === "history_found") summary.historyFound += 1;
        else if (r.status === "no_linkedin") summary.noLinkedin += 1;
        else if (r.status === "no_experience") summary.noExperience += 1;
        else summary.profileUnreadable += 1;
      } catch (error) {
        if (error instanceof InsufficientCreditError) {
          creditError = error;
          summary.failed += 1;
          return;
        }
        summary.failed += 1;
        console.error(`[lead-service] client past employers: lookup failed lead=${client.leadId}:`, (error as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: FILL_CONCURRENCY }, worker));
  if (creditError) throw creditError;
  summary.remaining = owed.length - summary.attempted + summary.failed;
  return summary;
}
