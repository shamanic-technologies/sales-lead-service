import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  leads,
  leadContactMethods,
  organizations,
  leadsOrganizations,
  type NewLead,
  type NewOrganization,
} from "../db/schema.js";
import type { ApolloPersonResult } from "./apollo-client.js";

const PERSON_FIELDS = [
  "firstName",
  "lastName",
  "name",
  "linkedinUrl",
  "photoUrl",
  "headline",
  "city",
  "state",
  "country",
  "seniority",
  "departments",
  "subdepartments",
  "functions",
  "twitterUrl",
  "githubUrl",
  "facebookUrl",
] as const;

const ORG_FIELD_MAP: Record<string, keyof NewOrganization> = {
  organizationName: "name",
  organizationDomain: "primaryDomain",
  organizationWebsiteUrl: "websiteUrl",
  organizationIndustry: "industry",
  organizationLogoUrl: "logoUrl",
  organizationShortDescription: "shortDescription",
  organizationLinkedinUrl: "linkedinUrl",
  organizationTwitterUrl: "twitterUrl",
  organizationFacebookUrl: "facebookUrl",
  organizationBlogUrl: "blogUrl",
  organizationCrunchbaseUrl: "crunchbaseUrl",
  organizationFoundedYear: "foundedYear",
  organizationCity: "city",
  organizationState: "state",
  organizationCountry: "country",
  organizationStreetAddress: "streetAddress",
  organizationPostalCode: "postalCode",
};

function pickPersonFields(person: ApolloPersonResult): Partial<NewLead> {
  const out: Partial<NewLead> = {};
  for (const key of PERSON_FIELDS) {
    const v = (person as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && v !== "") {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

function pickOrgFields(person: ApolloPersonResult): Partial<NewOrganization> {
  const out: Partial<NewOrganization> = {};
  for (const [src, dst] of Object.entries(ORG_FIELD_MAP)) {
    const v = (person as Record<string, unknown>)[src];
    if (v !== undefined && v !== null && v !== "") {
      (out as Record<string, unknown>)[dst] = v;
    }
  }
  if (person.organizationSize) {
    const employees = parseInt(person.organizationSize, 10);
    if (!Number.isNaN(employees)) out.estimatedNumEmployees = employees;
  }
  if (person.organizationRevenueUsd) {
    out.annualRevenue = person.organizationRevenueUsd;
  }
  if (person.organizationTechnologyNames) out.technologyNames = person.organizationTechnologyNames;
  if (person.organizationIndustries) out.industries = person.organizationIndustries;
  if (person.organizationSecondaryIndustries) out.secondaryIndustries = person.organizationSecondaryIndustries;
  return out;
}

function rawMetadata(person: ApolloPersonResult): unknown {
  return person.raw ?? person;
}

/**
 * Upsert a lead by apolloPersonId, populating structured fields.
 * Returns the leadId.
 */
export async function upsertLeadFromPerson(
  person: ApolloPersonResult,
  options: { enriched: boolean },
): Promise<string> {
  const fields = pickPersonFields(person);
  const metadata = rawMetadata(person);
  const enrichedAt = options.enriched ? new Date() : null;

  if (person.id) {
    const existing = await db.query.leads.findFirst({
      where: eq(leads.apolloPersonId, person.id),
    });
    if (existing) {
      await db
        .update(leads)
        .set({
          ...fields,
          metadata,
          ...(enrichedAt ? { enrichedAt } : {}),
        })
        .where(eq(leads.id, existing.id));
      return existing.id;
    }
  }

  const inserted = await db
    .insert(leads)
    .values({
      apolloPersonId: person.id ?? null,
      ...fields,
      metadata,
      enrichedAt,
    })
    .returning({ id: leads.id });

  if (inserted[0]) return inserted[0].id;

  // Race: another inserter beat us — re-read by apolloPersonId.
  if (person.id) {
    const raced = await db.query.leads.findFirst({
      where: eq(leads.apolloPersonId, person.id),
    });
    if (raced) return raced.id;
  }
  throw new Error("[lead-service] upsertLeadFromPerson failed to insert or locate row");
}

/**
 * Upsert organization by apolloOrganizationId. Returns organizationId or null when person has no org.
 */
export async function upsertOrganizationFromPerson(person: ApolloPersonResult): Promise<string | null> {
  if (!person.organizationId && !person.organizationName) return null;
  const fields = pickOrgFields(person);

  if (person.organizationId) {
    const existing = await db.query.organizations.findFirst({
      where: eq(organizations.apolloOrganizationId, person.organizationId),
    });
    if (existing) {
      await db
        .update(organizations)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(organizations.id, existing.id));
      return existing.id;
    }
  }

  const inserted = await db
    .insert(organizations)
    .values({
      apolloOrganizationId: person.organizationId ?? null,
      ...fields,
    })
    .returning({ id: organizations.id });

  if (inserted[0]) return inserted[0].id;

  if (person.organizationId) {
    const raced = await db.query.organizations.findFirst({
      where: eq(organizations.apolloOrganizationId, person.organizationId),
    });
    if (raced) return raced.id;
  }
  return null;
}

/**
 * Upsert a lead contact method (email/phone/twitter/etc.). Idempotent on (leadId, channel, value).
 * On conflict the latest status + source overwrite the existing row so re-enrichment
 * (e.g. Apollo upgrading "unverified" → "verified") is reflected instead of being silently dropped.
 */
export async function upsertContactMethod(params: {
  leadId: string;
  channel: string;
  value: string;
  status?: string | null;
  source: string;
}): Promise<void> {
  await db
    .insert(leadContactMethods)
    .values({
      leadId: params.leadId,
      channel: params.channel,
      value: params.value,
      status: params.status ?? null,
      source: params.source,
    })
    .onConflictDoUpdate({
      target: [leadContactMethods.leadId, leadContactMethods.channel, leadContactMethods.value],
      set: {
        status: params.status ?? null,
        source: params.source,
      },
    });
}

/**
 * Persist current + past employment from an Apollo person. Idempotent on (leadId, organizationId, startDate).
 */
export async function recordEmploymentHistory(params: {
  leadId: string;
  person: ApolloPersonResult;
}): Promise<void> {
  const { leadId, person } = params;
  const orgId = await upsertOrganizationFromPerson(person);
  if (orgId) {
    await db
      .insert(leadsOrganizations)
      .values({
        leadId,
        organizationId: orgId,
        title: person.title ?? null,
        current: true,
      })
      .onConflictDoNothing();
  }

  const history = person.employmentHistory ?? [];
  for (const job of history) {
    if (!job.organizationName) continue;
    let jobOrgId: string | null = null;
    if (job.organizationName === person.organizationName && orgId) {
      jobOrgId = orgId;
    } else {
      const inserted = await db
        .insert(organizations)
        .values({ name: job.organizationName })
        .returning({ id: organizations.id });
      jobOrgId = inserted[0]?.id ?? null;
    }
    if (!jobOrgId) continue;

    await db
      .insert(leadsOrganizations)
      .values({
        leadId,
        organizationId: jobOrgId,
        title: job.title ?? null,
        startDate: job.startDate ?? null,
        endDate: job.endDate ?? null,
        current: !!job.current,
        description: job.description ?? null,
      })
      .onConflictDoNothing();
  }
}

/**
 * Find leadId by apolloPersonId.
 */
export async function findLeadByApolloPersonId(apolloPersonId: string): Promise<string | null> {
  const lead = await db.query.leads.findFirst({
    where: eq(leads.apolloPersonId, apolloPersonId),
  });
  return lead?.id ?? null;
}

/**
 * Find leadId by email (joins lead_contact_methods).
 */
export async function findLeadByEmail(email: string): Promise<string | null> {
  const row = await db.query.leadContactMethods.findFirst({
    where: and(eq(leadContactMethods.channel, "email"), eq(leadContactMethods.value, email)),
  });
  return row?.leadId ?? null;
}

/**
 * Returns true when the given lead has at least one email contact method.
 */
export async function leadHasEmail(leadId: string): Promise<boolean> {
  const result = await db
    .select({ exists: sql<boolean>`true` })
    .from(leadContactMethods)
    .where(and(eq(leadContactMethods.leadId, leadId), eq(leadContactMethods.channel, "email")))
    .limit(1);
  return result.length > 0;
}

/**
 * Get the primary email for a lead (most recently inserted).
 */
export async function getPrimaryEmail(leadId: string): Promise<{ email: string; status: string | null } | null> {
  const row = await db.query.leadContactMethods.findFirst({
    where: and(eq(leadContactMethods.leadId, leadId), eq(leadContactMethods.channel, "email")),
    orderBy: (methods, { desc }) => [desc(methods.createdAt)],
  });
  if (!row) return null;
  return { email: row.value, status: row.status };
}
