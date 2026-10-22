/**
 * The identity sweep (background thread): every lead gets its HUMAN (human-service) and its COMPANY
 * (brand-service), and every employer's firmographics are written to brand-service, their home
 * (owner 2026-10-13, LEAD-REFONTE-1013). Pure halves in `lead-identity.ts`.
 *
 * Three passes per tick, each bounded, resumable and idempotent (a crash re-does at most one batch):
 *  1. EMPLOYERS: every organization row that is someone's CURRENT employer and was never resolved is
 *     resolved through brand-service in batches of 1000 (`company_id` + `company_resolved_at`, the
 *     reason kept when brand-service refuses: a name-only employer is `no_safe_identity`, NULL id).
 *  2. FACTS: every resolved employer whose row changed since its facts were last written
 *     (`updated_at > company_facts_pushed_at`) has them written (`PUT /internal/companies/facts`).
 *     A batch brand-service refuses (400 names the problem) is retried company by company so one bad
 *     value never blocks the rest; a single refusal is logged loudly and marked pushed (it is a
 *     value this service cannot fix by asking again).
 *  3. LEADS: every lead never resolved (`identity_resolved_at IS NULL`) whose current employer is
 *     resolved (or who has none) gets `human_id` (human-service, create:true, FLEET view: a lead row
 *     is global, orgs share it) and `company_id` (the employer's company, NULL = no safe identity
 *     or no employer: still a lead) and `organization_id` (the employer's LOCAL row: the company key when
 *     brand-service has no safe identity for it). `HUMAN_RESOLVE_CONCURRENCY` calls in flight.
 *  4./5. Fill `organization_id` on leads resolved before it existed; move a lead from its local key to
 *     the brand id once its employer row gets one.
 *
 * Writes only the 0076 columns, which no read-model / change-feed trigger watches (0042 triggers are
 * column-guarded): the backfill moves no lead row any consumer holds. A human-service or brand-service
 * failure leaves the batch untouched (retried next tick) and is logged; nothing is guessed meanwhile.
 */
import { messageOf } from "./db-error.js";
import { errorMessage } from "./db-error.js";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { resolveHuman, HumanIdentityError } from "./human-identity-client.js";
import { resolveCompanies, writeCompanyFacts, CompanyServiceError, MAX_COMPANIES_PER_REQUEST } from "./company-client.js";
import {
  companyFactsOf,
  companyInputOf,
  hasAnyKey,
  humanKeysOf,
  workEmailDomain,
  type LeadKeyRow,
  type OrganizationRow,
} from "./lead-identity.js";

export const COMPANY_FACTS_SOURCE = "lead-service";
const LEAD_BATCH = Math.max(1, Number(process.env.LEAD_IDENTITY_BATCH) || 400);
const HUMAN_RESOLVE_CONCURRENCY = Math.max(1, Number(process.env.LEAD_IDENTITY_CONCURRENCY) || 8);
const BUSY_TICK_MS = 2_000;
const IDLE_TICK_MS = 60_000;
const FIRST_SWEEP_DELAY_MS = 90_000;

/** The current-employer winner the list reads (basic-leads.ts): enriched first, newest row, stable id. */
const CURRENT_ORG = sql`
  SELECT lo.organization_id
  FROM leads_organizations lo
  LEFT JOIN organizations o ON o.id = lo.organization_id
  WHERE lo.lead_id = l.id AND lo.current = true
  ORDER BY (CASE WHEN o.logo_url IS NOT NULL OR o.primary_domain IS NOT NULL THEN 1 ELSE 0 END) DESC,
           lo.created_at DESC NULLS LAST,
           lo.organization_id ASC
  LIMIT 1
`;

const ORG_COLUMNS = sql`
  o.id::text AS id, o.name, o.primary_domain, o.website_url, o.linkedin_url, o.apollo_organization_id,
  o.short_description, o.seo_description, o.logo_url, o.twitter_url, o.facebook_url, o.blog_url,
  o.crunchbase_url, o.angellist_url, o.industry, o.industries, o.secondary_industries, o.keywords,
  o.technology_names, o.founded_year, o.estimated_num_employees, o.annual_revenue::text AS annual_revenue,
  o.latest_funding_stage, o.latest_funding_round_date::text AS latest_funding_round_date,
  o.total_funding::text AS total_funding, o.total_funding_printed, o.funding_events,
  o.retail_location_count, o.num_suborganizations, o.alexa_ranking, o.publicly_traded_symbol,
  o.publicly_traded_exchange, o.primary_phone, o.street_address, o.city, o.state, o.postal_code,
  o.country, o.updated_at
`;

/** Pass 1: resolve up to 1000 never-resolved CURRENT employers. Returns how many were resolved. */
export async function resolveEmployers(limit = MAX_COMPANIES_PER_REQUEST): Promise<number> {
  const orgs = (await db.execute(sql`
    SELECT ${ORG_COLUMNS}
    FROM organizations o
    WHERE o.company_resolved_at IS NULL
      AND EXISTS (SELECT 1 FROM leads_organizations lo WHERE lo.organization_id = o.id AND lo.current = true)
    ORDER BY o.id
    LIMIT ${limit}
  `)) as unknown as OrganizationRow[];
  if (orgs.length === 0) return 0;
  const results = await resolveCompanies(orgs.map(companyInputOf));
  const ids = results.map((r) => orgs[r.index].id);
  const companyIds = results.map((r) => r.brandId ?? "");
  const reasons = results.map((r) => (r.brandId ? "" : (r.unresolvedReason ?? "unresolved")));
  await db.execute(sql`
    UPDATE organizations o
    SET company_id = NULLIF(v.company_id, '')::uuid,
        company_unresolved_reason = NULLIF(v.reason, ''),
        company_resolved_at = now()
    FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(companyIds)}::text[], ${sql.param(reasons)}::text[])
      AS v(id, company_id, reason)
    WHERE o.id = v.id
  `);
  return orgs.length;
}

// `updated_at` is carried back as its own text (microseconds): a JS Date floors it to milliseconds, so
// the row would read as changed after its own write and be pushed again forever.
async function markFactsPushed(rows: Array<{ id: string; updated_at_text: string }>): Promise<void> {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  const at = rows.map((r) => r.updated_at_text);
  await db.execute(sql`
    UPDATE organizations o SET company_facts_pushed_at = v.at
    FROM unnest(${sql.param(ids)}::uuid[], ${sql.param(at)}::timestamptz[]) AS v(id, at)
    WHERE o.id = v.id
  `);
}

/** Pass 2: write the firmographics of up to 1000 resolved employers whose row changed since. */
export async function pushEmployerFacts(limit = MAX_COMPANIES_PER_REQUEST): Promise<number> {
  const orgs = (await db.execute(sql`
    SELECT ${ORG_COLUMNS}, o.company_id::text AS company_id, o.updated_at::text AS updated_at_text
    FROM organizations o
    WHERE o.company_id IS NOT NULL
      AND (o.company_facts_pushed_at IS NULL OR o.updated_at > o.company_facts_pushed_at)
    ORDER BY o.id
    LIMIT ${limit}
  `)) as unknown as Array<OrganizationRow & { company_id: string; updated_at_text: string }>;
  if (orgs.length === 0) return 0;
  const writes = orgs
    .map((o) => ({ org: o, facts: companyFactsOf(o) }))
    .filter((w) => Object.keys(w.facts).length > 0);
  const toWrite = (w: (typeof writes)[number]) => ({
    brandId: w.org.company_id,
    source: COMPANY_FACTS_SOURCE,
    observedAt: new Date(w.org.updated_at).toISOString(),
    facts: w.facts,
  });
  try {
    await writeCompanyFacts(writes.map(toWrite));
  } catch (err) {
    if (!(err instanceof CompanyServiceError) || (err.status !== 400 && err.status !== 404)) throw err;
    // One refused value refuses the whole batch: write them one by one so the rest land.
    for (const w of writes) {
      try {
        await writeCompanyFacts([toWrite(w)]);
      } catch (one) {
        if (!(one instanceof CompanyServiceError) || (one.status !== 400 && one.status !== 404)) throw one;
        console.error(
          `[lead-service] identity sweep: brand-service refused the facts of organization ${w.org.id} ` +
            `(company ${w.org.company_id}): ${messageOf(one)}`,
        );
      }
    }
  }
  await markFactsPushed(orgs);
  return orgs.length;
}

interface PendingLead extends LeadKeyRow {
  has_employer: boolean;
  organization_id: string | null;
  company_id: string | null;
}

/** Pass 3: resolve up to `limit` leads whose employer (if any) is resolved. */
export async function resolveLeads(limit = LEAD_BATCH): Promise<{ resolved: number; failed: number }> {
  const rows = (await db.execute(sql`
    SELECT l.id::text AS lead_id, l.apollo_person_id, l.metadata->>'provider' AS provider, l.linkedin_url,
      (SELECT array_agg(c.value ORDER BY c.created_at, c.value) FROM lead_contact_methods c
        WHERE c.lead_id = l.id AND c.channel = 'email') AS emails,
      (SELECT array_agg(c.value ORDER BY c.created_at, c.value) FROM lead_contact_methods c
        WHERE c.lead_id = l.id AND c.channel = 'phone') AS phones,
      (cur.organization_id IS NOT NULL) AS has_employer,
      cur.organization_id::text AS organization_id,
      o.company_id::text AS company_id
    FROM leads l
    LEFT JOIN LATERAL (${CURRENT_ORG}) cur ON true
    LEFT JOIN organizations o ON o.id = cur.organization_id
    WHERE l.identity_resolved_at IS NULL
      AND (cur.organization_id IS NULL OR o.company_resolved_at IS NOT NULL)
    ORDER BY l.created_at, l.id
    LIMIT ${limit}
  `)) as unknown as PendingLead[];
  if (rows.length === 0) return { resolved: 0, failed: 0 };

  const done: Array<{ id: string; humanId: string; companyId: string; organizationId: string }> = [];
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const keys = humanKeysOf(row);
      let humanId: string | null = null;
      if (hasAnyKey(keys)) {
        try {
          humanId = (await resolveHuman({ ...keys, create: true })).humanId;
        } catch (err) {
          // A 400 names a key human-service will never accept: the lead stays without a human,
          // resolved (asking again cannot change it). Anything else is retried next tick.
          if (err instanceof HumanIdentityError && err.status === 400) {
            console.error(`[lead-service] identity sweep: human-service refused the keys of lead ${row.lead_id}: ${err.message}`);
          } else {
            failed++;
            console.error(`[lead-service] identity sweep: resolving lead ${row.lead_id} failed: ${errorMessage(err)}`);
            continue;
          }
        }
      }
      done.push({ id: row.lead_id, humanId: humanId ?? "", companyId: row.company_id ?? "", organizationId: row.organization_id ?? "" });
    }
  };
  await Promise.all(Array.from({ length: Math.min(HUMAN_RESOLVE_CONCURRENCY, rows.length) }, worker));

  if (done.length > 0) {
    await db.execute(sql`
      UPDATE leads l
      SET human_id = NULLIF(v.human_id, '')::uuid,
          company_id = NULLIF(v.company_id, '')::uuid,
          organization_id = NULLIF(v.organization_id, '')::uuid,
          identity_resolved_at = now()
      FROM unnest(${sql.param(done.map((d) => d.id))}::uuid[],
                  ${sql.param(done.map((d) => d.humanId))}::text[],
                  ${sql.param(done.map((d) => d.companyId))}::text[],
                  ${sql.param(done.map((d) => d.organizationId))}::text[]) AS v(id, human_id, company_id, organization_id)
      WHERE l.id = v.id AND l.identity_resolved_at IS NULL
    `);
  }
  return { resolved: done.length, failed };
}

/**
 * Pass 4: a lead resolved before 0077 carries no local company row: fill it with the current employer
 * the sweep resolved it at (same winner), 5000 at a time. Leads without an employer are not selected.
 */
export async function fillLeadOrganizations(limit = 5000): Promise<number> {
  const rows = (await db.execute(sql`
    WITH pick AS (
      SELECT l.id, (${CURRENT_ORG}) AS org_id
      FROM leads l
      WHERE l.identity_resolved_at IS NOT NULL AND l.organization_id IS NULL
        AND EXISTS (SELECT 1 FROM leads_organizations lo WHERE lo.lead_id = l.id AND lo.current = true)
      ORDER BY l.id
      LIMIT ${limit}
    )
    UPDATE leads l SET organization_id = pick.org_id FROM pick
    WHERE l.id = pick.id AND pick.org_id IS NOT NULL
    RETURNING l.id
  `)) as unknown as unknown[];
  return rows.length;
}

/**
 * Pass 5: a name-only employer that later got a safe identity (a serve brought its domain) moves its
 * leads from the local key to the brand id: `company_id` filled where the lead's local row now has one.
 */
export async function adoptResolvedCompanies(limit = 5000): Promise<number> {
  const rows = (await db.execute(sql`
    WITH pick AS (
      SELECT l.id, o.company_id
      FROM leads l JOIN organizations o ON o.id = l.organization_id
      WHERE l.company_id IS NULL AND o.company_id IS NOT NULL
      LIMIT ${limit}
    )
    UPDATE leads l SET company_id = pick.company_id FROM pick WHERE l.id = pick.id
    RETURNING l.id
  `)) as unknown as unknown[];
  // A company mark stated on the local key follows the company to its brand id (one already on the
  // brand id for the same brand/offer wins; the local one stays, read by nobody).
  await db.execute(sql`
    UPDATE company_disqualification_marks m SET company_key = o.company_id::text, updated_at = now()
    FROM organizations o
    WHERE m.company_key = 'org:' || o.id::text AND o.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM company_disqualification_marks t
        WHERE t.org_id = m.org_id AND t.brand_id = m.brand_id AND t.offer_key = m.offer_key AND t.company_key = o.company_id::text)
  `);
  return rows.length;
}

/**
 * Pass 6: a resolved lead with NO employer is at the company its work address names (a signup, a named
 * person): brand-service resolves the address's domain, once per lead (`email_company_checked_at`). A
 * free-mail address names no company: checked, nothing set.
 */
export async function resolveEmailCompanies(limit = MAX_COMPANIES_PER_REQUEST): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT l.id::text AS lead_id,
      (SELECT c.value FROM lead_contact_methods c WHERE c.lead_id = l.id AND c.channel = 'email'
        ORDER BY c.created_at, c.value LIMIT 1) AS email
    FROM leads l
    WHERE l.identity_resolved_at IS NOT NULL AND l.email_company_checked_at IS NULL
      AND l.company_id IS NULL AND l.organization_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM leads_organizations lo WHERE lo.lead_id = l.id AND lo.current = true)
    ORDER BY l.id
    LIMIT ${limit}
  `)) as unknown as Array<{ lead_id: string; email: string | null }>;
  if (rows.length === 0) return 0;
  const withDomain = rows.map((r) => ({ ...r, domain: workEmailDomain(r.email) })).filter((r) => r.domain);
  const results = await resolveCompanies(withDomain.map((r) => ({ ref: r.lead_id, domain: r.domain })));
  const companyOf = new Map(results.map((r) => [withDomain[r.index].lead_id, r.brandId ?? ""]));
  await db.execute(sql`
    UPDATE leads l
    SET company_id = COALESCE(l.company_id, NULLIF(v.company_id, '')::uuid), email_company_checked_at = now()
    FROM unnest(${sql.param(rows.map((r) => r.lead_id))}::uuid[], ${sql.param(rows.map((r) => companyOf.get(r.lead_id) ?? ""))}::text[])
      AS v(id, company_id)
    WHERE l.id = v.id
  `);
  return rows.length;
}

export interface LeadIdentityCounts {
  leads: number;
  resolved: number;
  pending: number;
  withHuman: number;
  withCompany: number;
  noEmployer: number;
  noSafeCompanyIdentity: number;
  employersResolved: number;
  employersPending: number;
  employersFactsPending: number;
  /** (human, company) pairs held by more than one lead: the same person twice at one company. */
  duplicateHumanCompanyPairs: number;
}

/** What the sweep has done so far (GET /internal/lead-identity/status). */
export async function leadIdentityCounts(): Promise<LeadIdentityCounts> {
  const [l] = (await db.execute(sql`
    SELECT count(*)::int AS leads,
      count(*) FILTER (WHERE identity_resolved_at IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE identity_resolved_at IS NULL)::int AS pending,
      count(*) FILTER (WHERE human_id IS NOT NULL)::int AS with_human,
      count(*) FILTER (WHERE company_id IS NOT NULL)::int AS with_company,
      count(*) FILTER (WHERE identity_resolved_at IS NOT NULL AND company_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM leads_organizations lo WHERE lo.lead_id = leads.id AND lo.current = true))::int AS no_employer,
      count(*) FILTER (WHERE identity_resolved_at IS NOT NULL AND company_id IS NULL
        AND EXISTS (SELECT 1 FROM leads_organizations lo WHERE lo.lead_id = leads.id AND lo.current = true))::int AS no_safe
    FROM leads
  `)) as unknown as Array<Record<string, number>>;
  const [o] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE company_resolved_at IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE company_resolved_at IS NULL
        AND EXISTS (SELECT 1 FROM leads_organizations lo WHERE lo.organization_id = organizations.id AND lo.current = true))::int AS pending,
      count(*) FILTER (WHERE company_id IS NOT NULL
        AND (company_facts_pushed_at IS NULL OR updated_at > company_facts_pushed_at))::int AS facts_pending
    FROM organizations
  `)) as unknown as Array<Record<string, number>>;
  const [d] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM leads WHERE human_id IS NOT NULL AND company_id IS NOT NULL
      GROUP BY human_id, company_id HAVING count(*) > 1
    ) x
  `)) as unknown as Array<{ n: number }>;
  return {
    leads: l.leads,
    resolved: l.resolved,
    pending: l.pending,
    withHuman: l.with_human,
    withCompany: l.with_company,
    noEmployer: l.no_employer,
    noSafeCompanyIdentity: l.no_safe,
    employersResolved: o.resolved,
    employersPending: o.pending,
    employersFactsPending: o.facts_pending,
    duplicateHumanCompanyPairs: d.n,
  };
}

/** One tick: employers, then their facts, then leads. Returns whether anything was left to do. */
export async function sweepLeadIdentityOnce(): Promise<boolean> {
  const employers = await resolveEmployers();
  const facts = await pushEmployerFacts();
  const people = await resolveLeads();
  const organized = await fillLeadOrganizations();
  const adopted = await adoptResolvedCompanies();
  const byEmail = await resolveEmailCompanies();
  if (employers + facts + people.resolved + organized + adopted + byEmail > 0) {
    console.log(
      `[lead-service] identity sweep: employers=${employers} facts=${facts} leads=${people.resolved} failed=${people.failed} ` +
        `organized=${organized} adopted=${adopted} byEmail=${byEmail}`,
    );
  }
  return employers > 0 || facts > 0 || people.resolved > 0 || organized > 0 || adopted > 0 || byEmail > 0;
}

let running = false;

export function startLeadIdentityWorker(): void {
  const loop = async () => {
    if (running) return;
    running = true;
    let busy = false;
    try {
      busy = await sweepLeadIdentityOnce();
    } catch (err) {
      console.error("[lead-service] identity sweep failed (retried next tick):", err);
    } finally {
      running = false;
      setTimeout(() => void loop(), busy ? BUSY_TICK_MS : IDLE_TICK_MS).unref();
    }
  };
  setTimeout(() => void loop(), FIRST_SWEEP_DELAY_MS).unref();
}
