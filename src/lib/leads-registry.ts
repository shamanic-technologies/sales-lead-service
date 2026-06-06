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
  organizationLatestFundingStage: "latestFundingStage",
  organizationLatestFundingRoundDate: "latestFundingRoundDate",
  organizationTotalFunding: "totalFunding",
  organizationTotalFundingPrinted: "totalFundingPrinted",
  organizationRetailLocationCount: "retailLocationCount",
  organizationPubliclyTradedSymbol: "publiclyTradedSymbol",
  organizationPubliclyTradedExchange: "publiclyTradedExchange",
  organizationPrimaryPhone: "primaryPhone",
  organizationSeoDescription: "seoDescription",
  organizationAngellistUrl: "angellistUrl",
  organizationNumSuborganizations: "numSuborganizations",
  organizationAlexaRanking: "alexaRanking",
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
  if (person.organizationFundingEvents) out.fundingEvents = person.organizationFundingEvents;
  if (person.organizationKeywords) out.keywords = person.organizationKeywords;
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

export type UpsertContactResult =
  | { inserted: true }
  | { inserted: false; reason: "global_collision" };

/**
 * Upsert a lead contact method (email/phone/twitter/etc.).
 *
 * Two unique indexes apply:
 *   - idx_lcm_lead_channel_value (lead_id, channel, value) — same-lead re-enrichment, handled by ON CONFLICT DO UPDATE.
 *   - idx_lcm_channel_value (channel, value)               — global "one email = one lead" invariant.
 *
 * When the second collides (Apollo returns an email already attached to a different lead — e.g. role
 * inboxes, executive-assistant addresses, or Apollo person-id churn), Postgres raises 23505 because
 * ON CONFLICT can target only one constraint. We catch that specific case and return
 * { inserted: false, reason: "global_collision" } so the caller can fall back to alternate emails
 * (Apollo's personalEmails[]) or mark the lead as skipped under a distinct status reason.
 */
export async function upsertContactMethod(params: {
  leadId: string;
  channel: string;
  value: string;
  status?: string | null;
  source: string;
}): Promise<UpsertContactResult> {
  try {
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
    return { inserted: true };
  } catch (err) {
    if (isGlobalContactDupKey(err)) {
      return { inserted: false, reason: "global_collision" };
    }
    throw err;
  }
}

function isGlobalContactDupKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint_name?: string };
  return e.code === "23505" && e.constraint_name === "idx_lcm_channel_value";
}

/**
 * Reuse an existing organization with the same name instead of minting a fresh
 * placeholder row on every enrichment. Apollo employment-history entries that
 * don't match the person's top-level (enriched) org have only a name — inserting
 * a brand-new uuid'd org each time defeats the (leadId, orgId, startDate) dedup
 * and accumulates duplicate bare orgs without bound. Reuse by name; insert only
 * when none exists.
 */
async function resolveHistoryOrgId(name: string): Promise<string | null> {
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, name))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(organizations)
    .values({ name })
    .returning({ id: organizations.id });
  return inserted[0]?.id ?? null;
}

/**
 * Mark the lead's link to `organizationId` as the current employer, idempotent on
 * (leadId, organizationId). Updates the existing link in place when present (so
 * re-enrichment never grows the row count); inserts otherwise.
 */
async function markCurrentEmployment(
  leadId: string,
  organizationId: string,
  title: string | null,
): Promise<void> {
  const existing = await db
    .select({ id: leadsOrganizations.id })
    .from(leadsOrganizations)
    .where(
      and(
        eq(leadsOrganizations.leadId, leadId),
        eq(leadsOrganizations.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(leadsOrganizations)
      .set({ current: true, title })
      .where(eq(leadsOrganizations.id, existing[0].id));
    return;
  }
  await db.insert(leadsOrganizations).values({ leadId, organizationId, title, current: true });
}

/**
 * Persist current + past employment from an Apollo person.
 *
 * Apollo re-asserts "current" on every enrichment WITHOUT expiring the prior
 * employment, so a lead would otherwise accumulate multiple current=true rows
 * (the read path then picks the wrong one — see lead-shape.ts pickCurrentEmployment).
 * Here we enforce exactly ONE current employer per lead at write time, history-
 * preserving (no rows deleted):
 *   1. Expire the current flag on all existing rows for this lead.
 *   2. Resolve the canonical current employer — the person's top-level (enriched)
 *      org when present, else the history entry Apollo flags current.
 *   3. Record past employment with current=false (orgs reused by name, not churned).
 *   4. Mark exactly the canonical current employer current=true.
 *
 * Idempotent on re-enrichment: org ids are stable (top-level by apolloId, history
 * by name), the current link is upserted, and history rows dedup on
 * (leadId, organizationId, startDate) — so re-running does not grow row count.
 */
export async function recordEmploymentHistory(params: {
  leadId: string;
  person: ApolloPersonResult;
}): Promise<void> {
  const { leadId, person } = params;

  await db
    .update(leadsOrganizations)
    .set({ current: false })
    .where(and(eq(leadsOrganizations.leadId, leadId), eq(leadsOrganizations.current, true)));

  const orgId = await upsertOrganizationFromPerson(person);

  // Canonical current employer: top-level org wins; otherwise fall back to the
  // first history entry Apollo flags current (search-time leads with no top-level org).
  let currentOrgId: string | null = orgId;
  let currentTitle: string | null = orgId ? person.title ?? null : null;

  const history = person.employmentHistory ?? [];
  for (const job of history) {
    if (!job.organizationName) continue;
    const jobOrgId =
      job.organizationName === person.organizationName && orgId
        ? orgId
        : await resolveHistoryOrgId(job.organizationName);
    if (!jobOrgId) continue;

    if (!currentOrgId && job.current === true) {
      currentOrgId = jobOrgId;
      currentTitle = job.title ?? null;
    }

    // The canonical current employer is marked separately below.
    if (jobOrgId === currentOrgId) continue;

    await db
      .insert(leadsOrganizations)
      .values({
        leadId,
        organizationId: jobOrgId,
        title: job.title ?? null,
        startDate: job.startDate ?? null,
        endDate: job.endDate ?? null,
        current: false,
        description: job.description ?? null,
      })
      .onConflictDoNothing();
  }

  if (currentOrgId) {
    await markCurrentEmployment(leadId, currentOrgId, currentTitle);
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
