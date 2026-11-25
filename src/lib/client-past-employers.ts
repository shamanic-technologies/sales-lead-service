/**
 * THE COMPANIES WHERE A BRAND'S PAYING CLIENTS HAVE WORKED (BRAND-PROOF-LOGOS-1121, owner 2026-11-21: « une liste
 * impressionnante de logos d'entreprises où nos clients ont travaillé par le passé. Pas forcément les actuelles
 * companies, mais des companies où ils ont travaillé »). Generic for every brand; consumer = the « Client past employer
 * found » Engine's script (workflow-service), brand-service judges each company and stores the Units.
 *
 * PURE half (the IO is `client-past-employers-read.ts`):
 *   - who a paying client IS comes from the same evidence `step-reached` reads for `paid_client` (a live ledger
 *     `sale`/`purchase`, a CRM `sale`, a CRM `payment` that STANDS), never a list and never a read of our services;
 *   - one client = one PERSON: the lead holding the evidence plus every lead of the same human (human-service's answer,
 *     `leads.human_id`; a job change is a new lead row, so a person's past employers sit on their other rows);
 *   - one company = one key: its brand-service company id when resolved, else the employer row's domain, else its name
 *     case-folded; each company lists the clients (lead, role, dates) that justify it;
 *   - a LinkedIn profile answer (treg `linkedin.user.profile`, whichever provider served it) is read for its experience
 *     list by SHAPE, never by provider name.
 *
 * THE BRAND'S OWN TEAM IS A SECOND SOURCE (TEAM-PAST-EMPLOYERS-1125): the people behind the brand (members of the org
 * owning it, plus anyone the brand tags `team`) count beside its paying clients, each trace entry saying which (`role`).
 * Fleet staff are members of many CLIENT orgs: staff count as team only on an org whose every member is staff (ours).
 * Team wins: a person who is both is counted as team only.
 */
import { isStaffEmail } from "./staff-identity.js";
import { memberAddressKey } from "./org-members.js";

export type PersonRole = "paying_client" | "team";

export interface EmploymentRow {
  /** The person's key: the lead holding the paid evidence, or the team member's lead. */
  clientLeadId: string;
  role: PersonRole;
  /** The lead row the role is recorded on (the client lead, or another lead of the same human). */
  leadId: string;
  organizationId: string;
  companyId: string | null;
  name: string | null;
  domain: string | null;
  logoUrl: string | null;
  linkedinUrl: string | null;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
}

export interface CompanyClient {
  leadId: string;
  role: PersonRole;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
}

export interface PastEmployerCompany {
  /** Stable key: `company:<brand-service id>` | `domain:<domain>` | `linkedin:<company page>` | `name:<folded name>`. */
  companyKey: string;
  companyId: string | null;
  name: string | null;
  domain: string | null;
  logoUrl: string | null;
  linkedinUrl: string | null;
  /** Distinct people who worked there, paying clients and team members together. */
  clientCount: number;
  payingClientCount: number;
  teamCount: number;
  /** true when at least one of them works there NOW (the logo is a current employer for them). */
  currentForSome: boolean;
  clients: CompanyClient[];
}

export function companyKeyOf(row: Pick<EmploymentRow, "companyId" | "domain" | "name"> & { linkedinUrl?: string | null }): string | null {
  if (row.companyId) return `company:${row.companyId}`;
  const domain = row.domain?.trim().toLowerCase().replace(/^www\./, "");
  if (domain) return `domain:${domain}`;
  const page = companyPageOf(row.linkedinUrl);
  if (page) return `linkedin:${page}`;
  const name = row.name?.trim().toLowerCase().replace(/\s+/g, " ");
  if (name) return `name:${name}`;
  return null;
}

/** Group employment rows into companies, most clients first, then name. One client counted once per company. */
export function groupPastEmployers(rows: readonly EmploymentRow[]): PastEmployerCompany[] {
  const byKey = new Map<string, PastEmployerCompany & { seen: Map<string, CompanyClient> }>();
  for (const r of rows) {
    const key = companyKeyOf(r);
    if (!key) continue;
    let c = byKey.get(key);
    if (!c) {
      c = {
        companyKey: key,
        companyId: r.companyId,
        name: r.name,
        domain: r.domain,
        logoUrl: r.logoUrl,
        linkedinUrl: r.linkedinUrl,
        clientCount: 0,
        payingClientCount: 0,
        teamCount: 0,
        currentForSome: false,
        clients: [],
        seen: new Map(),
      };
      byKey.set(key, c);
    }
    c.companyId = c.companyId ?? r.companyId;
    c.name = c.name ?? r.name;
    c.domain = c.domain ?? r.domain;
    c.logoUrl = c.logoUrl ?? r.logoUrl;
    c.linkedinUrl = c.linkedinUrl ?? r.linkedinUrl;
    const prior = c.seen.get(r.clientLeadId);
    // A person holding several roles there: the current one, else the latest started, is the role shown.
    if (!prior || (r.current && !prior.current) || (!prior.current && (r.startDate ?? "") > (prior.startDate ?? ""))) {
      c.seen.set(r.clientLeadId, { leadId: r.clientLeadId, role: r.role, title: r.title, startDate: r.startDate, endDate: r.endDate, current: r.current });
    }
  }
  const out: PastEmployerCompany[] = [];
  for (const c of byKey.values()) {
    const clients = [...c.seen.values()].sort((a, b) => a.leadId.localeCompare(b.leadId));
    const { seen: _seen, ...company } = c;
    const teamCount = clients.filter((x) => x.role === "team").length;
    out.push({
      ...company, clients, clientCount: clients.length, payingClientCount: clients.length - teamCount, teamCount,
      currentForSome: clients.some((x) => x.current),
    });
  }
  return out.sort(
    (a, b) => b.clientCount - a.clientCount || (a.name ?? a.companyKey).localeCompare(b.name ?? b.companyKey) || a.companyKey.localeCompare(b.companyKey),
  );
}

/** A member of the org owning the brand, as `org-members.ts` `loadOrgMembers` states them. */
export interface TeamOrgMember {
  email: string | null;
  emails?: readonly string[];
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

/** A relation the brand's DECIDED tags call `team` (yes), with what its subject rows hold. */
export interface TaggedTeamPerson {
  humanId: string;
  name: string | null;
  emails: readonly string[];
  phones: readonly string[];
}

export interface TeamCandidate {
  source: "org_member" | "team_relation";
  /** The relationship humans tagged team that are this person (none for a plain org member). */
  humanIds: string[];
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Lower-cased, in the order stated. */
  emails: string[];
  phones: string[];
}

/**
 * PURE. Is the org OURS: at least one member has an address and every member address is staff. Fleet staff are invited
 * into client orgs, so staff are a brand's team only there.
 */
export function isStaffOrg(members: readonly TeamOrgMember[]): boolean {
  const emails = members.flatMap((m) => (m.emails && m.emails.length > 0 ? [...m.emails] : m.email ? [m.email] : []));
  return emails.length > 0 && emails.every((e) => isStaffEmail(e));
}

/**
 * PURE. The brand's team: the org's members plus the relations tagged team, one entry per PERSON (entries sharing an
 * address, +tag variants folded, or a phone are one). A person any of whose addresses is staff counts only when the
 * org is ours (`isStaffOrg`).
 */
export function teamCandidatesOf(members: readonly TeamOrgMember[], tagged: readonly TaggedTeamPerson[]): TeamCandidate[] {
  const ours = isStaffOrg(members);
  const lower = (list: readonly string[]) => Array.from(new Set(list.map((e) => e.trim().toLowerCase()).filter((e) => e !== "")));
  const raw: TeamCandidate[] = [];
  for (const m of members) {
    const emails = lower(m.emails && m.emails.length > 0 ? m.emails : m.email ? [m.email] : []);
    const phones = m.phone && m.phone.trim() !== "" ? [m.phone.trim()] : [];
    if (emails.length === 0 && phones.length === 0) continue;
    const name = [m.firstName, m.lastName].filter((x): x is string => Boolean(x && x.trim())).join(" ").trim() || null;
    raw.push({ source: "org_member", humanIds: [], name, firstName: m.firstName, lastName: m.lastName, emails, phones });
  }
  const byHuman = new Map<string, TeamCandidate>();
  for (const t of tagged) {
    const prior = byHuman.get(t.humanId);
    if (prior) {
      prior.emails = lower([...prior.emails, ...t.emails]);
      prior.phones = Array.from(new Set([...prior.phones, ...t.phones]));
      prior.name = prior.name ?? t.name;
      continue;
    }
    const c: TeamCandidate = {
      source: "team_relation", humanIds: [t.humanId], name: t.name, firstName: null, lastName: null,
      emails: lower(t.emails), phones: Array.from(new Set(t.phones)),
    };
    byHuman.set(t.humanId, c);
    raw.push(c);
  }
  const out: TeamCandidate[] = [];
  const owner = new Map<string, TeamCandidate>();
  for (const c of raw) {
    if (!ours && c.emails.some((e) => isStaffEmail(e))) continue;
    const keys = [
      ...c.emails.map((e) => `email:${memberAddressKey(e) ?? e}`),
      ...c.phones.map((p) => `phone:${p.replace(/[^\d+]/g, "")}`),
    ];
    const into = keys.map((k) => owner.get(k)).find((x): x is TeamCandidate => x !== undefined);
    if (!into) {
      const kept = { ...c, humanIds: [...c.humanIds], emails: [...c.emails], phones: [...c.phones] };
      out.push(kept);
      for (const k of keys) owner.set(k, kept);
      continue;
    }
    into.humanIds = Array.from(new Set([...into.humanIds, ...c.humanIds]));
    into.emails = Array.from(new Set([...into.emails, ...c.emails]));
    into.phones = Array.from(new Set([...into.phones, ...c.phones]));
    into.name = into.name ?? c.name;
    into.firstName = into.firstName ?? c.firstName;
    into.lastName = into.lastName ?? c.lastName;
    for (const k of keys) if (!owner.has(k)) owner.set(k, into);
  }
  return out;
}

/**
 * PURE. Team wins over paying client: a paying client sharing a lead, or a human, with a team member is that team
 * member, counted as team only ("team" wins over every other tag, org-members.ts).
 */
export function payingClientsNotTeam<T extends { leadId: string; memberLeadIds: readonly string[] }>(
  clients: readonly T[],
  team: ReadonlyArray<{ memberLeadIds: readonly string[]; humanIds: readonly string[] }>,
  humanOfLead: ReadonlyMap<string, string | null>,
): T[] {
  const teamLeads = new Set(team.flatMap((t) => [...t.memberLeadIds]));
  const teamHumans = new Set(team.flatMap((t) => [...t.humanIds, ...t.memberLeadIds.map((l) => humanOfLead.get(l) ?? null)]).filter((h): h is string => Boolean(h)));
  return clients.filter((c) => {
    const leadIds = c.memberLeadIds.length > 0 ? c.memberLeadIds : [c.leadId];
    return !leadIds.some((l) => teamLeads.has(l) || (humanOfLead.get(l) ? teamHumans.has(humanOfLead.get(l)!) : false));
  });
}

/** PURE. Why `companies` is empty: nobody at all, or people with no career held; null when it is not. */
export function emptyReasonOf(people: number, companies: number): "no_paying_clients" | "no_employment_history" | null {
  if (companies > 0) return null;
  return people === 0 ? "no_paying_clients" : "no_employment_history";
}

/**
 * PURE. A company's LinkedIn page in one spelling (`https://www.linkedin.com/company/<slug>/`, also `school`/`showcase`),
 * or null for anything else (a member profile, a redirect, a position link). A profile's experience entry names its
 * employer's page: that page, never the name, is what identifies the company.
 */
export function companyPageOf(url: string | null | undefined): string | null {
  const m = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i.exec((url ?? "").trim());
  if (!m) return null;
  let slug = m[2];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // not percent-encoded: keep it verbatim
  }
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${slug.toLowerCase()}/`;
}

/** One role read off a LinkedIn profile answer, in `recordEmploymentHistory`'s words. */
export interface ProfileRole {
  organizationName: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  companyLinkedinUrl: string | null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A profile date as a calendar date (first of the month / year when that is all it states), or null. */
export function profileDate(value: unknown): string | null {
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const year = typeof o.year === "number" ? o.year : Number(str(o.year));
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
    const month = typeof o.month === "number" ? o.month : Number(str(o.month) ?? 1);
    const m = Number.isInteger(month) && month >= 1 && month <= 12 ? month : 1;
    return `${year}-${String(m).padStart(2, "0")}-01`;
  }
  const s = str(value);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3] ?? "01"}`;
  const monthYear = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(s);
  if (monthYear && MONTHS[monthYear[1].toLowerCase()]) return `${monthYear[2]}-${MONTHS[monthYear[1].toLowerCase()]}-01`;
  const year = /^(\d{4})$/.exec(s);
  if (year) return `${year[1]}-01-01`;
  return null;
}

function isPresent(value: unknown): boolean {
  const s = str(value);
  return s !== null && /^(present|current|now|aujourd'hui|today)$/i.test(s);
}

const EXPERIENCE_KEYS = ["experience", "experiences", "positions", "position_history", "work_experience"];

function experienceArrays(node: unknown, depth = 0): unknown[][] {
  if (!node || typeof node !== "object" || depth > 3) return [];
  if (Array.isArray(node)) return node.length > 0 && depth > 0 ? experienceArrays(node[0], depth + 1) : [];
  const o = node as Record<string, unknown>;
  const found: unknown[][] = [];
  for (const k of EXPERIENCE_KEYS) if (Array.isArray(o[k]) && (o[k] as unknown[]).length > 0) found.push(o[k] as unknown[]);
  if (found.length > 0) return found;
  for (const k of ["output", "data", "raw", "profile", "person", "result"]) {
    if (o[k] !== undefined) {
      const inner = Array.isArray(o[k]) ? (o[k] as unknown[])[0] : o[k];
      const got = experienceArrays(inner, depth + 1);
      if (got.length > 0) return got;
    }
  }
  return [];
}

/**
 * The company page a role's LinkedIn company ID names (`/company/<id>/`, which LinkedIn serves for a numeric id), or
 * null. Some providers state only the id (fiber-ai `linkedin_company_id`); a negative or zero id is a placeholder
 * LinkedIn mints for a self-typed employer and names no page.
 */
export function companyPageOfId(value: unknown): string | null {
  const s = typeof value === "number" ? String(value) : str(value);
  if (!s || !/^[1-9]\d*$/.test(s)) return null;
  return `https://www.linkedin.com/company/${s}/`;
}

/** The first company PAGE among a role's link fields, else the first link stated (kept verbatim). */
function companyLinkOf(values: unknown[]): string | null {
  const links = values.map(str).filter((v): v is string => v !== null);
  return links.find((v) => companyPageOf(v) !== null) ?? links[0] ?? null;
}

/**
 * PURE. A TEASER read: roles of which none carries a start or an end date (a logged-out view of the profile, e.g. only
 * the current employer, TEAM-PAST-EMPLOYERS-1125). Not a career: the next provider is asked.
 */
export function isTeaserCareer(roles: ReadonlyArray<Pick<ProfileRole, "startDate" | "endDate">>): boolean {
  return roles.length > 0 && roles.every((r) => !r.startDate && !r.endDate);
}

/** PURE. The persons (`clientLeadId`) whose every held role carries no date: a career recorded off a teaser read. */
export function undatedPersonsOf(rows: ReadonlyArray<Pick<EmploymentRow, "clientLeadId" | "startDate" | "endDate">>): Set<string> {
  const dated = new Set(rows.filter((r) => r.startDate || r.endDate).map((r) => r.clientLeadId));
  return new Set(rows.map((r) => r.clientLeadId).filter((id) => !dated.has(id)));
}

/** The roles a profile answer states (first experience list found by shape). Entries naming no company are dropped. */
export function readProfileRoles(body: unknown): ProfileRole[] {
  const [list] = experienceArrays(body);
  if (!list) return [];
  const roles: ProfileRole[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const company = e.company && typeof e.company === "object" ? (e.company as Record<string, unknown>) : null;
    const organizationName =
      str(e.companyName) ?? str(e.company_name) ?? (company ? str(company.name) : str(e.company)) ?? str(e.organization) ?? str(e.organization_name);
    // A link where a name belongs (LinkedIn's own `redir/suspicious-page?url=...` for a self-typed employer) names no company.
    if (!organizationName || /^(https?:\/\/|www\.)/i.test(organizationName)) continue;
    const period = e.timePeriod && typeof e.timePeriod === "object" ? (e.timePeriod as Record<string, unknown>) : null;
    const endRaw = e.endDate ?? e.end_date ?? e.ends_at ?? e.end ?? period?.endDate;
    const startRaw = e.startDate ?? e.start_date ?? e.starts_at ?? e.start ?? period?.startDate;
    const present = isPresent(endRaw) || e.current === true || e.is_current === true || e.ongoing === true;
    roles.push({
      organizationName,
      title: str(e.title) ?? str(e.position) ?? str(e.job_title) ?? str(e.jobTitle),
      startDate: profileDate(startRaw),
      endDate: present ? null : profileDate(endRaw),
      current: present,
      companyLinkedinUrl: companyLinkOf([
        e.companyLinkedinUrl, e.company_linkedin_url, e.url, company?.url, company?.linkedin_url, company?.linkedinUrl,
        companyPageOfId(e.linkedin_company_id ?? e.companyId ?? e.company_id ?? company?.id),
      ]),
    });
  }
  return roles;
}
