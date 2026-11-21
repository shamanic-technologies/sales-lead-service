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
 */

export interface EmploymentRow {
  /** The paying client's person key (the lead holding the paid evidence). */
  clientLeadId: string;
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
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
}

export interface PastEmployerCompany {
  /** Stable key: `company:<brand-service id>` | `domain:<domain>` | `name:<folded name>`. */
  companyKey: string;
  companyId: string | null;
  name: string | null;
  domain: string | null;
  logoUrl: string | null;
  linkedinUrl: string | null;
  /** Distinct paying clients who worked there. */
  clientCount: number;
  /** true when at least one of them works there NOW (the logo is a current employer for them). */
  currentForSome: boolean;
  clients: CompanyClient[];
}

export function companyKeyOf(row: Pick<EmploymentRow, "companyId" | "domain" | "name">): string | null {
  if (row.companyId) return `company:${row.companyId}`;
  const domain = row.domain?.trim().toLowerCase().replace(/^www\./, "");
  if (domain) return `domain:${domain}`;
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
      c.seen.set(r.clientLeadId, { leadId: r.clientLeadId, title: r.title, startDate: r.startDate, endDate: r.endDate, current: r.current });
    }
  }
  const out: PastEmployerCompany[] = [];
  for (const c of byKey.values()) {
    const clients = [...c.seen.values()].sort((a, b) => a.leadId.localeCompare(b.leadId));
    const { seen: _seen, ...company } = c;
    out.push({ ...company, clients, clientCount: clients.length, currentForSome: clients.some((x) => x.current) });
  }
  return out.sort(
    (a, b) => b.clientCount - a.clientCount || (a.name ?? a.companyKey).localeCompare(b.name ?? b.companyKey) || a.companyKey.localeCompare(b.companyKey),
  );
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
      companyLinkedinUrl: str(e.companyLinkedinUrl) ?? str(e.company_linkedin_url) ?? str(e.url) ?? (company ? str(company.url) ?? str(company.linkedin_url) : null),
    });
  }
  return roles;
}
