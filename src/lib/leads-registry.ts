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
import type { Person } from "./people-client.js";
import { findLeadBySocialLinkedin, foldSocialLead } from "./social-identity.js";
import type { ServedIdentity } from "./serve-identity.js";
import { writeEnrichedTimezone } from "./lead-timezone.js";

// Person fields the gateway's neutral Person provides that map 1:1 to lead columns.
// (departments / functions / twitter / github / facebook are NOT in the neutral
// shape — those columns simply stay null under the gateway.)
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
  "timezone",
  "businessLanguages",
] as const;

/**
 * The write path, exposed so a test can assert a field is actually carried onto
 * the lead. Presence in this list IS the mapping — `pickPersonFields` copies
 * every listed key straight off the neutral Person.
 */
export const PERSON_FIELDS_FOR_TEST = PERSON_FIELDS;

function pickPersonFields(person: Person): Partial<NewLead> {
  const out: Partial<NewLead> = {};
  for (const key of PERSON_FIELDS) {
    const v = (person as unknown as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && v !== "") {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

/** A non-empty array, or nothing. An empty array is not a value the producer stated. */
function arrayOrNull(v: string[] | null | undefined): string[] | undefined {
  return Array.isArray(v) && v.length > 0 ? v : undefined;
}

/**
 * Copy the neutral organization onto the organization row.
 *
 * Every field is written ONLY when the producer actually sent it: an absent key
 * and a null both leave the column alone, so a producer that serves the narrow
 * shape writes exactly what it wrote before, and a re-serve never blanks a column
 * a richer earlier serve (or the backfill) already filled. Nothing here is
 * derived — the values that reach this function are the values the provider
 * returned, carried through human-service verbatim.
 */
export function pickOrgFields(
  org: NonNullable<Person["organization"]>,
): Partial<NewOrganization> {
  const out: Partial<NewOrganization> = {};
  if (org.name) out.name = org.name;
  if (org.domain) out.primaryDomain = org.domain;
  if (org.websiteUrl) out.websiteUrl = org.websiteUrl;
  if (org.industry) out.industry = org.industry;
  if (org.logoUrl) out.logoUrl = org.logoUrl;
  if (org.linkedinUrl) out.linkedinUrl = org.linkedinUrl;
  if (org.city) out.city = org.city;
  if (org.state) out.state = org.state;
  if (org.country) out.country = org.country;
  if (org.estimatedNumEmployees != null) out.estimatedNumEmployees = org.estimatedNumEmployees;
  if (org.annualRevenue != null) out.annualRevenue = String(org.annualRevenue);

  // --- Widened surface: what apollo-service already holds, carried through. ---
  // NOTE: `providerOrganizationId` is deliberately NOT here. It is a UNIQUE join
  // key (`idx_organizations_apollo_organization_id`) while this service keys an
  // organization on its DOMAIN, then its name — so two rows here can legitimately
  // describe one Apollo organization, and an unguarded write raises 23505 and
  // fails the serve. `claimProviderOrganizationId` writes it only when it is free.
  if (org.shortDescription) out.shortDescription = org.shortDescription;
  if (org.seoDescription) out.seoDescription = org.seoDescription;
  const keywords = arrayOrNull(org.keywords);
  if (keywords) out.keywords = keywords;
  const technologyNames = arrayOrNull(org.technologyNames);
  if (technologyNames) out.technologyNames = technologyNames;
  const industries = arrayOrNull(org.industries);
  if (industries) out.industries = industries;
  const secondaryIndustries = arrayOrNull(org.secondaryIndustries);
  if (secondaryIndustries) out.secondaryIndustries = secondaryIndustries;
  if (org.latestFundingStage) out.latestFundingStage = org.latestFundingStage;
  if (org.latestFundingRoundDate) out.latestFundingRoundDate = org.latestFundingRoundDate;
  if (org.totalFunding != null) out.totalFunding = String(org.totalFunding);
  if (org.totalFundingPrinted) out.totalFundingPrinted = org.totalFundingPrinted;
  if (Array.isArray(org.fundingEvents) && org.fundingEvents.length > 0)
    out.fundingEvents = org.fundingEvents;
  if (org.foundedYear != null) out.foundedYear = org.foundedYear;
  if (org.twitterUrl) out.twitterUrl = org.twitterUrl;
  if (org.facebookUrl) out.facebookUrl = org.facebookUrl;
  if (org.blogUrl) out.blogUrl = org.blogUrl;
  if (org.crunchbaseUrl) out.crunchbaseUrl = org.crunchbaseUrl;
  if (org.angellistUrl) out.angellistUrl = org.angellistUrl;
  if (org.streetAddress) out.streetAddress = org.streetAddress;
  if (org.postalCode) out.postalCode = org.postalCode;
  if (org.primaryPhone) out.primaryPhone = org.primaryPhone;
  if (org.publiclyTradedSymbol) out.publiclyTradedSymbol = org.publiclyTradedSymbol;
  if (org.publiclyTradedExchange) out.publiclyTradedExchange = org.publiclyTradedExchange;
  if (org.numSuborganizations != null) out.numSuborganizations = org.numSuborganizations;
  if (org.retailLocationCount != null) out.retailLocationCount = org.retailLocationCount;
  if (org.alexaRanking != null) out.alexaRanking = org.alexaRanking;
  return out;
}

/**
 * Resolve the canonical lead for a person and upsert its structured fields.
 * Returns the leadId.
 *
 * Identity precedence — EMAIL OWNER FIRST:
 *   1. the lead that already owns `person.email` in lead_contact_methods
 *   2. the lead carrying `person.providerPersonId` (leads.apollo_person_id)
 *   3. the lead an engagement with our social posts made for this LinkedIn profile
 *      (social-identity.ts: a person known by their social identity before any email)
 *   4. a fresh row
 *
 * When 1 or 2 found the person AND an engager lead holds the same LinkedIn profile, the engager
 * lead is folded into it (its engagements move onto the person's timeline): one person, one lead.
 *
 * A person is ONE identity, and the email is the strongest key we have for it.
 * `idx_lcm_channel_value` makes "one email = one lead" a hard invariant, so once
 * a lead owns an email NO other lead can ever carry it. Attributing a serve to
 * any other lead therefore produces a permanently email-less lead: the read path
 * keys the email-gateway delivery overlay on the REGISTERED email, so such a
 * lead can never resolve contacted/sent/delivered and is invisible to every
 * consumer. Provider person ids churn (a re-crawl mints a new id for the same
 * human); an already-registered email does not.
 */
export async function upsertLeadFromPerson(
  person: Person,
  options: { enriched: boolean; identity?: ServedIdentity | null },
): Promise<string> {
  // The served person's local company row (keyed on domain, then name), read before picking the lead.
  const servedCompany: CompanyRef | null = options.identity
    ? {
        companyId: options.identity.companyId,
        organizationId: await upsertOrganizationFromPerson(person),
        name: person.organization?.name ?? null,
      }
    : null;
  const leadId = await pickAndUpsertLead(person, options, servedCompany);
  if (options.identity) await stampIdentity(leadId, options.identity, servedCompany?.organizationId ?? null);
  return leadId;
}

/**
 * Where a lead or a served person works: the brand-service company when it has a safe identity, and
 * the LOCAL organization row (the company key of a name-only employer, which brand-service never
 * identifies), with its name.
 */
export interface CompanyRef {
  companyId: string | null;
  organizationId: string | null;
  name: string | null;
}

async function leadCompanyOf(leadId: string): Promise<CompanyRef> {
  const rows = (await db.execute(sql`
    SELECT l.company_id::text AS company_id, l.organization_id::text AS organization_id, o.name
    FROM leads l LEFT JOIN organizations o ON o.id = l.organization_id
    WHERE l.id = ${leadId}
  `)) as unknown as Array<{ company_id: string | null; organization_id: string | null; name: string | null }>;
  const r = rows[0];
  return { companyId: r?.company_id ?? null, organizationId: r?.organization_id ?? null, name: r?.name ?? null };
}

/**
 * Is this ANOTHER company? true only on evidence: two different brand ids, or two different local
 * rows whose names differ too (a name spelled the same is the same employer). Unknown = false: a
 * lead is never split on a guess.
 */
export function isOtherCompany(lead: CompanyRef, served: CompanyRef): boolean {
  if (lead.companyId && served.companyId) return lead.companyId !== served.companyId;
  if (!lead.organizationId || !served.organizationId || lead.organizationId === served.organizationId) return false;
  if (!lead.name || !served.name) return false;
  return !sameOrganizationName(lead.name, served.name);
}

/** The human's lead at this company (oldest first when the same pair is held twice). */
export async function findLeadByHumanCompany(humanId: string, company: CompanyRef): Promise<string | null> {
  if (!company.companyId && !company.organizationId) return null;
  const rows = (await db.execute(
    company.companyId
      ? sql`SELECT id::text AS id FROM leads WHERE human_id = ${humanId} AND company_id = ${company.companyId}
            ORDER BY created_at, id LIMIT 1`
      : sql`SELECT id::text AS id FROM leads WHERE human_id = ${humanId} AND company_id IS NULL
              AND organization_id = ${company.organizationId}
            ORDER BY created_at, id LIMIT 1`,
  )) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** First answer wins: a lead's stored human/company is never overwritten here (merges are followed elsewhere). */
async function stampIdentity(leadId: string, identity: ServedIdentity, organizationId: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE leads SET
      human_id = COALESCE(human_id, ${identity.humanId}::uuid),
      company_id = COALESCE(company_id, ${identity.companyId}::uuid),
      organization_id = COALESCE(organization_id, ${organizationId}::uuid),
      identity_resolved_at = COALESCE(identity_resolved_at, now())
    WHERE id = ${leadId}
  `);
}

async function pickAndUpsertLead(
  person: Person,
  options: { enriched: boolean; identity?: ServedIdentity | null },
  servedCompany: CompanyRef | null,
): Promise<string> {
  // The enrichment's zone is written through its precedence guard (lead-timezone.ts): it replaces an
  // inferred zone, never one the client stated. A new lead takes it as is.
  const { timezone: enrichedTimezone, ...fields } = pickPersonFields(person);
  const metadata = person as unknown;
  const enrichedAt = options.enriched ? new Date() : null;

  if (!person.email && !person.providerPersonId) {
    throw new Error(
      "[lead-service] upsertLeadFromPerson: person has no providerPersonId and no email",
    );
  }

  const emailOwnerId = person.email ? await findLeadByEmail(person.email) : null;
  let providerOwnerId = person.providerPersonId
    ? await findLeadByApolloPersonId(person.providerPersonId)
    : null;
  // A lead is a HUMAN at a COMPANY (lead-identity.ts): with the serve's identity known, a provider
  // id held by the human's lead at ANOTHER company is not this lead (job change = new lead, clean
  // slate), and the human's lead at THIS company is. The address stays the strongest key: a lead
  // owning it is still the lead (one email = one lead); a person served at a new company with the
  // address their old lead holds is logged `identity.address_held_at_other_company` (measured).
  const identity = options.identity ?? null;
  let providerIdHeldElsewhere = false;
  if (identity && servedCompany && emailOwnerId) {
    const owner = await leadCompanyOf(emailOwnerId);
    if (isOtherCompany(owner, servedCompany)) {
      console.warn(
        `[lead-service] identity.address_held_at_other_company email=${person.email} leadId=${emailOwnerId} ` +
          `leadCompany=${owner.companyId ?? `org:${owner.organizationId}`} servedCompany=${servedCompany.companyId ?? `org:${servedCompany.organizationId}`}`,
      );
    }
  }
  if (identity && servedCompany && !emailOwnerId) {
    const atPair = identity.humanId ? await findLeadByHumanCompany(identity.humanId, servedCompany) : null;
    if (atPair) {
      providerOwnerId = atPair;
    } else if (providerOwnerId) {
      const held = await leadCompanyOf(providerOwnerId);
      if (isOtherCompany(held, servedCompany)) {
        console.log(
          `[lead-service] identity: job change, new lead (provider id ${person.providerPersonId} is held by lead ${providerOwnerId} ` +
            `at ${held.companyId ?? `org:${held.organizationId}`}, served at ${servedCompany.companyId ?? `org:${servedCompany.organizationId}`})`,
        );
        providerOwnerId = null;
        providerIdHeldElsewhere = true;
      }
    }
  }

  if (emailOwnerId && providerOwnerId && emailOwnerId !== providerOwnerId) {
    // Provider id churn: the same human exists twice in silver. The email owner
    // is the identity that can actually carry the email, so it wins.
    console.log(
      `[lead-service] identity: email owner wins over provider person id — email=${person.email} emailLeadId=${emailOwnerId} providerPersonId=${person.providerPersonId} providerLeadId=${providerOwnerId}`,
    );
  }

  const socialOwnerId = await findLeadBySocialLinkedin(person.linkedinUrl);
  if (socialOwnerId && !emailOwnerId && !providerOwnerId) {
    // An engager we held by their social identity only: this serve is the same person, now with an
    // email. The provider id is free (no lead holds it), so the engager's lead takes it.
    await db
      .update(leads)
      .set({
        ...fields,
        metadata,
        ...(person.providerPersonId ? { apolloPersonId: person.providerPersonId } : {}),
        ...(enrichedAt ? { enrichedAt } : {}),
      })
      .where(eq(leads.id, socialOwnerId));
    if (enrichedTimezone) await writeEnrichedTimezone(socialOwnerId, enrichedTimezone);
    return socialOwnerId;
  }

  const existingId = emailOwnerId ?? providerOwnerId;
  if (existingId && socialOwnerId && socialOwnerId !== existingId) {
    await foldSocialLead(socialOwnerId, existingId);
  }
  if (existingId) {
    await db
      .update(leads)
      .set({ ...fields, metadata, ...(enrichedAt ? { enrichedAt } : {}) })
      .where(eq(leads.id, existingId));
    if (enrichedTimezone) await writeEnrichedTimezone(existingId, enrichedTimezone);
    return existingId;
  }

  const inserted = await db
    .insert(leads)
    .values({
      // A job change: the provider id stays on the human's lead at the old company (it is unique).
      apolloPersonId: providerIdHeldElsewhere ? null : (person.providerPersonId ?? null),
      ...fields,
      ...(enrichedTimezone ? { timezone: enrichedTimezone, timezoneSource: "enrichment" } : {}),
      metadata,
      enrichedAt,
    })
    .returning({ id: leads.id });
  if (inserted[0]) return inserted[0].id;

  // Race: another writer inserted the same identity between our lookup and insert.
  const raced = person.providerPersonId
    ? await findLeadByApolloPersonId(person.providerPersonId)
    : person.email
      ? await findLeadByEmail(person.email)
      : null;
  if (raced) return raced;
  throw new Error("[lead-service] upsertLeadFromPerson failed to insert or locate the lead");
}

/**
 * Upsert organization from a neutral Person's top-level org. The gateway provides
 * no provider org id, so we key on primaryDomain (stable) and fall back to name.
 * Returns organizationId or null when the person has no org.
 */
/**
 * Record apollo's organization id on the row, but ONLY when no other row already
 * holds it.
 *
 * `idx_organizations_apollo_organization_id` is UNIQUE, and this service keys an
 * organization on its domain (then its name), so two rows here can describe one
 * Apollo organization — a past employer known only by name and the current
 * employer known by domain, most often. Writing the id unguarded therefore raises
 * `23505 duplicate key` on a path that must never fail a serve. The id is a join
 * key, not a fact the email is written from, so the correct behaviour when it is
 * already claimed is to leave it alone rather than to move it or to fail.
 */
async function claimProviderOrganizationId(
  organizationId: string,
  providerOrganizationId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE organizations
    SET apollo_organization_id = ${providerOrganizationId}
    WHERE id = ${organizationId}
      AND apollo_organization_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM organizations other
        WHERE other.apollo_organization_id = ${providerOrganizationId}
      )
  `);
}

export async function upsertOrganizationFromPerson(person: Person): Promise<string | null> {
  const org = person.organization;
  if (!org || (!org.domain && !org.name)) return null;
  const fields = pickOrgFields(org);

  const existing = org.domain
    ? await db.query.organizations.findFirst({ where: eq(organizations.primaryDomain, org.domain) })
    : await db.query.organizations.findFirst({ where: eq(organizations.name, org.name as string) });

  if (existing) {
    await db
      .update(organizations)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(organizations.id, existing.id));
    if (org.providerOrganizationId)
      await claimProviderOrganizationId(existing.id, org.providerOrganizationId);
    return existing.id;
  }

  const inserted = await db
    .insert(organizations)
    .values({ ...fields })
    .returning({ id: organizations.id });
  const insertedId = inserted[0]?.id ?? null;
  if (insertedId && org.providerOrganizationId)
    await claimProviderOrganizationId(insertedId, org.providerOrganizationId);
  return insertedId;
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
 * When the second collides (the provider returns an email already attached to a
 * different lead — role inboxes, EA addresses, person-id churn), Postgres raises
 * 23505 because ON CONFLICT can target only one constraint. We catch that specific
 * case and return { inserted: false, reason: "global_collision" } so the caller can
 * mark the lead skipped under a distinct status reason.
 */
export async function upsertContactMethod(params: {
  leadId: string;
  channel: string;
  value: string;
  status?: string | null;
  source: string;
  /** The address's verification verdict (src/lib/email-policy.ts). Absent = left as stored. */
  verificationVerdict?: string;
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
        ...(params.verificationVerdict ? { verificationVerdict: params.verificationVerdict } : {}),
      })
      .onConflictDoUpdate({
        target: [leadContactMethods.leadId, leadContactMethods.channel, leadContactMethods.value],
        set: {
          status: params.status ?? null,
          source: params.source,
          ...(params.verificationVerdict ? { verificationVerdict: params.verificationVerdict } : {}),
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

/**
 * Register `email` on `leadId` and return the lead that OWNS it afterwards.
 *
 * Normally that is `leadId` itself — `upsertLeadFromPerson` already resolves the
 * email owner first, so the insert succeeds. The re-resolution below covers the
 * race where a concurrent serve registered the same email on another lead
 * between that lookup and this insert.
 *
 * Either way the caller ends up with a lead whose email IS registered, so a
 * serve is never recorded against a lead whose delivery status can't resolve.
 * A collision we cannot resolve to an owner is a broken invariant, not a
 * warning: it fails loud.
 */
export async function registerServedEmail(params: {
  leadId: string;
  email: string;
  status: string | null;
  source: string;
  verificationVerdict?: string;
}): Promise<string> {
  const result = await upsertContactMethod({
    leadId: params.leadId,
    channel: "email",
    value: params.email,
    status: params.status,
    source: params.source,
    ...(params.verificationVerdict ? { verificationVerdict: params.verificationVerdict } : {}),
  });
  if (result.inserted) return params.leadId;

  const owner = await findLeadByEmail(params.email);
  if (!owner) {
    throw new Error(
      `[lead-service] email ${params.email} hit the global one-email-one-lead index but no owning lead could be found (leadId=${params.leadId})`,
    );
  }
  console.log(
    `[lead-service] identity: re-attributed serve to the lead that owns the email — email=${params.email} from=${params.leadId} to=${owner}`,
  );
  return owner;
}

function isGlobalContactDupKey(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; constraint_name?: string };
  return e.code === "23505" && e.constraint_name === "idx_lcm_channel_value";
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

/** ISO calendar date as the `date` columns store it, or nothing. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Normalize a provider-supplied employment date to `YYYY-MM-DD`.
 *
 * A value we cannot read as a calendar date yields null and says so in the log —
 * the ROLE is still recorded (it happened), it simply carries no date. Dropping
 * the whole row, or aborting the serve, would lose a career fact over a provider
 * formatting quirk; guessing a date would state something nobody told us.
 */
export function normalizeEmploymentDate(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!ISO_DATE.test(trimmed)) {
    console.log(`[lead-service] employment history: unreadable date, recorded as null — ${trimmed}`);
    return null;
  }
  return trimmed.slice(0, 10);
}

/**
 * The organization row for a PAST employer, which the provider knows by NAME
 * only (it carries no domain for one), keyed on that name. A past employer that
 * is also a known org — the same company someone else currently works at — lands
 * on that existing row and inherits its rich fields for free.
 */
async function findOrCreateOrganizationByName(name: string): Promise<string | null> {
  const existing = await db.query.organizations.findFirst({
    where: eq(organizations.name, name),
  });
  if (existing) return existing.id;
  const inserted = await db
    .insert(organizations)
    .values({ name })
    .returning({ id: organizations.id });
  return inserted[0]?.id ?? null;
}

function sameOrganizationName(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Persist the person's career history — EVERY role the producer served, not only
 * the current employer.
 *
 * Apollo has always returned the full list and human-service now carries it, so a
 * lead is no longer a single employment row: the LLM that writes the email can
 * see where this person worked before, which is exactly the kind of fact a cold
 * email is written from. The top-level `organization` stays the authoritative
 * record of the CURRENT employer — it is the only one carrying a domain and the
 * widened company fields — while a past employer is known by name alone.
 *
 * History-preserving and idempotent:
 *   1. Expire the current flag on every existing row for this lead.
 *   2. Upsert the top-level org (rich) — this is the current employer.
 *   3. Upsert one row per history entry, matched on (organization, start date).
 *      A pre-existing row for that organization carrying NO start date is ADOPTED
 *      rather than duplicated, so the single-row shape written before this landed
 *      converges instead of doubling.
 *   4. Mark exactly one row current — the entry the producer flagged, else the
 *      top-level organization.
 *
 * No row is ever deleted, and a producer that serves no history reproduces the
 * previous behaviour byte for byte.
 */
export async function recordEmploymentHistory(params: {
  leadId: string;
  person: Person;
}): Promise<void> {
  const { leadId, person } = params;

  await db
    .update(leadsOrganizations)
    .set({ current: false })
    .where(and(eq(leadsOrganizations.leadId, leadId), eq(leadsOrganizations.current, true)));

  const currentOrgId = await upsertOrganizationFromPerson(person);
  const currentOrgName = person.organization?.name ?? null;

  const history = Array.isArray(person.employmentHistory)
    ? person.employmentHistory.filter((e): e is NonNullable<typeof e> => Boolean(e))
    : [];

  if (history.length === 0) {
    if (currentOrgId) await markCurrentEmployment(leadId, currentOrgId, person.title ?? null);
    return;
  }

  const existingRows = await db
    .select({
      id: leadsOrganizations.id,
      organizationId: leadsOrganizations.organizationId,
      startDate: leadsOrganizations.startDate,
    })
    .from(leadsOrganizations)
    .where(eq(leadsOrganizations.leadId, leadId));

  // Resolve every role to an (organization, start date) BEFORE writing anything.
  //
  // Two things have to happen here rather than row by row. A person routinely
  // holds several CONCURRENT titles at ONE employer — "Founder & Chiropractor",
  // "Educator & National Speaker", "Founder & Director" all flagged current, all
  // with no start date — and those are one employment, not three: keying them
  // separately produced three `current = true` rows for one lead, which breaks
  // the one-current-employer invariant the read path depends on and makes
  // `currentTitle` a coin flip. And exactly one row may end up current, so the
  // decision needs the whole list in hand.
  interface ResolvedRole {
    organizationId: string;
    startDate: string | null;
    endDate: string | null;
    title: string | null;
    description: string | null;
    current: boolean;
  }
  const resolved: ResolvedRole[] = [];
  const byKey = new Map<string, ResolvedRole>();

  for (const entry of history) {
    const entryName = typeof entry.organizationName === "string" ? entry.organizationName : null;
    const isCurrent = entry.current === true;

    // The current role IS the top-level organization — same employer, richer row.
    let organizationId: string | null = null;
    if (
      isCurrent &&
      currentOrgId &&
      (!entryName || !currentOrgName || sameOrganizationName(entryName, currentOrgName))
    ) {
      organizationId = currentOrgId;
    } else if (entryName && entryName.trim().length > 0) {
      organizationId = await findOrCreateOrganizationByName(entryName.trim());
    }
    // A role naming no employer is not a row we can key on. It is not dropped
    // silently: the raw list stays on `leads.metadata` verbatim.
    if (!organizationId) continue;

    const startDate = normalizeEmploymentDate(entry.startDate);
    const endDate = normalizeEmploymentDate(entry.endDate);
    const title =
      (typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title : null) ??
      (isCurrent ? (person.title ?? null) : null);
    const description =
      typeof entry.description === "string" && entry.description.trim().length > 0
        ? entry.description
        : null;

    const key = `${organizationId}|${startDate ?? ""}`;
    const seen = byKey.get(key);
    if (seen) {
      // Same employer, same start: one employment wearing several titles. The
      // person's own title wins for the role they hold now; otherwise the first
      // title served stands.
      seen.current = seen.current || isCurrent;
      if (isCurrent && person.title) seen.title = person.title;
      seen.endDate = seen.endDate ?? endDate;
      seen.description = seen.description ?? description;
      continue;
    }
    const role: ResolvedRole = { organizationId, startDate, endDate, title, description, current: isCurrent };
    byKey.set(key, role);
    resolved.push(role);
  }

  // Exactly one row may be current. Somebody flagged as currently holding roles
  // at two employers is real, but the read path answers ONE current employer and
  // one `currentTitle`, and the top-level organization is the producer's own
  // answer to which that is — so it wins, and the rest are recorded as roles.
  const currentRoles = resolved.filter((r) => r.current);
  if (currentRoles.length > 1) {
    const winner = currentRoles.find((r) => r.organizationId === currentOrgId) ?? currentRoles[0];
    for (const role of currentRoles) if (role !== winner) role.current = false;
  }

  const consumed = new Set<string>();
  let markedCurrent = false;

  for (const role of resolved) {
    const { organizationId, startDate, endDate, title, description, current } = role;
    const candidates = existingRows.filter(
      (row) => row.organizationId === organizationId && !consumed.has(row.id),
    );
    const match =
      candidates.find((row) => row.startDate === startDate) ??
      candidates.find((row) => row.startDate === null);

    if (match) {
      consumed.add(match.id);
      await db
        .update(leadsOrganizations)
        .set({ title, startDate, endDate, current, description })
        .where(eq(leadsOrganizations.id, match.id));
    } else {
      await db
        .insert(leadsOrganizations)
        .values({ leadId, organizationId, title, startDate, endDate, current, description })
        .onConflictDoNothing();
    }

    if (current) markedCurrent = true;
  }

  // The producer flagged no current role — the top-level organization is still
  // where this person works, so exactly one row stays current.
  if (!markedCurrent && currentOrgId) {
    await markCurrentEmployment(leadId, currentOrgId, person.title ?? null);
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
