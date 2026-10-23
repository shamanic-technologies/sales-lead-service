import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { linkedinHandleOf } from "./social-identity.js";

/**
 * WHICH LEAD IS THIS PERSON, FOR THIS ORG? (`POST /internal/leads/ids/resolve`, COST-ACCOUNTING-1023-P1)
 *
 * A person's outcome occurrences name ONE subject from first step to last: their lead here. apollo-service's paid
 * steps (enrichment, verification, email-find, people search) run under our serve BEFORE the person is a lead; it
 * parks each declaration and asks here until the person resolves (we kept them: served), then declares on its own run.
 * Nothing is minted: a person nobody kept never resolves, and that spend is a normal loss riding the kept ones.
 *
 * A lead answers only when it is a lead OF the org: a `leads_campaigns` row with that `org_id` (and, when
 * `brandIds` are given, one of them in the row's `brand_ids`). Match order, first that answers wins:
 * apollo person id (`leads.apollo_person_id`, unique) > registered email (case-folded, one email one lead) >
 * LinkedIn vanity handle off `leads.linkedin_url`. Several leads on the LinkedIn handle = no answer (never a pick).
 */

export interface ResolveItem {
  orgId: string;
  brandIds?: string[];
  apolloPersonId?: string;
  email?: string;
  linkedinUrl?: string;
}

export type MatchedBy = "apollo_person_id" | "email" | "linkedin_url";

export interface ResolveAnswer {
  leadId: string | null;
  matchedBy: MatchedBy | null;
}

/** A candidate lead for one key: which orgs/brands it is a lead of. */
export interface Candidate {
  key: string;
  leadId: string;
  orgId: string;
  brandIds: string[];
}

type Row = { k: string; lead_id: string; org_id: string; brand_ids: string[] | null };

const toCandidates = (rows: Row[]): Candidate[] => rows.map((r) => ({ key: r.k, leadId: r.lead_id, orgId: r.org_id, brandIds: r.brand_ids ?? [] }));

/** Pure: the answer for one item off the candidates each key found. */
export function pickLead(
  item: ResolveItem,
  byKey: { apollo: Map<string, Candidate[]>; email: Map<string, Candidate[]>; linkedin: Map<string, Candidate[]> },
): ResolveAnswer {
  const fits = (c: Candidate) => c.orgId === item.orgId && (!item.brandIds?.length || c.brandIds.some((b) => item.brandIds!.includes(b)));
  const tries: Array<[MatchedBy, Map<string, Candidate[]>, string | null]> = [
    ["apollo_person_id", byKey.apollo, item.apolloPersonId ?? null],
    ["email", byKey.email, item.email ? item.email.trim().toLowerCase() : null],
    ["linkedin_url", byKey.linkedin, linkedinHandleOf(item.linkedinUrl)],
  ];
  for (const [matchedBy, map, key] of tries) {
    if (!key) continue;
    const leads = [...new Set((map.get(key) ?? []).filter(fits).map((c) => c.leadId))];
    if (leads.length === 1) return { leadId: leads[0], matchedBy };
    if (leads.length > 1) {
      console.warn(`[lead-service] lead id resolve: ${leads.length} leads of org ${item.orgId} hold ${matchedBy}=${key}: no answer`);
      return { leadId: null, matchedBy: null };
    }
  }
  return { leadId: null, matchedBy: null };
}

function group(cands: Candidate[]): Map<string, Candidate[]> {
  const m = new Map<string, Candidate[]>();
  for (const c of cands) (m.get(c.key) ?? m.set(c.key, []).get(c.key)!).push(c);
  return m;
}

export async function resolveLeadIds(items: ResolveItem[]): Promise<ResolveAnswer[]> {
  const orgs = [...new Set(items.map((i) => i.orgId))];
  const apolloIds = [...new Set(items.map((i) => i.apolloPersonId).filter((v): v is string => !!v))];
  const emails = [...new Set(items.map((i) => i.email?.trim().toLowerCase()).filter((v): v is string => !!v))];
  const handles = [...new Set(items.map((i) => linkedinHandleOf(i.linkedinUrl)).filter((v): v is string => !!v))];

  const [apollo, email, linkedin] = await Promise.all([
    apolloIds.length === 0
      ? []
      : (db.execute(sql`
          SELECT DISTINCT l.apollo_person_id AS k, l.id::text AS lead_id, lc.org_id, lc.brand_ids
          FROM leads l JOIN leads_campaigns lc ON lc.lead_id = l.id
          WHERE l.apollo_person_id = ANY(${sql.param(apolloIds)}::text[]) AND lc.org_id = ANY(${sql.param(orgs)}::text[])
        `) as unknown as Promise<Row[]>),
    emails.length === 0
      ? []
      : (db.execute(sql`
          SELECT DISTINCT lower(lcm.value) AS k, lcm.lead_id::text AS lead_id, lc.org_id, lc.brand_ids
          FROM lead_contact_methods lcm JOIN leads_campaigns lc ON lc.lead_id = lcm.lead_id
          WHERE lcm.channel = 'email' AND lower(lcm.value) = ANY(${sql.param(emails)}::text[]) AND lc.org_id = ANY(${sql.param(orgs)}::text[])
        `) as unknown as Promise<Row[]>),
    handles.length === 0
      ? []
      : (db.execute(sql`
          SELECT DISTINCT substring(lower(l.linkedin_url) from 'linkedin\\.com/in/([^/?#]+)') AS k, l.id::text AS lead_id, lc.org_id, lc.brand_ids
          FROM leads l JOIN leads_campaigns lc ON lc.lead_id = l.id
          WHERE substring(lower(l.linkedin_url) from 'linkedin\\.com/in/([^/?#]+)') = ANY(${sql.param(handles)}::text[])
            AND lc.org_id = ANY(${sql.param(orgs)}::text[])
        `) as unknown as Promise<Row[]>),
  ]);
  const byKey = { apollo: group(toCandidates(apollo)), email: group(toCandidates(email)), linkedin: group(toCandidates(linkedin)) };
  return items.map((item) => pickLead(item, byKey));
}
