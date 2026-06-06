import { eq, inArray, asc } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  leads,
  leadsOrganizations,
  organizations,
  leadContactMethods,
} from "../db/schema.js";

export interface FundingEventView {
  id: string | null;
  date: string | null;
  type: string | null;
  investors: string | null;
  amount: number | null;
  currency: string | null;
  newsUrl: string | null;
}

export interface OrganizationView {
  id: string;
  apolloOrganizationId: string | null;
  name: string | null;
  primaryDomain: string | null;
  websiteUrl: string | null;
  industry: string | null;
  estimatedNumEmployees: number | null;
  annualRevenue: string | null;
  logoUrl: string | null;
  shortDescription: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  facebookUrl: string | null;
  blogUrl: string | null;
  crunchbaseUrl: string | null;
  foundedYear: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  technologyNames: string[] | null;
  industries: string[] | null;
  secondaryIndustries: string[] | null;
  latestFundingStage: string | null;
  latestFundingRoundDate: string | null;
  totalFunding: string | null;
  totalFundingPrinted: string | null;
  fundingEvents: FundingEventView[];
  retailLocationCount: number | null;
  publiclyTradedSymbol: string | null;
  publiclyTradedExchange: string | null;
  primaryPhone: string | null;
  seoDescription: string | null;
  angellistUrl: string | null;
  numSuborganizations: number | null;
  alexaRanking: number | null;
  keywords: string[] | null;
}

export interface ContactMethodView {
  channel: string;
  value: string;
  status: string | null;
  source: string;
}

export interface EmploymentEntryView {
  organizationId: string;
  organizationName: string | null;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  description: string | null;
}

export interface FullLead {
  leadId: string;
  apolloPersonId: string | null;
  firstName: string;
  lastName: string;
  name: string | null;
  headline: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  seniority: string | null;
  departments: string[] | null;
  subdepartments: string[] | null;
  functions: string[] | null;
  twitterUrl: string | null;
  githubUrl: string | null;
  facebookUrl: string | null;
  enrichedAt: string | null;
  currentTitle: string | null;
  organization: OrganizationView | null;
  contacts: ContactMethodView[];
  employmentHistory: EmploymentEntryView[];
}

function mapFundingEvents(raw: unknown): FundingEventView[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      id: typeof e.id === "string" ? e.id : null,
      date: typeof e.date === "string" ? e.date : null,
      type: typeof e.type === "string" ? e.type : null,
      investors: typeof e.investors === "string" ? e.investors : null,
      amount: typeof e.amount === "number" ? e.amount : null,
      currency: typeof e.currency === "string" ? e.currency : null,
      newsUrl: typeof e.news_url === "string" ? e.news_url : null,
    };
  });
}

function mapOrganizationView(row: typeof organizations.$inferSelect): OrganizationView {
  return {
    id: row.id,
    apolloOrganizationId: row.apolloOrganizationId ?? null,
    name: row.name ?? null,
    primaryDomain: row.primaryDomain ?? null,
    websiteUrl: row.websiteUrl ?? null,
    industry: row.industry ?? null,
    estimatedNumEmployees: row.estimatedNumEmployees ?? null,
    annualRevenue: row.annualRevenue ?? null,
    logoUrl: row.logoUrl ?? null,
    shortDescription: row.shortDescription ?? null,
    linkedinUrl: row.linkedinUrl ?? null,
    twitterUrl: row.twitterUrl ?? null,
    facebookUrl: row.facebookUrl ?? null,
    blogUrl: row.blogUrl ?? null,
    crunchbaseUrl: row.crunchbaseUrl ?? null,
    foundedYear: row.foundedYear ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    country: row.country ?? null,
    streetAddress: row.streetAddress ?? null,
    postalCode: row.postalCode ?? null,
    technologyNames: row.technologyNames ?? null,
    industries: row.industries ?? null,
    secondaryIndustries: row.secondaryIndustries ?? null,
    latestFundingStage: row.latestFundingStage ?? null,
    latestFundingRoundDate: row.latestFundingRoundDate ?? null,
    totalFunding: row.totalFunding ?? null,
    totalFundingPrinted: row.totalFundingPrinted ?? null,
    fundingEvents: mapFundingEvents(row.fundingEvents),
    retailLocationCount: row.retailLocationCount ?? null,
    publiclyTradedSymbol: row.publiclyTradedSymbol ?? null,
    publiclyTradedExchange: row.publiclyTradedExchange ?? null,
    primaryPhone: row.primaryPhone ?? null,
    seoDescription: row.seoDescription ?? null,
    angellistUrl: row.angellistUrl ?? null,
    numSuborganizations: row.numSuborganizations ?? null,
    alexaRanking: row.alexaRanking ?? null,
    keywords: row.keywords ?? null,
  };
}

/**
 * An org row is "enriched" when it carries a logo or a primary domain — the two
 * fields the dashboard needs to render a company logo. Bare placeholder orgs
 * (name-only, inserted by Apollo employment-history ingestion) have neither.
 */
function isEnrichedOrg(org: typeof organizations.$inferSelect | null | undefined): boolean {
  return !!org && (org.logoUrl != null || org.primaryDomain != null);
}

interface CurrentEmploymentCandidate {
  current: boolean;
  organizationId: string;
  empCreatedAt: Date | null;
  org: typeof organizations.$inferSelect | null;
}

/**
 * Select the lead's REAL current employer among employment rows.
 *
 * A large majority of leads carry MORE THAN ONE row flagged `current = true`
 * (Apollo enrichment appends a new current employment without clearing the
 * prior one's flag). The earliest such row is systematically the bare,
 * un-enriched placeholder org (no logo, no domain); the enriched org is a newer
 * current row. Picking the earliest therefore drops the logo.
 *
 * Selection order among `current = true` rows (pure read-time, no data mutation):
 *   1. ENRICHED org first (logo_url OR primary_domain non-null)
 *   2. most-recently-created employment (createdAt DESC)
 *   3. organizationId (stable, deterministic final tiebreak)
 *
 * Returns undefined only when the lead has no current employment at all.
 */
function pickCurrentEmployment<T extends CurrentEmploymentCandidate>(rows: T[]): T | undefined {
  const currentRows = rows.filter((r) => r.current === true);
  if (currentRows.length === 0) return undefined;
  return [...currentRows].sort((a, b) => {
    const ae = isEnrichedOrg(a.org) ? 1 : 0;
    const be = isEnrichedOrg(b.org) ? 1 : 0;
    if (ae !== be) return be - ae;
    const ta = a.empCreatedAt instanceof Date ? a.empCreatedAt.getTime() : 0;
    const tb = b.empCreatedAt instanceof Date ? b.empCreatedAt.getTime() : 0;
    if (ta !== tb) return tb - ta;
    return a.organizationId < b.organizationId ? -1 : a.organizationId > b.organizationId ? 1 : 0;
  })[0];
}

export async function buildFullLead(leadId: string): Promise<FullLead> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) {
    throw new Error(`[lead-service] buildFullLead: lead ${leadId} not found`);
  }

  const contactRows = await db.query.leadContactMethods.findMany({
    where: eq(leadContactMethods.leadId, leadId),
    orderBy: (table, { asc: ascFn }) => [ascFn(table.createdAt)],
  });
  const contacts: ContactMethodView[] = contactRows.map((row) => ({
    channel: row.channel,
    value: row.value,
    status: row.status ?? null,
    source: row.source,
  }));

  const employmentRows = await db
    .select({
      organizationId: leadsOrganizations.organizationId,
      title: leadsOrganizations.title,
      startDate: leadsOrganizations.startDate,
      endDate: leadsOrganizations.endDate,
      current: leadsOrganizations.current,
      description: leadsOrganizations.description,
      empCreatedAt: leadsOrganizations.createdAt,
      org: organizations,
    })
    .from(leadsOrganizations)
    .leftJoin(organizations, eq(organizations.id, leadsOrganizations.organizationId))
    .where(eq(leadsOrganizations.leadId, leadId));

  const currentEmp = pickCurrentEmployment(employmentRows);
  const organization: OrganizationView | null = currentEmp?.org
    ? mapOrganizationView(currentEmp.org)
    : null;

  const employmentHistory: EmploymentEntryView[] = employmentRows.map((row) => ({
    organizationId: row.organizationId,
    organizationName: row.org?.name ?? null,
    title: row.title ?? null,
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
    current: row.current,
    description: row.description ?? null,
  }));

  return {
    leadId: lead.id,
    apolloPersonId: lead.apolloPersonId ?? null,
    firstName: lead.firstName ?? "",
    lastName: lead.lastName ?? "",
    name: lead.name ?? null,
    headline: lead.headline ?? null,
    linkedinUrl: lead.linkedinUrl ?? null,
    photoUrl: lead.photoUrl ?? null,
    city: lead.city ?? null,
    state: lead.state ?? null,
    country: lead.country ?? null,
    seniority: lead.seniority ?? null,
    departments: lead.departments ?? null,
    subdepartments: lead.subdepartments ?? null,
    functions: lead.functions ?? null,
    twitterUrl: lead.twitterUrl ?? null,
    githubUrl: lead.githubUrl ?? null,
    facebookUrl: lead.facebookUrl ?? null,
    enrichedAt: lead.enrichedAt ? lead.enrichedAt.toISOString() : null,
    currentTitle: currentEmp?.title ?? null,
    organization,
    contacts,
    employmentHistory,
  };
}

// Batched version: fetches FullLead data for N leadIds in 3 DB queries (vs 5N sequential).
// Used by list endpoints (/orgs/leads) where N can reach thousands.
// Same FullLead shape as buildFullLead. Missing leadIds (deleted between caller queries)
// are omitted from the result Map rather than throwing.
export async function buildFullLeadsBatch(
  leadIds: string[],
): Promise<Map<string, FullLead>> {
  const result = new Map<string, FullLead>();
  if (leadIds.length === 0) return result;

  const [leadRows, contactRows, empJoinRows] = await Promise.all([
    db.select().from(leads).where(inArray(leads.id, leadIds)),
    db
      .select()
      .from(leadContactMethods)
      .where(inArray(leadContactMethods.leadId, leadIds))
      .orderBy(asc(leadContactMethods.createdAt)),
    db
      .select({
        leadId: leadsOrganizations.leadId,
        organizationId: leadsOrganizations.organizationId,
        title: leadsOrganizations.title,
        startDate: leadsOrganizations.startDate,
        endDate: leadsOrganizations.endDate,
        current: leadsOrganizations.current,
        description: leadsOrganizations.description,
        empCreatedAt: leadsOrganizations.createdAt,
        org: organizations,
      })
      .from(leadsOrganizations)
      .leftJoin(organizations, eq(organizations.id, leadsOrganizations.organizationId))
      .where(inArray(leadsOrganizations.leadId, leadIds)),
  ]);

  const contactsByLeadId = new Map<string, ContactMethodView[]>();
  for (const row of contactRows) {
    const list = contactsByLeadId.get(row.leadId) ?? [];
    list.push({
      channel: row.channel,
      value: row.value,
      status: row.status ?? null,
      source: row.source,
    });
    contactsByLeadId.set(row.leadId, list);
  }

  const empByLeadId = new Map<string, typeof empJoinRows>();
  for (const row of empJoinRows) {
    const list = empByLeadId.get(row.leadId) ?? [];
    list.push(row);
    empByLeadId.set(row.leadId, list);
  }

  for (const lead of leadRows) {
    const empRows = empByLeadId.get(lead.id) ?? [];

    const currentEmp = pickCurrentEmployment(empRows);

    const organization: OrganizationView | null = currentEmp?.org
      ? mapOrganizationView(currentEmp.org)
      : null;

    const employmentHistory: EmploymentEntryView[] = empRows.map((row) => ({
      organizationId: row.organizationId,
      organizationName: row.org?.name ?? null,
      title: row.title ?? null,
      startDate: row.startDate ?? null,
      endDate: row.endDate ?? null,
      current: row.current,
      description: row.description ?? null,
    }));

    result.set(lead.id, {
      leadId: lead.id,
      apolloPersonId: lead.apolloPersonId ?? null,
      firstName: lead.firstName ?? "",
      lastName: lead.lastName ?? "",
      name: lead.name ?? null,
      headline: lead.headline ?? null,
      linkedinUrl: lead.linkedinUrl ?? null,
      photoUrl: lead.photoUrl ?? null,
      city: lead.city ?? null,
      state: lead.state ?? null,
      country: lead.country ?? null,
      seniority: lead.seniority ?? null,
      departments: lead.departments ?? null,
      subdepartments: lead.subdepartments ?? null,
      functions: lead.functions ?? null,
      twitterUrl: lead.twitterUrl ?? null,
      githubUrl: lead.githubUrl ?? null,
      facebookUrl: lead.facebookUrl ?? null,
      enrichedAt: lead.enrichedAt ? lead.enrichedAt.toISOString() : null,
      currentTitle: currentEmp?.title ?? null,
      organization,
      contacts: contactsByLeadId.get(lead.id) ?? [],
      employmentHistory,
    });
  }

  return result;
}
