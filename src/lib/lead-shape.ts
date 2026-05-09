import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  leads,
  leadsOrganizations,
  organizations,
  leadContactMethods,
} from "../db/schema.js";

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
  organization: OrganizationView | null;
  contacts: ContactMethodView[];
  employmentHistory: EmploymentEntryView[];
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
  };
}

export async function buildFullLead(leadId: string): Promise<FullLead> {
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  if (!lead) {
    throw new Error(`[lead-service] buildFullLead: lead ${leadId} not found`);
  }

  const currentEmployment = await db.query.leadsOrganizations.findFirst({
    where: and(eq(leadsOrganizations.leadId, leadId), eq(leadsOrganizations.current, true)),
  });

  let organization: OrganizationView | null = null;
  if (currentEmployment) {
    const orgRow = await db.query.organizations.findFirst({
      where: eq(organizations.id, currentEmployment.organizationId),
    });
    if (orgRow) organization = mapOrganizationView(orgRow);
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
      organizationName: organizations.name,
      title: leadsOrganizations.title,
      startDate: leadsOrganizations.startDate,
      endDate: leadsOrganizations.endDate,
      current: leadsOrganizations.current,
      description: leadsOrganizations.description,
    })
    .from(leadsOrganizations)
    .leftJoin(organizations, eq(organizations.id, leadsOrganizations.organizationId))
    .where(eq(leadsOrganizations.leadId, leadId));

  const employmentHistory: EmploymentEntryView[] = employmentRows.map((row) => ({
    organizationId: row.organizationId,
    organizationName: row.organizationName ?? null,
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
    organization,
    contacts,
    employmentHistory,
  };
}

