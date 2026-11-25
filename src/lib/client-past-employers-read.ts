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
 *
 * THE BRAND'S TEAM (TEAM-PAST-EMPLOYERS-1125) is read and filled the same way (`loadTeam`): members of the org owning
 * the brand (client-service) plus relations whose DECIDED tags hold `team`, each held by a lead (the one holding their
 * address, else their human's, else their phone's). The FILL creates a global lead row for a member with none (no
 * `leads_campaigns` row: never a lead of any brand); the READ never writes and lists such a member with `leadId: null`.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { STEP_REACHED_EVIDENCE, rowReaches } from "./step-reached.js";
import { assertCrmCopyCaughtUp } from "./step-reached-read.js";
import { isStaffEmail } from "./staff-identity.js";
import {
  companyPageOf, emptyReasonOf, groupPastEmployers, payingClientsNotTeam, readProfileRoles, teamCandidatesOf,
  type EmploymentRow, type PastEmployerCompany, type PersonRole, type ProfileRole, type TaggedTeamPerson, type TeamCandidate,
} from "./client-past-employers.js";
import { loadOrgMembers, memberAddressKey } from "./org-members.js";
import { loadRelationships } from "./relationship-read.js";
import { canonicalE164 } from "./e164-phone.js";
import { InsufficientCreditError, TregMeter, isTregRefusal, type SpendIdentity } from "./treg-client.js";
import { readEnrichOutput } from "./named-lead-serve.js";
import { ENRICH_ENDPOINT } from "./relationship-company.js";
import { recordEmploymentHistory, registerServedEmail, registerServedPhone, upsertLeadFromPerson } from "./leads-registry.js";
import type { Person } from "./people-client.js";

export const PROFILE_ENDPOINT = "treg.linkedin.user.profile";
/** Ceiling per profile read ($0.01): the routed tool's providers answer $0.0012-$0.0042 a hit. */
export const PROFILE_MAX_MICRO = 10_000;
export const LOOKUP_RETRY_AFTER_DAYS = 90;
/**
 * What a stored lookup recorded. 2 = each role's employer carries the LinkedIn company page its experience entry names
 * (BRAND-PROOF-LOGOS-1121: name-only employers are refused by brand-service's proof store). A career found by an older
 * version than `PAGES_VERSION` is read again once (its profile is re-read, the enrich step is not repeated: the lead
 * holds the profile URL). 3 = a profile the cheap providers could not read is asked once more of the dearer ones
 * (`CAREER_PROFILE_DEEP_MAX_MICRO`): a « no experience » / « unreadable » recorded before it is asked again once.
 */
export const LOOKUP_VERSION = 3;
export const PAGES_VERSION = 2;
export const DEEP_PROFILE_VERSION = 3;
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
  /** Every paying lead row folded into this person (the holder included), sorted. */
  memberLeadIds: string[];
  name: string | null;
  email: string | null;
  /**
   * Every address of the person to ask the email-to-profile step by, in order (`email` first): one provider knows a
   * person by an address another does not. `+tag` variants of one mailbox are asked once. Absent = `email` alone.
   */
  lookupEmails?: string[];
  /** An E.164 phone of the person, looked up only when no email and no profile is held. */
  phone: string | null;
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
    SELECT ce.matched_lead_id::text AS lead_id, ce.event AS type, NULL::jsonb AS payload, ce.received_at AS at,
      NULL::text AS fact_id
    FROM conversion_events ce
    WHERE ce.org_id = ${orgId} AND ce.brand_id = ${brandId}
      AND ce.event = ANY(${sql.param([...PAID.ledgerEvents])}::text[])
      AND ce.withdrawn_at IS NULL AND ce.attribution_status = 'attributed' AND ce.matched_lead_id IS NOT NULL
    UNION ALL
    SELECT m.lead_id::text, f.type, f.payload, f.occurred_at, f.fact_id::text
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
  `)) as unknown as Array<{ lead_id: string; type: string; payload: Record<string, unknown> | null; at: RawTimestamp; fact_id: string | null }>;

  const paidAt = new Map<string, string | null>();
  // The leads ONE paid fact names together (one payment stated under two addresses of the same payer).
  const leadsByFact = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!rowReaches({ emails: [], name: null, phones: [], at: null, type: r.type, payload: r.payload })) continue;
    if (r.fact_id) leadsByFact.set(r.fact_id, (leadsByFact.get(r.fact_id) ?? new Set()).add(r.lead_id));
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
      (SELECT cm.value FROM lead_contact_methods cm
        WHERE cm.lead_id = l.id AND cm.channel = 'phone' AND cm.value LIKE '+%' ORDER BY cm.created_at, cm.id LIMIT 1) AS phone,
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
    [...leadsByFact.values()].filter((s) => s.size > 1).map((s) => [...s]),
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
  phone?: string | null;
  not_a_person: boolean;
  paid_at?: string | null;
}

/**
 * PURE. One paying client per PERSON. Two paying leads are one person when (1) human-service names the same human
 * (`leads.human_id`), (2) ONE paid fact names both (a payment stated under two addresses of its payer: `coPaid`), or
 * (3) both hold the same LinkedIn member profile (a profile is one person's own page). Nothing is written: this only
 * keeps a payer from counting twice (prod 2026-11-22: one payer's payments named two gmail addresses, two humans;
 * another's two addresses both led to one profile). The lead that paid first holds the client (ties: lowest lead id).
 * A person any of whose addresses (any lead of theirs) is staff is us, never a client (Kevin's own human held 7
 * leads, 3 of them counted as payers). The lookup address is the holder's first address, else another lead's.
 */
export function payingClientsOf(
  rows: ReadonlyArray<PayingLeadRow & { paid_at: string | null }>,
  coPaid: ReadonlyArray<readonly string[]> = [],
): PayingClient[] {
  const live = rows.filter((r) => !r.not_a_person);
  const parent = new Map<string, string>(live.map((r) => [r.lead_id, r.lead_id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const firstBy = new Map<string, string>();
  for (const r of live) {
    const keys = [
      r.human_id ? `human:${r.human_id}` : null,
      r.linkedin_url && linkedinHandleOf(r.linkedin_url) ? `in:${linkedinHandleOf(r.linkedin_url)!.toLowerCase()}` : null,
    ];
    for (const k of keys) {
      if (!k) continue;
      const seen = firstBy.get(k);
      if (seen) union(seen, r.lead_id);
      else firstBy.set(k, r.lead_id);
    }
  }
  for (const group of coPaid) for (const id of group.slice(1)) union(group[0], id);

  const byPerson = new Map<string, Array<PayingLeadRow & { paid_at: string | null }>>();
  for (const r of live) {
    const key = find(r.lead_id);
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
    const others = sorted.slice(1).flatMap((r) => r.emails ?? []);
    out.push({
      leadId: holder.lead_id,
      memberLeadIds: sorted.map((r) => r.lead_id).sort(),
      name: holder.name ?? sorted.find((r) => r.name)?.name ?? null,
      email: own[0] ?? others[0] ?? all[0] ?? null,
      lookupEmails: Array.from(new Set([...own, ...others, ...all])),
      phone: holder.phone ?? sorted.find((r) => r.phone)?.phone ?? null,
      linkedinUrl: holder.linkedin_url ?? sorted.find((r) => r.linkedin_url)?.linkedin_url ?? null,
      paidAt: holder.paid_at,
    });
  }
  return out.sort((a, b) => a.leadId.localeCompare(b.leadId));
}

/** Every role we hold on any lead of each client (every folded member and each member's human). */
export async function loadClientEmployment(
  clients: ReadonlyArray<Pick<PayingClient, "leadId" | "memberLeadIds"> & { role?: PersonRole }>,
): Promise<EmploymentRow[]> {
  const roleOf = new Map(clients.map((c) => [c.leadId, c.role ?? "paying_client"] as const));
  const pairs = clients.flatMap((c) => (c.memberLeadIds.length > 0 ? c.memberLeadIds : [c.leadId]).map((m) => [c.leadId, m] as const));
  if (pairs.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT DISTINCT c.client_lead_id::text AS client_lead_id, lo.lead_id::text AS lead_id, o.id::text AS organization_id,
      o.company_id::text AS company_id, o.name, o.primary_domain AS domain, o.logo_url, o.linkedin_url,
      lo.title, lo.start_date::text AS start_date, lo.end_date::text AS end_date, lo.current
    FROM unnest(${sql.param(pairs.map((p) => p[0]))}::uuid[], ${sql.param(pairs.map((p) => p[1]))}::uuid[]) AS c(client_lead_id, member_id)
    JOIN leads l ON l.id = c.member_id
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
    role: roleOf.get(r.client_lead_id) ?? "paying_client",
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

/** A person whose career counts: a paying client or a team member, held by a lead. */
export type CareerPerson = PayingClient & { role: PersonRole };

export interface TeamMember extends PayingClient {
  role: "team";
  /** The relationship humans tagged team that are this person, plus the humans of their leads. */
  humanIds: string[];
}

export interface BrandTeam {
  /** Team members held by a lead, sorted by lead id. */
  members: TeamMember[];
  /** Team members no lead holds (a READ never creates one; a member with no address and no E.164 phone cannot be held). */
  unheld: Array<{ name: string | null }>;
  /** `leads.human_id` of every team lead. */
  humanOfLead: Map<string, string | null>;
}

/** Relations of the brand whose DECIDED tags hold `team` (yes, never unsure), with their subject rows' addresses. */
async function loadTaggedTeam(orgId: string, brandId: string): Promise<TaggedTeamPerson[]> {
  const candidates = (await db.execute(sql`
    SELECT human_id::text AS human_id FROM relationship_statements
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND tag = 'team' AND state = 'yes' AND withdrawn_at IS NULL
    UNION
    SELECT human_id::text FROM relationship_evidence WHERE org_id = ${orgId} AND brand_id = ${brandId} AND tag = 'team'
    UNION
    SELECT human_id::text FROM relationship_judgments
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND (probabilities->>'team')::float8 >= 0.5
  `)) as unknown as Array<{ human_id: string }>;
  if (candidates.length === 0) return [];
  const blocks = await loadRelationships(orgId, brandId, candidates.map((c) => c.human_id));
  const humans = candidates.map((c) => c.human_id).filter((h) => blocks.get(h)?.tags.includes("team"));
  if (humans.length === 0) return [];
  const subjects = (await db.execute(sql`
    SELECT s.human_id::text AS human, s.name, s.emails, s.phones FROM relationship_subjects s
    WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId} AND s.human_id = ANY(${sql.param(humans)}::uuid[])
    ORDER BY s.human_id, s.company_key
  `)) as unknown as Array<{ human: string; name: string | null; emails: string[] | null; phones: string[] | null }>;
  const held = new Set(subjects.map((r) => r.human));
  return [
    ...subjects.map((r) => ({ humanId: r.human, name: r.name, emails: r.emails ?? [], phones: r.phones ?? [] })),
    ...humans.filter((h) => !held.has(h)).map((h) => ({ humanId: h, name: null, emails: [], phones: [] })),
  ];
}

/** A global lead row for a team member no lead holds: never a `leads_campaigns` row, so never a lead of any brand. */
async function createTeamLead(c: TeamCandidate): Promise<string | null> {
  const email = c.emails[0] ?? null;
  const phone = c.phones.map((p) => canonicalE164(p)).find((p): p is string => p !== null) ?? null;
  if (!email && !phone) return null;
  const [first, ...rest] = (c.name ?? "").trim().split(/\s+/).filter(Boolean);
  const person = {
    firstName: c.firstName ?? first ?? null,
    lastName: c.lastName ?? (rest.length > 0 ? rest.join(" ") : null),
    name: c.name,
    email,
    ...(email ? {} : { phone }),
  } as unknown as Person;
  const leadId = await upsertLeadFromPerson(person, { enriched: false });
  const source = c.source === "org_member" ? "org_member" : "team_relation";
  return email ? registerServedEmail({ leadId, email, status: null, source }) : registerServedPhone({ leadId, phone: phone!, source });
}

/**
 * The brand's team, each member held by a lead: the lead holding one of their addresses, plus their human's leads
 * (tagged relations), else the lead holding their E.164 phone; `create` (the FILL only) makes a lead for a member with
 * none. Every lead of the same human as one of those is the member's too. client-service unreadable throws
 * `OrgMembersUnavailableError`: never "nobody is a member".
 */
export async function loadTeam(orgId: string, brandId: string, options: { create: boolean }): Promise<BrandTeam> {
  const [members, tagged] = await Promise.all([loadOrgMembers(orgId), loadTaggedTeam(orgId, brandId)]);
  const candidates = teamCandidatesOf(members, tagged);
  if (candidates.length === 0) return { members: [], unheld: [], humanOfLead: new Map() };

  const emails = Array.from(new Set(candidates.flatMap((c) => c.emails)));
  const phoneOf = (c: TeamCandidate) => c.phones.map((p) => canonicalE164(p)).filter((p): p is string => p !== null);
  const phones = Array.from(new Set(candidates.flatMap(phoneOf)));
  const humans = Array.from(new Set(candidates.flatMap((c) => c.humanIds)));
  const [byEmail, byPhone, atomics] = await Promise.all([
    emails.length === 0
      ? []
      : (db.execute(sql`
          SELECT lower(cm.value) AS key, cm.lead_id::text AS lead_id FROM lead_contact_methods cm
          WHERE cm.channel = 'email' AND lower(cm.value) = ANY(${sql.param(emails)}::text[])
        `) as unknown as Promise<Array<{ key: string; lead_id: string }>>),
    phones.length === 0
      ? []
      : (db.execute(sql`
          SELECT cm.value AS key, cm.lead_id::text AS lead_id FROM lead_contact_methods cm
          WHERE cm.channel = 'phone' AND cm.value = ANY(${sql.param(phones)}::text[])
        `) as unknown as Promise<Array<{ key: string; lead_id: string }>>),
    // A relationship human is the ORG's view of a person: the leads of every atomic human folded into it are theirs.
    humans.length === 0
      ? []
      : (db.execute(sql`
          SELECT h.id::text AS human, h.id::text AS atomic FROM unnest(${sql.param(humans)}::uuid[]) AS h(id)
          UNION
          SELECT o.human_id::text, o.atomic_human_id::text FROM org_human_aliases o
          WHERE o.org_id = ${orgId} AND o.human_id = ANY(${sql.param(humans)}::uuid[])
          UNION
          SELECT a.human_id::text, a.atomic_human_id::text FROM human_aliases a WHERE a.human_id = ANY(${sql.param(humans)}::uuid[])
        `) as unknown as Promise<Array<{ human: string; atomic: string }>>),
  ]);
  const humanLeads =
    atomics.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT l.id::text AS lead_id, l.human_id::text AS atomic FROM leads l
          WHERE l.human_id = ANY(${sql.param(Array.from(new Set(atomics.map((a) => a.atomic))))}::uuid[])
        `)) as unknown as Array<{ lead_id: string; atomic: string }>);
  const leadsOfKey = (rows: ReadonlyArray<{ key: string; lead_id: string }>, keys: readonly string[]) =>
    rows.filter((r) => keys.includes(r.key)).map((r) => r.lead_id);

  const held: Array<{ candidate: TeamCandidate; leadIds: string[] }> = [];
  const unheld: BrandTeam["unheld"] = [];
  for (const c of candidates) {
    const atomicOfMine = new Set(atomics.filter((a) => c.humanIds.includes(a.human)).map((a) => a.atomic));
    let leadIds = [...leadsOfKey(byEmail, c.emails), ...humanLeads.filter((l) => atomicOfMine.has(l.atomic)).map((l) => l.lead_id)];
    if (leadIds.length === 0) leadIds = leadsOfKey(byPhone, phoneOf(c));
    if (leadIds.length === 0 && options.create) {
      const created = await createTeamLead(c);
      if (created) leadIds = [created];
    }
    if (leadIds.length === 0) unheld.push({ name: c.name });
    else held.push({ candidate: c, leadIds: Array.from(new Set(leadIds)) });
  }
  if (held.length === 0) return { members: [], unheld, humanOfLead: new Map() };

  // Every lead of the same human as a held lead is the member's too (a job change is a new lead row).
  const details = (await db.execute(sql`
    WITH own AS (SELECT l.id, l.human_id FROM leads l WHERE l.id = ANY(${sql.param(held.flatMap((h) => h.leadIds))}::uuid[]))
    SELECT DISTINCT l.id::text AS lead_id, l.human_id::text AS human_id,
      NULLIF(trim(concat_ws(' ', l.first_name, l.last_name)), '') AS name, l.linkedin_url,
      (SELECT lower(cm.value) FROM lead_contact_methods cm
        WHERE cm.lead_id = l.id AND cm.channel = 'email' ORDER BY cm.created_at, cm.id LIMIT 1) AS email,
      (SELECT cm.value FROM lead_contact_methods cm
        WHERE cm.lead_id = l.id AND cm.channel = 'phone' AND cm.value LIKE '+%' ORDER BY cm.created_at, cm.id LIMIT 1) AS phone
    FROM leads l
    WHERE l.id IN (SELECT id FROM own)
       OR l.human_id IN (SELECT human_id FROM own WHERE human_id IS NOT NULL)
  `)) as unknown as Array<{ lead_id: string; human_id: string | null; name: string | null; linkedin_url: string | null; email: string | null; phone: string | null }>;
  const detailOf = new Map(details.map((d) => [d.lead_id, d]));
  const humanOfLead = new Map(details.map((d) => [d.lead_id, d.human_id]));

  // Two candidates one lead (or one human) holds are one person: folded into the first.
  const people: Array<{ candidate: TeamCandidate; holder: string; leadIds: Set<string>; humanIds: Set<string> }> = [];
  for (const h of held) {
    const leadHumans = new Set(h.leadIds.map((l) => humanOfLead.get(l) ?? null).filter((x): x is string => Boolean(x)));
    const leadIds = new Set([...h.leadIds, ...details.filter((d) => d.human_id && leadHumans.has(d.human_id)).map((d) => d.lead_id)]);
    const prior = people.find((p) => [...leadIds].some((l) => p.leadIds.has(l)));
    if (prior) {
      for (const l of leadIds) prior.leadIds.add(l);
      for (const x of [...leadHumans, ...h.candidate.humanIds]) prior.humanIds.add(x);
      continue;
    }
    // The holder is stable across calls: the lead of their first address, else their lowest lead id.
    const holder = h.candidate.emails.map((e) => byEmail.find((r) => r.key === e)?.lead_id).find((x): x is string => Boolean(x)) ?? [...h.leadIds].sort()[0];
    people.push({ candidate: h.candidate, holder, leadIds, humanIds: new Set([...leadHumans, ...h.candidate.humanIds]) });
  }
  const out: TeamMember[] = people.map((p) => {
    const rows = [...p.leadIds].sort().map((l) => detailOf.get(l)).filter((d): d is NonNullable<typeof d> => d !== undefined);
    const own = detailOf.get(p.holder);
    return {
      role: "team" as const,
      leadId: p.holder,
      memberLeadIds: [...p.leadIds].sort(),
      humanIds: [...p.humanIds].sort(),
      name: p.candidate.name ?? own?.name ?? rows.find((r) => r.name)?.name ?? null,
      email: p.candidate.emails[0] ?? own?.email ?? rows.find((r) => r.email)?.email ?? null,
      lookupEmails: [...p.candidate.emails, ...(own?.email ? [own.email] : []), ...rows.flatMap((r) => (r.email ? [r.email] : []))],
      phone: phoneOf(p.candidate)[0] ?? own?.phone ?? rows.find((r) => r.phone)?.phone ?? null,
      linkedinUrl: own?.linkedin_url ?? rows.find((r) => r.linkedin_url)?.linkedin_url ?? null,
      paidAt: null,
    };
  });
  return { members: out.sort((a, b) => a.leadId.localeCompare(b.leadId)), unheld, humanOfLead };
}

/**
 * The people whose careers count for the brand: its team, and its paying clients who are not team (team wins).
 */
export async function loadCareerPeople(
  orgId: string,
  brandId: string,
  options: { create: boolean },
): Promise<{ team: TeamMember[]; unheldTeam: BrandTeam["unheld"]; paying: CareerPerson[] }> {
  const [clients, team] = await Promise.all([loadPayingClients(orgId, brandId), loadTeam(orgId, brandId, options)]);
  if (team.members.length === 0) return { team: [], unheldTeam: team.unheld, paying: clients.map((c) => ({ ...c, role: "paying_client" as const })) };
  const clientLeads = Array.from(new Set(clients.flatMap((c) => c.memberLeadIds)));
  const humanOfLead = new Map(team.humanOfLead);
  if (clientLeads.length > 0) {
    const rows = (await db.execute(sql`
      SELECT id::text AS lead_id, human_id::text AS human_id FROM leads WHERE id = ANY(${sql.param(clientLeads)}::uuid[])
    `)) as unknown as Array<{ lead_id: string; human_id: string | null }>;
    for (const r of rows) humanOfLead.set(r.lead_id, r.human_id);
  }
  return {
    team: team.members,
    unheldTeam: team.unheld,
    paying: payingClientsNotTeam(clients, team.members, humanOfLead).map((c) => ({ ...c, role: "paying_client" as const })),
  };
}

/** `no_identifier` = nothing to look the person up by (no email, no profile, no phone): recorded, nothing spent. */
export type LookupStatus = "history_found" | "no_linkedin" | "no_experience" | "profile_unreadable" | "no_identifier";

interface LookupRow {
  lead_id: string;
  status: LookupStatus;
  looked_up_at: RawTimestamp;
  version: number;
}

async function loadLookups(leadIds: readonly string[]): Promise<Map<string, StoredLookup>> {
  if (leadIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT lead_id::text AS lead_id, status, looked_up_at, version FROM client_history_lookups
    WHERE lead_id = ANY(${sql.param([...leadIds])}::uuid[])
  `)) as unknown as LookupRow[];
  return new Map(rows.map((r) => [r.lead_id, { status: r.status, lookedUpAt: toIsoTimestamp(r.looked_up_at)!, version: Number(r.version) }]));
}

export interface StoredLookup {
  status: LookupStatus;
  lookedUpAt: string;
  version: number;
}

export type ClientHistoryState = "has_history" | "not_looked_up" | "looked_up_none";

export interface ClientPastEmployersAnswer {
  brandId: string;
  /** Paying clients who are not team members (team wins). */
  payingClients: number;
  /** Paying clients (not team) with at least one role held. */
  clientsWithHistory: number;
  /** The brand's team: members of the org owning it plus relations tagged team, with or without a lead. */
  teamMembers: number;
  teamWithHistory: number;
  companyCount: number;
  /**
   * Why `companies` is empty: `no_paying_clients` = nobody at all (no paying client AND no team member),
   * `no_employment_history` = people, none with a career held; null when it is not.
   */
  reason: "no_paying_clients" | "no_employment_history" | null;
  companies: PastEmployerCompany[];
  /** Paying clients first, then team members. */
  clients: Array<{
    /** null only for a team member no lead holds yet (the POST creates it). */
    leadId: string | null;
    role: PersonRole;
    name: string | null;
    /** null for a team member. */
    paidAt: string | null;
    history: ClientHistoryState;
    lookup: { status: LookupStatus; lookedUpAt: string } | null;
    companyKeys: string[];
  }>;
}

export async function readClientPastEmployers(orgId: string, brandId: string): Promise<ClientPastEmployersAnswer> {
  const { team, unheldTeam, paying } = await loadCareerPeople(orgId, brandId, { create: false });
  const people: CareerPerson[] = [...paying, ...team];
  const ids = people.map((c) => c.leadId);
  const [rows, lookups] = await Promise.all([loadClientEmployment(people), loadLookups(ids)]);
  const companies = groupPastEmployers(rows);
  const keysByClient = new Map<string, string[]>();
  for (const c of companies) for (const cl of c.clients) keysByClient.set(cl.leadId, [...(keysByClient.get(cl.leadId) ?? []), c.companyKey]);
  const withHistory = new Set(rows.map((r) => r.clientLeadId));
  return {
    brandId,
    payingClients: paying.length,
    clientsWithHistory: paying.filter((c) => withHistory.has(c.leadId)).length,
    teamMembers: team.length + unheldTeam.length,
    teamWithHistory: team.filter((c) => withHistory.has(c.leadId)).length,
    companyCount: companies.length,
    reason: emptyReasonOf(people.length + unheldTeam.length, companies.length),
    companies,
    clients: [
      ...people.map((c) => {
        const stored = lookups.get(c.leadId) ?? null;
        const lookup = stored ? { status: stored.status, lookedUpAt: stored.lookedUpAt } : null;
        return {
          leadId: c.leadId,
          role: c.role,
          name: c.name,
          paidAt: c.paidAt,
          history: (withHistory.has(c.leadId) ? "has_history" : lookup ? "looked_up_none" : "not_looked_up") as ClientHistoryState,
          lookup,
          companyKeys: keysByClient.get(c.leadId) ?? [],
        };
      }),
      ...unheldTeam.map((m) => ({
        leadId: null, role: "team" as const, name: m.name, paidAt: null, history: "not_looked_up" as const, lookup: null, companyKeys: [],
      })),
    ],
  };
}

export interface FillSummary {
  attempted: number;
  historyFound: number;
  noLinkedin: number;
  noExperience: number;
  profileUnreadable: number;
  /** Clients with nothing to look them up by (no email, profile or phone). */
  noIdentifier: number;
  failed: number;
  /** Clients still owed a lookup after this call (budget or failures): call again. */
  remaining: number;
  chargedMicro: number;
}

/**
 * PURE. Who is owed a lookup now: no history, and no lookup or a non-finding one older than the retry window; or a
 * career found by an older lookup version.
 */
export function clientsToLookUp<T extends PayingClient>(
  clients: readonly T[],
  withHistory: ReadonlySet<string>,
  lookups: ReadonlyMap<string, StoredLookup>,
  now: Date,
): T[] {
  const retryBefore = now.getTime() - LOOKUP_RETRY_AFTER_DAYS * 86_400_000;
  return clients.filter((c) => {
    const l = lookups.get(c.leadId);
    // A career an older version read is read again once, so its employers get what identifies them.
    if (l && l.status === "history_found" && l.version < PAGES_VERSION && (c.linkedinUrl || c.email)) return true;
    if (withHistory.has(c.leadId)) return false;
    const identified = Boolean(c.email || c.linkedinUrl || c.phone);
    // Never attempted: looked up now; with nothing to look them up by, the lookup records that (free).
    if (!l) return true;
    if (l.status === "no_identifier") return identified;
    if (!identified) return false;
    // A profile the cheap providers could not read: asked once more now that the dearer ones are tried.
    if ((l.status === "no_experience" || l.status === "profile_unreadable") && l.version < DEEP_PROFILE_VERSION && c.linkedinUrl) return true;
    return l.status !== "history_found" && Date.parse(l.lookedUpAt) < retryBefore;
  });
}

async function recordLookup(p: {
  leadId: string; identity: SpendIdentity; status: LookupStatus; linkedinUrl: string | null; chargedMicro: number;
  servedBy: string | null; roles: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO client_history_lookups (lead_id, paid_by_org_id, run_id, status, linkedin_url, roles_found, charged_micro, served_by, looked_up_at, version)
    VALUES (${p.leadId}::uuid, ${p.identity.orgId}, ${p.identity.runId}, ${p.status}, ${p.linkedinUrl}, ${p.roles}, ${p.chargedMicro}, ${p.servedBy}, now(), ${LOOKUP_VERSION})
    ON CONFLICT (lead_id) DO UPDATE SET
      paid_by_org_id = EXCLUDED.paid_by_org_id, run_id = EXCLUDED.run_id, status = EXCLUDED.status,
      linkedin_url = EXCLUDED.linkedin_url, roles_found = EXCLUDED.roles_found,
      charged_micro = client_history_lookups.charged_micro + EXCLUDED.charged_micro,
      served_by = EXCLUDED.served_by, looked_up_at = now(), version = EXCLUDED.version
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
/** A profile answer with no career is asked again without its provider, at most this many calls. */
export const CAREER_PROFILE_ROUNDS = 3;
/**
 * Once the cheap rounds read no career, ONE last call with this ceiling ($0.05) reaches the providers that read the
 * profiles the cheap ones miss (fiber-ai $0.04 a hit read a payer's 15 roles on 2026-11-22 after every provider under
 * $0.01 missed). Every endpoint already tried is excluded, so nothing is paid twice.
 */
export const CAREER_PROFILE_DEEP_MAX_MICRO = 50_000;
/** Reverse phone lookup for a person known by phone alone (no email, no profile): $0.001 a hit, a miss free. */
export const PHONE_ENDPOINT = "blitzapi.people.phone.reverse";
export const PHONE_MAX_MICRO = 2_000;
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
  charged: number;
}

/**
 * Who this email belongs to, through treg's routed `people.enrich` (Apollo excluded). Only a 200 is an answer; a
 * refusal, an error, a pending task or a timeout THROWS (`TransientLookupError`, or the meter's own error) so the
 * caller records nothing and asks again on the next call. A hit with no profile is asked again without its provider.
 * The employer an enrich hit names is NOT recorded: a provider placeholder (« missing account name ») came back as a
 * company name on 2026-11-21; only a LinkedIn experience list is a career.
 */
export async function findProfileByEmail(email: string, call: TregCall, alreadyCharged = 0): Promise<EmailLookupAnswer> {
  let charged = 0;
  const exclude = [...NEVER_ROUTE_TO];
  for (let round = 0; round < CAREER_ENRICH_ROUNDS; round++) {
    const maxMicro = Math.min(CAREER_ENRICH_MAX_MICRO, CAREER_LOOKUP_MAX_MICRO - alreadyCharged - charged);
    if (maxMicro <= 0) break;
    const r = await call({ endpointId: ENRICH_ENDPOINT, method: "POST", params: { email }, maxMicro, routeExclude: [...exclude] });
    charged += r.chargedMicro;
    if (!isAnswer(r.status)) throw new TransientLookupError(`people.enrich answered ${r.status} (charged ${charged} micro-USD so far)`);
    const found = readEnrichOutput(r.body);
    if (found.linkedinUrl) return { linkedinUrl: found.linkedinUrl, charged };
    const provider = servedProviderOf(r.body);
    if (!provider) break; // every provider within the ceiling missed: a real « nobody knows this address »
    exclude.push(provider);
  }
  return { linkedinUrl: null, charged };
}

/** The `/in/<handle>` of a profile URL (some providers take only the handle), or null. */
export function linkedinHandleOf(url: string): string | null {
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface ProfileLookupAnswer {
  /** null = the provider says it holds no readable profile (final). */
  roles: ReturnType<typeof readProfileRoles> | null;
  servedBy: string | null;
  charged: number;
}

/**
 * The career on a LinkedIn profile, through treg's routed `linkedin.user.profile` (Apollo excluded), asked with the
 * URL AND its handle (harvestapi takes only the handle). A profile answer carrying no experience list (brightdata
 * answers `experience: null` on most public profiles, 7 of 8 on 2026-11-21) is asked again without its provider.
 * Same failure rule as `findProfileByEmail`: anything but a 200 or the provider's own « no profile » THROWS.
 */
export async function readCareerOfProfile(linkedinUrl: string, call: TregCall, alreadyCharged: number): Promise<ProfileLookupAnswer> {
  let charged = 0;
  let servedBy: string | null = null;
  const exclude = [...NEVER_ROUTE_TO];
  const handle = linkedinHandleOf(linkedinUrl);
  const params = { linkedin_url: linkedinUrl, ...(handle ? { linkedin_handle: handle } : {}) };
  const ask = async (ceiling: number): Promise<{ done: ProfileLookupAnswer | null; moreProviders: boolean }> => {
    const maxMicro = Math.min(ceiling, CAREER_LOOKUP_MAX_MICRO - alreadyCharged - charged);
    if (maxMicro <= 0) return { done: null, moreProviders: false };
    const p = await call({ endpointId: PROFILE_ENDPOINT, method: "POST", params, maxMicro, routeExclude: [...exclude] });
    charged += p.chargedMicro;
    // Only the PROVIDER saying it has no readable profile (404/410/422, not treg's own refusal) is a final answer.
    const providerHasNone = (p.status === 404 || p.status === 410 || p.status === 422) && !isTregRefusal(p.status, p.body);
    if (providerHasNone) return { done: { roles: null, servedBy: servedByOf(p.body), charged }, moreProviders: false };
    if (!isAnswer(p.status)) throw new TransientLookupError(`linkedin.user.profile answered ${p.status}`);
    servedBy = servedByOf(p.body) ?? servedBy;
    const roles = readProfileRoles(p.body);
    if (roles.length > 0) return { done: { roles, servedBy: servedByOf(p.body), charged }, moreProviders: false };
    // Every endpoint that answered (hit or miss) is not asked again; one skipped for its price may be, dearer.
    for (const ep of triedEndpointsOf(p.body)) if (!exclude.includes(ep)) exclude.push(ep);
    const provider = servedProviderOf(p.body);
    if (provider && !exclude.includes(provider)) exclude.push(provider);
    return { done: null, moreProviders: provider !== null };
  };
  for (let round = 0; round < CAREER_PROFILE_ROUNDS; round++) {
    const r = await ask(PROFILE_MAX_MICRO);
    if (r.done) return r.done;
    if (!r.moreProviders) break;
  }
  const deep = await ask(CAREER_PROFILE_DEEP_MAX_MICRO);
  if (deep.done) return deep.done;
  return { roles: [], servedBy, charged };
}

/** PURE. The endpoints a routed answer actually asked (`_treg.tried`, outcome other than `skipped`). */
export function triedEndpointsOf(body: unknown): string[] {
  const tried = (body as { _treg?: { tried?: unknown } } | null)?._treg?.tried;
  if (!Array.isArray(tried)) return [];
  return tried
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    .filter((t) => t.outcome !== "skipped" && typeof t.endpoint_id === "string")
    .map((t) => t.endpoint_id as string);
}

/**
 * The LinkedIn profile behind a phone number (a payer known by phone alone), or null. Same failure rule: only a 200
 * is an answer.
 */
export async function findProfileByPhone(phone: string, call: TregCall): Promise<EmailLookupAnswer> {
  const r = await call({ endpointId: PHONE_ENDPOINT, method: "POST", params: { phone }, maxMicro: PHONE_MAX_MICRO });
  if (!isAnswer(r.status)) throw new TransientLookupError(`${PHONE_ENDPOINT} answered ${r.status}`);
  const person = (r.body as { person?: unknown } | null)?.person;
  const found = person && typeof person === "object" ? readEnrichOutput({ output: person }) : null;
  return { linkedinUrl: found?.linkedinUrl ?? null, charged: r.chargedMicro };
}

/**
 * Each role's employer gets the LinkedIn company page its experience entry names. `recordEmploymentHistory` keys a past
 * employer on its NAME (a shared row): an employer row of that name on this lead with no page takes it; one holding
 * ANOTHER page is a different company of the same name, so the role moves to a row of its own (name + page). Never a
 * lookup by page (no index on a 450 MB table), never a page guessed from a name.
 */
async function attachCompanyPages(leadId: string, roles: readonly ProfileRole[]): Promise<void> {
  for (const role of roles) {
    const page = companyPageOf(role.companyLinkedinUrl);
    if (!page) continue;
    const rows = (await db.execute(sql`
      SELECT lo.id::text AS lo_id, o.id::text AS org_id, o.linkedin_url
      FROM leads_organizations lo JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.lead_id = ${leadId}::uuid AND lower(btrim(o.name)) = lower(btrim(${role.organizationName}))
    `)) as unknown as Array<{ lo_id: string; org_id: string; linkedin_url: string | null }>;
    for (const r of rows) {
      if (companyPageOf(r.linkedin_url) === page) continue;
      if (r.linkedin_url === null || companyPageOf(r.linkedin_url) === null) {
        await db.execute(sql`
          UPDATE organizations SET linkedin_url = ${page}, updated_at = now()
          WHERE id = ${r.org_id}::uuid AND (linkedin_url IS NULL OR linkedin_url = ${r.linkedin_url})`);
        continue;
      }
      const [created] = (await db.execute(sql`
        INSERT INTO organizations (name, linkedin_url) VALUES (${role.organizationName}, ${page}) RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      await db.execute(sql`UPDATE leads_organizations SET organization_id = ${created.id}::uuid WHERE id = ${r.lo_id}::uuid`);
    }
  }
}

/** At most this many distinct addresses of one person are asked for their profile (a miss is free). */
export const MAX_LOOKUP_ADDRESSES = 3;

/**
 * PURE. The addresses to ask the email-to-profile step by: `email` first, then the person's other addresses, one per
 * mailbox (`+tag` variants fold), at most `MAX_LOOKUP_ADDRESSES`.
 */
export function addressesToAsk(client: Pick<PayingClient, "email" | "lookupEmails">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [client.email, ...(client.lookupEmails ?? [])]) {
    const e = raw?.trim().toLowerCase();
    const key = memberAddressKey(e);
    if (!e || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= MAX_LOOKUP_ADDRESSES) break;
  }
  return out;
}

/** Look one client up. Throws InsufficientCreditError (stop the pass) or TransientLookupError (nothing recorded). */
async function lookUpOne(client: PayingClient, call: TregCall, identity: SpendIdentity): Promise<{ status: LookupStatus; charged: number }> {
  let charged = 0;
  let linkedinUrl = client.linkedinUrl;
  if (!linkedinUrl && !client.email && !client.phone) {
    await recordLookup({ leadId: client.leadId, identity, status: "no_identifier", linkedinUrl: null, chargedMicro: 0, servedBy: null, roles: 0 });
    return { status: "no_identifier", charged };
  }
  if (!linkedinUrl && !client.email && client.phone) {
    const found = await findProfileByPhone(client.phone, call);
    charged += found.charged;
    linkedinUrl = found.linkedinUrl;
    if (linkedinUrl) {
      await db.execute(sql`UPDATE leads SET linkedin_url = COALESCE(linkedin_url, ${linkedinUrl}) WHERE id = ${client.leadId}::uuid`);
    }
  }
  if (!linkedinUrl && client.email) {
    for (const email of addressesToAsk(client)) {
      if (charged >= CAREER_LOOKUP_MAX_MICRO) break;
      const found = await findProfileByEmail(email, call, charged);
      charged += found.charged;
      linkedinUrl = found.linkedinUrl;
      if (linkedinUrl) break;
    }
    if (linkedinUrl) {
      await db.execute(sql`UPDATE leads SET linkedin_url = COALESCE(linkedin_url, ${linkedinUrl}) WHERE id = ${client.leadId}::uuid`);
    }
  }
  if (!linkedinUrl) {
    await recordLookup({ leadId: client.leadId, identity, status: "no_linkedin", linkedinUrl: null, chargedMicro: charged, servedBy: null, roles: 0 });
    return { status: "no_linkedin", charged };
  }
  const career = await readCareerOfProfile(linkedinUrl, call, charged);
  charged += career.charged;
  if (career.roles === null) {
    await recordLookup({ leadId: client.leadId, identity, status: "profile_unreadable", linkedinUrl, chargedMicro: charged, servedBy: career.servedBy, roles: 0 });
    return { status: "profile_unreadable", charged };
  }
  const roles = career.roles;
  if (roles.length === 0) {
    await recordLookup({ leadId: client.leadId, identity, status: "no_experience", linkedinUrl, chargedMicro: charged, servedBy: career.servedBy, roles: 0 });
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
          annualRevenue: null, linkedinUrl: null, logoUrl: null, city: null, state: null, country: null,
        }
      : null,
    employmentHistory: roles.map((r) => ({
      organizationName: r.organizationName, title: r.title, startDate: r.startDate, endDate: r.endDate, current: r.current, description: null,
    })),
  } as unknown as Person;
  await recordEmploymentHistory({ leadId: client.leadId, person });
  // The company page is never handed to `recordEmploymentHistory`: its upsert matches an organization by NAME and would
  // overwrite the page of another company of that name. `attachCompanyPages` attaches it to this lead's row only.
  await attachCompanyPages(client.leadId, roles);
  await recordLookup({ leadId: client.leadId, identity, status: "history_found", linkedinUrl, chargedMicro: charged, servedBy: career.servedBy, roles: roles.length });
  return { status: "history_found", charged };
}

/**
 * Fill missing careers of the brand's team and paying clients, within one call's budget. Team members first (they are
 * few); a team member no lead holds gets a lead here.
 */
export async function fillClientHistories(identity: SpendIdentity, brandId: string, now = new Date()): Promise<FillSummary> {
  const { team, paying } = await loadCareerPeople(identity.orgId, brandId, { create: true });
  const clients: CareerPerson[] = [...team, ...paying];
  const ids = clients.map((c) => c.leadId);
  const [rows, lookups] = await Promise.all([loadClientEmployment(clients), loadLookups(ids)]);
  const owed = clientsToLookUp(clients, new Set(rows.map((r) => r.clientLeadId)), lookups, now);
  const summary: FillSummary = {
    attempted: 0, historyFound: 0, noLinkedin: 0, noExperience: 0, profileUnreadable: 0, noIdentifier: 0, failed: 0, remaining: 0, chargedMicro: 0,
  };
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
        else if (r.status === "no_identifier") summary.noIdentifier += 1;
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
