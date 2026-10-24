import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { canonicalE164 } from "./e164-phone.js";
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
 * `brandIds` are given, one of them in the row's `brand_ids`). Match order, first key that answers wins:
 * apollo person id (`leads.apollo_person_id`, unique) > registered email (case-folded, one email one lead) >
 * human-service human (`leads.human_id`, a merged-away id followed through `human_aliases`; a recorded duplicate
 * lead of one human at one company answers by its survivor) > E.164 phone (a registered `phone` contact method,
 * compared on its digits) > LinkedIn vanity handle off `leads.linkedin_url`. Several leads on one key = no answer
 * (never a pick). A key that cannot be read (a phone that is not E.164, a human id that is not a uuid) matches
 * nothing; the other keys of the item still answer, and the batch is never refused for it (crm-service, a WhatsApp
 * writer known by human + phone only, declares `conversation` through it).
 */

export interface ResolveItem {
  orgId: string;
  brandIds?: string[];
  apolloPersonId?: string;
  email?: string;
  humanId?: string;
  phone?: string;
  linkedinUrl?: string;
}

export type MatchedBy = "apollo_person_id" | "email" | "human_id" | "phone" | "linkedin_url";

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

export interface KeyMaps {
  apollo: Map<string, Candidate[]>;
  email: Map<string, Candidate[]>;
  human: Map<string, Candidate[]>;
  phone: Map<string, Candidate[]>;
  linkedin: Map<string, Candidate[]>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A human id as asked (lowercased uuid), or null when it is not one. */
export function humanKeyOf(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase() ?? "";
  return UUID_RE.test(v) ? v : null;
}

/** A phone's comparison key: the DIGITS of its E.164 form (stored phones are compared on their digits), or null. */
export function phoneKeyOf(raw: string | null | undefined): string | null {
  const e164 = canonicalE164(raw);
  return e164 ? e164.slice(1) : null;
}

/** Pure: the answer for one item off the candidates each key found. */
export function pickLead(
  item: ResolveItem,
  byKey: KeyMaps,
): ResolveAnswer {
  const fits = (c: Candidate) => c.orgId === item.orgId && (!item.brandIds?.length || c.brandIds.some((b) => item.brandIds!.includes(b)));
  const tries: Array<[MatchedBy, Map<string, Candidate[]>, string | null]> = [
    ["apollo_person_id", byKey.apollo, item.apolloPersonId ?? null],
    ["email", byKey.email, item.email ? item.email.trim().toLowerCase() : null],
    ["human_id", byKey.human, humanKeyOf(item.humanId)],
    ["phone", byKey.phone, phoneKeyOf(item.phone)],
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
  const humans = [...new Set(items.map((i) => humanKeyOf(i.humanId)).filter((v): v is string => !!v))];
  const phones = [...new Set(items.map((i) => phoneKeyOf(i.phone)).filter((v): v is string => !!v))];

  const [apollo, email, human, phone, linkedin] = await Promise.all([
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
    humans.length === 0
      ? []
      : (db.execute(sql`
          WITH asked AS (
            SELECT a.asked, COALESCE(ha.human_id, a.asked) AS canonical
            FROM unnest(${sql.param(humans)}::uuid[]) AS a(asked)
            LEFT JOIN human_aliases ha ON ha.atomic_human_id = a.asked
          )
          SELECT DISTINCT asked.asked::text AS k, l.id::text AS lead_id, lc.org_id, lc.brand_ids
          FROM asked
          JOIN leads l ON l.human_id = asked.canonical
          JOIN leads_campaigns lc ON lc.lead_id = l.id
          WHERE lc.org_id = ANY(${sql.param(orgs)}::text[])
            AND NOT EXISTS (SELECT 1 FROM lead_identity_duplicates d WHERE d.lead_id = l.id)
        `) as unknown as Promise<Row[]>),
    phones.length === 0
      ? []
      : (db.execute(sql`
          SELECT DISTINCT regexp_replace(lcm.value, '\\D', '', 'g') AS k, lcm.lead_id::text AS lead_id, lc.org_id, lc.brand_ids
          FROM lead_contact_methods lcm JOIN leads_campaigns lc ON lc.lead_id = lcm.lead_id
          WHERE lcm.channel = 'phone' AND regexp_replace(lcm.value, '\\D', '', 'g') = ANY(${sql.param(phones)}::text[])
            AND lc.org_id = ANY(${sql.param(orgs)}::text[])
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
  const byKey: KeyMaps = {
    apollo: group(toCandidates(apollo)),
    email: group(toCandidates(email)),
    human: group(toCandidates(human)),
    phone: group(toCandidates(phone)),
    linkedin: group(toCandidates(linkedin)),
  };
  return items.map((item) => pickLead(item, byKey));
}

/**
 * WHICH LEAD IS THIS ADDRESS, WHATEVER THE ORG? (`POST /internal/leads/ids/by-email`, LEDGER-HISTORY-1024)
 *
 * A lead is a human at a company and is org-independent (a lead row is global; the org lives on its lead rows), and
 * one registered email belongs to ONE lead (`idx_lcm_channel_value`). So an address names its lead without an org:
 * apollo-service names the subject of a verification it reuses across orgs, transactional-email-service states that
 * a newsletter subscriber is the same subject as a lead. Answers only a lead someone KEPT (it holds a `leads_campaigns`
 * row, any org): an address nobody kept never resolves, nothing is minted. Case-folded; two leads holding the same
 * address in different case = `ambiguous`, never a pick. Read only.
 */
export type ByEmailReason = "not_a_lead" | "ambiguous";

export interface ByEmailAnswer {
  email: string;
  leadId: string | null;
  reason: ByEmailReason | null;
}

/** Pure: one answer per asked address (in order) off the kept leads each case-folded address names. */
export function pickLeadsByEmail(asked: readonly string[], leadsByEmail: ReadonlyMap<string, readonly string[]>): ByEmailAnswer[] {
  return asked.map((email) => {
    const leads = [...new Set(leadsByEmail.get(email.trim().toLowerCase()) ?? [])];
    if (leads.length === 1) return { email, leadId: leads[0], reason: null };
    return { email, leadId: null, reason: leads.length === 0 ? "not_a_lead" : "ambiguous" };
  });
}

export async function resolveLeadIdsByEmail(emails: readonly string[]): Promise<ByEmailAnswer[]> {
  const keys = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))];
  const rows =
    keys.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT DISTINCT lower(lcm.value) AS k, lcm.lead_id::text AS lead_id
          FROM lead_contact_methods lcm
          WHERE lcm.channel = 'email' AND lower(lcm.value) = ANY(${sql.param(keys)}::text[])
            AND EXISTS (SELECT 1 FROM leads_campaigns lc WHERE lc.lead_id = lcm.lead_id)
        `)) as unknown as Array<{ k: string; lead_id: string }>);
  const byEmail = new Map<string, string[]>();
  for (const r of rows) (byEmail.get(r.k) ?? byEmail.set(r.k, []).get(r.k)!).push(r.lead_id);
  return pickLeadsByEmail(emails, byEmail);
}
