import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { resolveBrandMembershipsByEmail, type BrandMembership } from "./audience-client.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { toLeadSources, type LeadSource } from "./lead-sources.js";
import { loadOriginNamesByList, type SourcingOriginName } from "./sourcing-origin.js";

/**
 * WHERE EACH PERSON CAME FROM, for the sending side (LEAD-SOURCE-AT-SEND-1016, 2026-10-16: 11 of 38
 * sending domains on SURBL; instantly-service must rank the lead SOURCES by the bounces, refusals and
 * blocklist hits their people produced, and it only knows the feature slug of a send).
 *
 * Provenance is MULTI (owner 2026-10-08): a person found by several sources carries EVERY tag. Two
 * inputs, nothing guessed:
 *   1. human-service's memberships of the brand (`served` / `found_taken`), named by features-service's
 *      origin catalogue (the same `sources` the Leads list serves, `lead-sources.ts`);
 *   2. the filings lead-service makes with no audience: a CRM signup filed as a lead (`crm_signup`), a
 *      social engager of our post (`social_engagement`), a person the brand's own org stated
 *      (`stated_by_org`, `brand_person_statements`).
 *
 * `tags` is the flat, groupable form: the origin slug of every named source, `list:<kind>` for a list
 * kind the catalogue does not name, `list:none` for an audience stating no list, plus the filing kinds.
 * An empty `tags` means nobody recorded where the person came from (stated as such, never a default).
 * A read only: nothing here moves who gets emailed.
 */

export const LOCAL_FILING_KINDS = ["crm_signup", "social_engagement", "stated_by_org"] as const;
export type LocalFilingKind = (typeof LOCAL_FILING_KINDS)[number];

export interface LocalFiling {
  kind: LocalFilingKind;
  /** Earliest filing of that kind, ISO-8601; null when undated. */
  firstAt: string | null;
}

export interface ProvenanceSource extends LeadSource {
  /** When that audience found the person (ISO-8601); null when human-service stated none. */
  foundAt: string | null;
}

export interface PersonProvenance {
  email: string;
  tags: string[];
  sources: ProvenanceSource[];
  filings: LocalFiling[];
}

/** Max addresses per call: keeps the body under the app's 100KB JSON cap and the SQL key set bounded. */
export const PROVENANCE_MAX_EMAILS = 1000;
const MEMBERSHIP_EMAILS_PER_CALL = 500;
const MEMBERSHIP_CALLS_IN_FLIGHT = 4;

export function normalizeProvenanceEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function sourceTag(source: Pick<LeadSource, "origin" | "list">): string {
  if (source.origin) return source.origin.slug;
  return source.list ? `list:${source.list}` : "list:none";
}

/** Pure: one person's answer from their memberships and lead-service filings. */
export function toPersonProvenance(
  email: string,
  memberships: BrandMembership[],
  filings: LocalFiling[],
  originsByList: Map<string, SourcingOriginName>,
): PersonProvenance {
  const joinedAt = new Map(memberships.map((m) => [m.audienceId, m.joinedAt ?? null]));
  const sources = toLeadSources(memberships, originsByList).map((s) => ({
    ...s,
    foundAt: joinedAt.get(s.audienceId) ?? null,
  }));
  const orderedFilings = [...filings].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const tags = new Set<string>();
  for (const s of sources) tags.add(sourceTag(s));
  for (const f of orderedFilings) tags.add(f.kind);
  return { email, tags: [...tags].sort(), sources, filings: orderedFilings };
}

interface FilingRow {
  email: string;
  kind: string;
  first_at: Date | string | null;
}

/** lead-service's own audience-less filings of (org, brand) for these (normalized) addresses. */
export async function loadLocalFilings(
  orgId: string,
  brandId: string,
  emails: string[],
): Promise<Map<string, LocalFiling[]>> {
  const out = new Map<string, LocalFiling[]>();
  if (emails.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT lower(cm.value) AS email, lc.status_reason AS kind, min(lc.served_at) AS first_at
    FROM leads_campaigns lc
    JOIN lead_contact_methods cm ON cm.lead_id = lc.lead_id AND cm.channel = 'email'
    WHERE lc.org_id = ${orgId}
      AND ${brandId} = ANY(lc.brand_ids)
      AND lc.status_reason IN ('crm_signup', 'social_engagement')
      AND lower(cm.value) = ANY(${sql.param(emails)}::text[])
    GROUP BY 1, 2
    UNION ALL
    SELECT s.email AS email, 'stated_by_org' AS kind, min(s.stated_at) AS first_at
    FROM brand_person_statements s
    WHERE s.org_id = ${orgId}
      AND s.brand_id = ${brandId}
      AND s.email = ANY(${sql.param(emails)}::text[])
    GROUP BY 1
  `)) as unknown as FilingRow[];
  for (const r of rows) {
    if (!(LOCAL_FILING_KINDS as readonly string[]).includes(r.kind)) continue;
    const list = out.get(r.email) ?? [];
    list.push({ kind: r.kind as LocalFilingKind, firstAt: toIsoTimestamp(r.first_at) });
    out.set(r.email, list);
  }
  return out;
}

async function loadMemberships(brandId: string, emails: string[], orgId: string): Promise<Map<string, BrandMembership[]>> {
  const out = new Map<string, BrandMembership[]>();
  const chunks: string[][] = [];
  for (let i = 0; i < emails.length; i += MEMBERSHIP_EMAILS_PER_CALL) chunks.push(emails.slice(i, i + MEMBERSHIP_EMAILS_PER_CALL));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const got = await resolveBrandMembershipsByEmail(brandId, chunk, { orgId });
      for (const [email, ms] of got) out.set(normalizeProvenanceEmail(email), ms);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEMBERSHIP_CALLS_IN_FLIGHT, chunks.length) }, worker));
  return out;
}

/**
 * Every source tag of each address at (org, brand). Every asked address gets an answer (empty tags
 * when nothing is recorded). Throws when human-service or the origin catalogue cannot be read: never
 * "no source".
 */
export async function readLeadProvenanceByEmail(
  orgId: string,
  brandId: string,
  rawEmails: string[],
): Promise<PersonProvenance[]> {
  const emails = [...new Set(rawEmails.map(normalizeProvenanceEmail).filter((e) => e.length > 0))];
  if (emails.length === 0) return [];
  const [originsByList, memberships, filings] = await Promise.all([
    loadOriginNamesByList(),
    loadMemberships(brandId, emails, orgId),
    loadLocalFilings(orgId, brandId, emails),
  ]);
  return emails.map((email) =>
    toPersonProvenance(email, memberships.get(email) ?? [], filings.get(email) ?? [], originsByList),
  );
}
