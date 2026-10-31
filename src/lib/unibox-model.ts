/**
 * The Unibox read model (UNIBOX-SIX-TAGS-1017, owner 2026-10-17: "the Unibox list is read from lead-service; crm
 * keeps the thread and the sending"): one row per RELATION of the brand (PERSON-RELATIONS-1017: a relationship
 * SUBJECT = a human at one company, from a professional relation crm-service tags professional to the brand; a
 * personal relation has no row) carrying ONLY that relation's addresses, events and thread, with the six tag dimensions (`unibox-dimensions.ts`), the
 * steps reached and the last word of each side. Built by the relationship sweep after the tags (every 5 min), read
 * by `GET /orgs/leads/unibox` (the list, filtered on the dimensions) and `GET /orgs/leads/unibox-lead` (the lead
 * card: the six tags + every campaign the person is part of, with the furthest step reached in each).
 *
 * Nothing here decides a tag: each dimension is read off its owner (relationship block, catalogue ladder, timeline,
 * crm fact copy, human facts, disqualification marks). The catalogue unreadable = the refresh fails, rows unchanged.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { FEATURES_SERVICE_URL } from "../config.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { paymentStands } from "./crm-evidence.js";
import { STEP_REACHED_EVIDENCE } from "./step-reached.js";
import { loadRelationshipsAt } from "./relationship-read.js";
import { loadLeadAndCompanyMarks, effectiveLeadOrCompanyMark } from "./lead-disqualification.js";
import { NON_EVENT_FACT_TYPES, subjectKey, type Scope } from "./relationship-subjects.js";
import { loadCampaignDisplays, type CampaignDisplay } from "./campaign-names-client.js";
import { getCompanies, MAX_COMPANIES_PER_REQUEST } from "./company-client.js";
import { anyMemberAddress, loadOrgMemberKeys } from "./org-members.js";
import {
  fetchLatestMessages,
  lastMessageOfRow,
  needsAsking,
  type UniboxLastMessage,
  type UniboxLastMessageAnswer,
  type UniboxLastMessageReason,
} from "./unibox-last-message.js";
import {
  contactabilityOf,
  conversationOf,
  fitOf,
  interestOf,
  customerStateFrom,
  lifecycleOf,
  rolesOf,
  statusOf,
  STEP_OF_TIMELINE_LABEL,
  typesOf,
  type CustomerFact,
  type LifecycleRung,
  type StepRanks,
  type UniboxContactability,
  type UniboxConversation,
  type UniboxFit,
  type UniboxInterest,
  type UniboxRole,
  type UniboxStatus,
  type UniboxType,
  personIdentityOf,
  type UniboxLeadIdentity,
} from "./unibox-dimensions.js";

const CATALOGUE_TIMEOUT_MS = 10_000;
const CATALOGUE_TTL_MS = 5 * 60_000;
const CHUNK = 500;

export interface LifecycleCatalogue {
  ladder: LifecycleRung[];
  ranks: StepRanks;
}

let catalogueCache: { at: number; value: LifecycleCatalogue } | null = null;

/** features-service's step catalogue: the ladder and each step's rank on it (read, never hard-coded). */
export async function loadLifecycleCatalogue(): Promise<LifecycleCatalogue> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.value;
  const response = await fetchWithRetry(`${FEATURES_SERVICE_URL}/public/catalogue/steps`, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`[lead-service] features-service /public/catalogue/steps answered ${response.status}`);
  const body = (await response.json()) as {
    lifecycleLadder?: Array<{ key: string; rank: number; label: string }>;
    rows?: Array<{ key: string; lifecycleRank: number | null }>;
  };
  if (!Array.isArray(body.lifecycleLadder) || !Array.isArray(body.rows)) {
    throw new Error("[lead-service] features-service /public/catalogue/steps: no lifecycleLadder / rows");
  }
  const value: LifecycleCatalogue = {
    ladder: body.lifecycleLadder.map((r) => ({ key: r.key, rank: r.rank, label: r.label })),
    ranks: new Map(body.rows.map((r) => [r.key, typeof r.lifecycleRank === "number" ? r.lifecycleRank : null])),
  };
  catalogueCache = { at: Date.now(), value };
  return value;
}

/** Test seam: forget the cached catalogue. */
export function resetLifecycleCatalogueCache(): void {
  catalogueCache = null;
}

type Ts = Date | string;
const iso = (v: Ts | null | undefined): string | null => (v === null || v === undefined ? null : toIsoTimestamp(v));
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(b) > Date.parse(a) ? b : a);

/** The steps one person reached at the brand, each with the first time it happened (null = undated). */
type StepsReached = Map<string, string | null>;

function reach(steps: StepsReached, step: string, at: string | null): void {
  if (!steps.has(step)) {
    steps.set(step, at);
    return;
  }
  const cur = steps.get(step) ?? null;
  if (at !== null && (cur === null || Date.parse(at) < Date.parse(cur))) steps.set(step, at);
}

/** crm-service fact types that reach a catalogue step (payments only when they stand). */
const CRM_STEP_OF_TYPE = new Map<string, string>();
for (const [step, ev] of Object.entries(STEP_REACHED_EVIDENCE)) {
  if (step === "purchase") continue;
  for (const t of ev.crmFactTypes) CRM_STEP_OF_TYPE.set(t, step);
}

const SEND_LABELS = ["initial_email", "followup"];
/** crm-service facts that say whether the person is (still) a customer (CRM-FORMER-CLIENT, crm-service v0.73.0). */
const CUSTOMER_FACT_TYPES = ["client", "former_client", "subscription_changed"];
const UNSUBSCRIBED_LABELS = ["unsubscribed", "opt_out"];

export interface UniboxRow {
  humanId: string;
  companyKey: string;
  /** The company of the relation, to print "Name @ Company" (+ logo by domain); null = unknown. */
  company: { id: string; name: string | null; domain: string | null } | null;
  /** WHO it is: first + last name (the relation's lead as sourced, else crm's), never an address; null = unknown. */
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Current job title (the relation's lead); null = unknown. */
  title: string | null;
  emails: string[];
  phones: string[];
  /** crm-service's person keys of the relation. */
  personKeys: string[];
  /** The relation: open its thread with it (crm `/orgs/people/timeline?relationKey=`), only its own contact points. */
  relationKey: string | null;
  /** Every crm relation folded into this row (two crm persons of one human at one company), `relationKey` first. */
  relationKeys: string[];
  leadIds: string[];
  /** STATUS: prospect / customer / churned, one value. */
  status: UniboxStatus;
  /** ROLES: partner, investor, supplier, employee, advisor, press, other; several. */
  roles: UniboxRole[];
  /** @deprecated status + roles; kept while readers move. */
  types: UniboxType[];
  lifecycle: { key: string; rank: number; label: string } | null;
  steps: Array<{ step: string; at: string | null }>;
  interest: UniboxInterest;
  conversation: UniboxConversation;
  contactability: UniboxContactability;
  fit: UniboxFit;
  fitNote: string | null;
  lastTheirsAt: string | null;
  lastOursAt: string | null;
  lastActivityAt: string;
  connectionTags: string[];
  /** The first words of the thread's LAST message (ours or theirs), read off crm-service's thread; null = unknown, see `lastMessageReason`. */
  lastMessage: UniboxLastMessage | null;
  lastMessageReason: UniboxLastMessageReason | null;
}

interface SubjectRow {
  human: string;
  company_key: string;
  relation_keys: string[];
  contact_points: string[];
  name: string | null;
  emails: string[];
  phones: string[];
  person_keys: string[];
  last_inbound_at: Ts | null;
  updated_at: Ts;
}

/** Derive the rows of these subjects (pure orchestration of reads; nothing written). */
export async function deriveUniboxRows(scope: Scope, subjects: readonly SubjectRow[], catalogue: LifecycleCatalogue): Promise<UniboxRow[]> {
  if (subjects.length === 0) return [];
  const keyOf = (s: SubjectRow) => subjectKey(s.human, s.company_key);
  const humans = Array.from(new Set(subjects.map((s) => s.human)));
  const blocks = await loadRelationshipsAt(scope.orgId, scope.brandId, subjects.map((s) => ({ humanId: s.human, companyKey: s.company_key })));

  // The relation's leads at the brand: the leads registered on ITS addresses (our outreach wrote to that address),
  // never a lead of the human on another relation's address, and when each was first served at the brand.
  const emails = Array.from(new Set(subjects.flatMap((s) => (s.emails ?? []).map((e) => e.toLowerCase()))));
  const leadRows =
    emails.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT lower(m.value) AS email, m.lead_id::text AS lead_id, min(lc.served_at) AS served_at
          FROM lead_contact_methods m JOIN leads_campaigns lc ON lc.lead_id = m.lead_id
          WHERE m.channel = 'email' AND lower(m.value) = ANY(${sql.param(emails)}::text[])
            AND lc.org_id = ${scope.orgId} AND ${scope.brandId} = ANY(lc.brand_ids)
          GROUP BY 1, 2
        `)) as unknown as Array<{ email: string; lead_id: string; served_at: Ts | null }>);
  const leadsOfEmail = new Map<string, Array<{ lead_id: string; served_at: Ts | null }>>();
  for (const r of leadRows) leadsOfEmail.set(r.email, [...(leadsOfEmail.get(r.email) ?? []), r]);
  const leads: Array<{ subject: string; lead_id: string; served_at: Ts | null }> = [];
  for (const s of subjects) {
    const seen = new Set<string>();
    for (const e of s.emails ?? []) {
      for (const l of leadsOfEmail.get(e.toLowerCase()) ?? []) {
        if (seen.has(l.lead_id)) continue;
        seen.add(l.lead_id);
        leads.push({ subject: keyOf(s), lead_id: l.lead_id, served_at: l.served_at });
      }
    }
  }
  const leadIds = Array.from(new Set(leads.map((l) => l.lead_id)));
  const subjectsOfLead = new Map<string, string[]>();
  for (const l of leads) subjectsOfLead.set(l.lead_id, [...(subjectsOfLead.get(l.lead_id) ?? []), l.subject]);
  const subjectsOfPoint = new Map<string, string[]>();
  for (const s of subjects) for (const c of s.contact_points ?? []) subjectsOfPoint.set(c, [...(subjectsOfPoint.get(c) ?? []), keyOf(s)]);
  const points = [...subjectsOfPoint.keys()];

  const [timeline, crm, humanFacts, marks, identities] = await Promise.all([
    leadIds.length === 0
      ? Promise.resolve([] as Array<{ lead_id: string; label: string; first_at: Ts | null; last_at: Ts | null }>)
      : (db.execute(sql`
          SELECT lead_id::text AS lead_id, label, min(occurred_at) AS first_at, max(occurred_at) AS last_at
          FROM lead_timeline_facts
          WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND withdrawn_at IS NULL AND lead_id = ANY(${sql.param(leadIds)}::uuid[])
          GROUP BY 1, 2
        `) as unknown as Promise<Array<{ lead_id: string; label: string; first_at: Ts | null; last_at: Ts | null }>>),
    points.length === 0
      ? Promise.resolve([] as Array<{ contact_point: string; type: string; payload: Record<string, unknown>; occurred_at: Ts | null; source_ref: string }>)
      : (db.execute(sql`
          SELECT f.contact_point, f.type, f.payload, f.occurred_at, f.source_ref
          FROM crm_facts f
          WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId} AND f.contact_point = ANY(${sql.param(points)}::text[])
            AND f.type <> ALL(${sql.param(NON_EVENT_FACT_TYPES)}::text[])
            AND (f.type = ANY(${sql.param([...CRM_STEP_OF_TYPE.keys(), "message_out", ...CUSTOMER_FACT_TYPES])}::text[]))
            AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
        `) as unknown as Promise<Array<{ contact_point: string; type: string; payload: Record<string, unknown>; occurred_at: Ts | null; source_ref: string }>>),
    db.execute(sql`
      SELECT COALESCE(o.human_id, a.human_id, f.human_id)::text AS human,
        bool_or(f.kind = 'opt_out') AS opted_out, bool_or(f.kind = 'do_not_contact') AS do_not_contact
      FROM human_fact_copies f
      LEFT JOIN human_aliases a ON a.atomic_human_id = f.human_id
      LEFT JOIN org_human_aliases o ON o.org_id = ${scope.orgId} AND o.atomic_human_id = COALESCE(a.human_id, f.human_id)
      WHERE f.withdrawn_at IS NULL AND f.kind IN ('opt_out', 'do_not_contact')
        AND COALESCE(o.human_id, a.human_id, f.human_id) = ANY(${sql.param(humans)}::uuid[])
      GROUP BY 1
    `) as unknown as Promise<Array<{ human: string; opted_out: boolean; do_not_contact: boolean }>>,
    loadLeadAndCompanyMarks({ orgId: scope.orgId, brandIds: [scope.brandId], leadIds }),
    leadIds.length === 0
      ? Promise.resolve([] as Array<{ lead_id: string; first_name: string | null; last_name: string | null; name: string | null; titles: Array<{ org: string; title: string }> | null }>)
      : (db.execute(sql`
          SELECT l.id::text AS lead_id, l.first_name, l.last_name, l.name,
            (SELECT json_agg(json_build_object('org', lo.organization_id::text, 'title', lo.title) ORDER BY lo.created_at DESC, lo.id)
             FROM leads_organizations lo WHERE lo.lead_id = l.id AND lo.current AND coalesce(lo.title, '') <> '') AS titles
          FROM leads l WHERE l.id = ANY(${sql.param(leadIds)}::uuid[])
        `) as unknown as Promise<Array<{ lead_id: string; first_name: string | null; last_name: string | null; name: string | null; titles: Array<{ org: string; title: string }> | null }>>),
  ]);
  const identityOfLead = new Map(identities.map((r) => [r.lead_id, r]));

  // Everything below is keyed on the SUBJECT (the relation), never the human.
  const steps = new Map<string, StepsReached>();
  const oursAt = new Map<string, string | null>();
  const activity = new Map<string, string | null>();
  const unsubscribed = new Set<string>();
  const bounced = new Set<string>();
  const stepsOf = (k: string) => {
    let st = steps.get(k);
    if (!st) steps.set(k, (st = new Map()));
    return st;
  };
  const touch = (k: string, at: string | null) => activity.set(k, later(activity.get(k) ?? null, at));

  for (const l of leads) {
    reach(stepsOf(l.subject), "lead_found", iso(l.served_at));
    touch(l.subject, iso(l.served_at));
  }
  for (const t of timeline) {
    for (const k of subjectsOfLead.get(t.lead_id) ?? []) {
      const step = STEP_OF_TIMELINE_LABEL[t.label];
      if (step) reach(stepsOf(k), step, iso(t.first_at));
      if (SEND_LABELS.includes(t.label)) oursAt.set(k, later(oursAt.get(k) ?? null, iso(t.last_at)));
      if (UNSUBSCRIBED_LABELS.includes(t.label)) unsubscribed.add(k);
      if (t.label === "bounced") bounced.add(k);
      touch(k, iso(t.last_at));
    }
  }
  const customerFacts = new Map<string, CustomerFact[]>();
  const addCustomerFact = (k: string, f: CustomerFact) => customerFacts.set(k, [...(customerFacts.get(k) ?? []), f]);
  for (const f of crm) {
    for (const k of subjectsOfPoint.get(f.contact_point) ?? []) {
      const at = iso(f.occurred_at);
      if (f.type === "client" || f.type === "former_client") addCustomerFact(k, { kind: f.type, at });
      else if (f.type === "subscription_changed" && typeof f.payload?.status === "string") {
        addCustomerFact(k, { kind: "subscription", at, subscriptionId: f.source_ref, status: f.payload.status });
      } else if ((f.type === "payment" && paymentStands(f.payload)) || f.type === "sale") addCustomerFact(k, { kind: "paid", at });
      if (CUSTOMER_FACT_TYPES.includes(f.type)) continue;
      touch(k, at);
      if (f.type === "message_out") {
        oursAt.set(k, later(oursAt.get(k) ?? null, at));
        continue;
      }
      if (f.type === "payment" && !paymentStands(f.payload)) continue;
      const step = CRM_STEP_OF_TYPE.get(f.type);
      if (step) reach(stepsOf(k), step, at);
    }
  }
  const optOut = new Map(humanFacts.map((r) => [r.human, r]));

  const out: UniboxRow[] = [];
  for (const s of subjects) {
    const k = keyOf(s);
    const block = blocks.get(k);
    const reached = stepsOf(k);
    const lastIn = iso(s.last_inbound_at);
    touch(k, lastIn);
    const myLeads = Array.from(new Set(leads.filter((l) => l.subject === k).map((l) => l.lead_id)));
    let fit: UniboxFit = "fit";
    let fitNote: string | null = null;
    for (const leadId of myLeads) {
      const mark = effectiveLeadOrCompanyMark(marks, leadId, scope.brandId, null);
      if (!mark) continue;
      const f = fitOf({ lead: mark.level !== "company", company: mark.level === "company" });
      // A wrong-person mark on any of the relation's leads answers before a company one.
      if (fit === "fit" || f === "wrong_person") {
        fit = f;
        fitNote = mark.note;
      }
    }
    // Opt-out / do-not-contact is the HUMAN's word: it holds on every relation.
    const hf = optOut.get(s.human);
    const contactability = contactabilityOf({
      doNotContact: hf?.do_not_contact === true,
      optedOut: hf?.opted_out === true,
      unsubscribed: unsubscribed.has(k),
      bounced: bounced.has(k),
    });
    const interest = interestOf(block?.wantsBusiness.state ?? null);
    const lastOurs = oursAt.get(k) ?? null;
    const lifecycle = lifecycleOf(reached.keys(), catalogue.ranks, catalogue.ladder);
    const relationKeys = [...(s.relation_keys ?? [])].sort();
    const who = personIdentityOf(
      s.name,
      myLeads.flatMap((id): UniboxLeadIdentity[] => {
        const r = identityOfLead.get(id);
        if (!r) return [];
        const titles = [...(r.titles ?? [])].sort((a, b) => Number(b.org === s.company_key) - Number(a.org === s.company_key)).map((t) => t.title);
        return [{ leadId: id, firstName: r.first_name, lastName: r.last_name, name: r.name, titles }];
      }),
    );
    out.push({
      humanId: s.human,
      companyKey: s.company_key,
      company: null,
      ...who,
      emails: s.emails ?? [],
      phones: s.phones ?? [],
      personKeys: [...(s.person_keys ?? [])].sort(),
      relationKey: relationKeys[0] ?? null,
      relationKeys,
      leadIds: myLeads.sort(),
      status: (() => {
        const st = customerStateFrom(customerFacts.get(k) ?? []);
        return statusOf({ customer: !st.churned && ((block?.tags ?? []).includes("customer") || st.customerSign), churned: st.churned });
      })(),
      roles: rolesOf(block?.tags ?? []),
      types: typesOf(block?.tags ?? []),
      lifecycle,
      steps: [...reached.entries()]
        .map(([step, at]) => ({ step, at }))
        .sort((a, b) => (catalogue.ranks.get(a.step) ?? 0) - (catalogue.ranks.get(b.step) ?? 0) || a.step.localeCompare(b.step)),
      interest,
      conversation: conversationOf({ lastTheirsAt: lastIn, lastOursAt: lastOurs, contactability, interest }),
      contactability,
      fit,
      fitNote,
      lastTheirsAt: lastIn,
      lastOursAt: lastOurs,
      lastActivityAt: activity.get(k) ?? iso(s.updated_at)!,
      connectionTags: block?.connectionTags ?? [],
      // Filled by `attachLastMessages` (crm-service's thread); not derived here.
      lastMessage: null,
      lastMessageReason: null,
    });
  }
  return out;
}

/**
 * Rebuild the brand's Unibox rows from its subjects; rows of people no longer subjects are removed, and so are the
 * rows of the org's own TEAM (TEAM-OUT-OF-UNIBOX-1017, org-members.ts: a member, or a +tag variant of a member's
 * address, is on the brand's side and never a row). Members unreadable = thrown (the refresh fails, rows kept).
 */
export async function refreshUniboxRows(
  scope: Scope,
  opts: { humans?: readonly string[] } = {},
): Promise<{ rows: number; removed: number; teamMembers: number }> {
  const [catalogue, members] = await Promise.all([loadLifecycleCatalogue(), loadOrgMemberKeys(scope.orgId)]);
  // `humans` (UNIBOX-REPLY-LAG-1031, the fast lane): only those humans' rows, same derivation, same order.
  const onlyHumans = opts.humans === undefined ? sql`` : sql`AND human_id = ANY(${sql.param([...opts.humans])}::uuid[])`;
  const all = (await db.execute(sql`
    SELECT human_id::text AS human, company_key, relation_keys, contact_points, name, emails, phones, person_keys, last_inbound_at, updated_at
    FROM relationship_subjects WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} ${onlyHumans}
    ORDER BY human_id, company_key
  `)) as unknown as SubjectRow[];
  const team = all.filter((s) => anyMemberAddress(s.emails, members));
  const subjects = team.length === 0 ? all : all.filter((s) => !team.includes(s));
  let written = 0;
  for (let i = 0; i < subjects.length; i += CHUNK) {
    const rows = await deriveUniboxRows(scope, subjects.slice(i, i + CHUNK), catalogue);
    await nameCompanies(rows);
    const asked = await attachLastMessages(scope, rows);
    await writeRows(scope, rows, asked);
    written += rows.length;
  }
  const removed = (await db.execute(sql`
    DELETE FROM unibox_rows u
    WHERE u.org_id = ${scope.orgId} AND u.brand_id = ${scope.brandId} ${opts.humans === undefined ? sql`` : sql`AND u.human_id = ANY(${sql.param([...opts.humans])}::uuid[])`}
      AND NOT EXISTS (SELECT 1 FROM relationship_subjects s WHERE s.org_id = u.org_id AND s.brand_id = u.brand_id AND s.human_id = u.human_id
        AND s.company_key = u.company_key)
    RETURNING 1
  `)) as unknown as unknown[];
  const removedTeam =
    team.length === 0
      ? []
      : ((await db.execute(sql`
          DELETE FROM unibox_rows u
          WHERE u.org_id = ${scope.orgId} AND u.brand_id = ${scope.brandId}
            AND (u.human_id::text || '|' || u.company_key) = ANY(${sql.param(team.map((s) => `${s.human}|${s.company_key}`))}::text[])
          RETURNING 1
        `)) as unknown as unknown[]);
  return { rows: written, removed: removed.length + removedTeam.length, teamMembers: team.length };
}

/**
 * Name each row's company: a local organization row (a lead's own employer), else brand-service (the id crm-service's
 * organization_link carries). Unreadable brand-service = thrown (the refresh fails, rows kept), never a blank name.
 */
async function nameCompanies(rows: UniboxRow[]): Promise<void> {
  const keys = Array.from(new Set(rows.map((r) => r.companyKey).filter((k) => k)));
  if (keys.length === 0) return;
  const named = new Map<string, { name: string | null; domain: string | null }>();
  const uuids = keys.filter((k) => /^[0-9a-f-]{36}$/i.test(k));
  if (uuids.length > 0) {
    const local = (await db.execute(sql`
      SELECT id::text AS id, name, primary_domain AS domain FROM organizations WHERE id = ANY(${sql.param(uuids)}::uuid[])
    `)) as unknown as Array<{ id: string; name: string | null; domain: string | null }>;
    for (const r of local) named.set(r.id, { name: r.name, domain: r.domain });
  }
  const remote = keys.filter((k) => !named.has(k));
  for (let i = 0; i < remote.length; i += MAX_COMPANIES_PER_REQUEST) {
    for (const c of await getCompanies(remote.slice(i, i + MAX_COMPANIES_PER_REQUEST))) named.set(c.brandId, { name: c.name, domain: c.domain });
  }
  for (const r of rows) {
    if (!r.companyKey) continue;
    const n = named.get(r.companyKey);
    r.company = { id: r.companyKey, name: n?.name ?? null, domain: n?.domain ?? null };
  }
}

/**
 * The last message of each row whose thread may have moved (`needsAsking`), from crm-service (UNIBOX-LAST-MESSAGE-PREVIEW-1021).
 * Returns the rows asked (`human|company`); every other row keeps what is stored. crm-service unreadable = logged
 * loudly, nothing asked, stored previews kept: a blip never blanks the Unibox nor fails the refresh.
 */
async function attachLastMessages(scope: Scope, rows: UniboxRow[]): Promise<Set<string>> {
  const asked = new Set<string>();
  if (rows.length === 0) return asked;
  const key = (h: string, c: string) => `${h}|${c}`;
  const stored = (await db.execute(sql`
    SELECT human_id::text AS human, company_key, last_message, last_message_reason, last_message_checked_at
    FROM unibox_rows WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}
      AND (human_id::text || '|' || company_key) = ANY(${sql.param(rows.map((r) => key(r.humanId, r.companyKey)))}::text[])
  `)) as unknown as Array<{ human: string; company_key: string; last_message: UniboxLastMessage | null; last_message_reason: string | null; last_message_checked_at: Ts | null }>;
  const before = new Map(stored.map((s) => [key(s.human, s.company_key), s]));
  const now = Date.now();
  const todo = rows.filter((r) => {
    const s = before.get(key(r.humanId, r.companyKey));
    return needsAsking(s && { checkedAt: iso(s.last_message_checked_at), reason: s.last_message_reason }, r.lastActivityAt, now);
  });
  for (const r of rows) {
    const s = before.get(key(r.humanId, r.companyKey));
    if (s) {
      r.lastMessage = s.last_message ?? null;
      r.lastMessageReason = (s.last_message_reason as UniboxLastMessageReason | null) ?? null;
    }
  }
  if (todo.length === 0) return asked;
  let answers;
  try {
    answers = await fetchLatestMessages(scope.orgId, scope.brandId, todo.flatMap((r) => r.relationKeys));
  } catch (err) {
    console.error(`[lead-service] unibox last messages unreadable for org ${scope.orgId} brand ${scope.brandId} (${todo.length} rows kept as stored):`, err);
    return asked;
  }
  for (const r of todo) {
    const a: UniboxLastMessageAnswer = lastMessageOfRow(r.relationKeys, answers);
    r.lastMessage = a.lastMessage;
    r.lastMessageReason = a.reason;
    asked.add(key(r.humanId, r.companyKey));
  }
  return asked;
}

async function writeRows(scope: Scope, rows: readonly UniboxRow[], asked: ReadonlySet<string> = new Set()): Promise<void> {
  if (rows.length === 0) return;
  const data = JSON.stringify(
    rows.map((r) => ({
      human: r.humanId,
      company: r.companyKey,
      cname: r.company?.name ?? null,
      cdomain: r.company?.domain ?? null,
      name: r.name,
      fname: r.firstName,
      lname: r.lastName,
      title: r.title,
      emails: r.emails,
      phones: r.phones,
      pkeys: r.personKeys,
      rkeys: r.relationKeys,
      leads: r.leadIds,
      status: r.status,
      roles: r.roles,
      types: r.types,
      lkey: r.lifecycle?.key ?? null,
      lrank: r.lifecycle?.rank ?? null,
      steps: r.steps,
      interest: r.interest,
      conversation: r.conversation,
      contactability: r.contactability,
      fit: r.fit,
      note: r.fitNote,
      theirs: r.lastTheirsAt,
      ours: r.lastOursAt,
      activity: r.lastActivityAt,
      conn: r.connectionTags,
      lmasked: asked.has(`${r.humanId}|${r.companyKey}`),
      lm: r.lastMessage,
      lmreason: r.lastMessageReason,
    })),
  );
  await db.execute(sql`
    INSERT INTO unibox_rows (org_id, brand_id, human_id, company_key, company_name, company_domain, name, first_name, last_name, title, emails, phones, person_keys, relation_keys, lead_ids, status, roles, types, lifecycle_key, lifecycle_rank,
      steps, interest, conversation, contactability, fit, fit_note, last_theirs_at, last_ours_at, last_activity_at, connection_tags, search_text, last_message, last_message_reason, last_message_checked_at, updated_at)
    SELECT ${scope.orgId}, ${scope.brandId}, v.human, v.company, v.cname, v.cdomain, v.name, v.fname, v.lname, v.title,
      ARRAY(SELECT jsonb_array_elements_text(v.emails)), ARRAY(SELECT jsonb_array_elements_text(v.phones)),
      ARRAY(SELECT jsonb_array_elements_text(v.pkeys)), ARRAY(SELECT jsonb_array_elements_text(v.rkeys)), ARRAY(SELECT jsonb_array_elements_text(v.leads))::uuid[], v.status, ARRAY(SELECT jsonb_array_elements_text(v.roles)),
      ARRAY(SELECT jsonb_array_elements_text(v.types)),
      v.lkey, v.lrank, v.steps, v.interest, v.conversation, v.contactability, v.fit, v.note,
      v.theirs::timestamptz, v.ours::timestamptz, v.activity::timestamptz, ARRAY(SELECT jsonb_array_elements_text(v.conn)),
      lower(coalesce(v.name, '') || ' ' || coalesce(v.title, '') || ' ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(v.emails)), ' ')),
      v.lm, v.lmreason, CASE WHEN v.lmasked THEN now() END, now()
    FROM jsonb_to_recordset(${data}::jsonb) AS v(human uuid, company text, cname text, cdomain text, name text, fname text, lname text, title text, emails jsonb, phones jsonb, pkeys jsonb, rkeys jsonb, leads jsonb, status text, roles jsonb, types jsonb,
      lkey text, lrank int, steps jsonb, interest text, conversation text, contactability text, fit text, note text, theirs text, ours text,
      activity text, conn jsonb, lm jsonb, lmreason text, lmasked boolean)
    ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET
      company_name = excluded.company_name, company_domain = excluded.company_domain, name = excluded.name, first_name = excluded.first_name, last_name = excluded.last_name, title = excluded.title, emails = excluded.emails, phones = excluded.phones,
      person_keys = excluded.person_keys, relation_keys = excluded.relation_keys, lead_ids = excluded.lead_ids, status = excluded.status, roles = excluded.roles,
      types = excluded.types, lifecycle_key = excluded.lifecycle_key, lifecycle_rank = excluded.lifecycle_rank, steps = excluded.steps,
      interest = excluded.interest, conversation = excluded.conversation, contactability = excluded.contactability, fit = excluded.fit,
      fit_note = excluded.fit_note, last_theirs_at = excluded.last_theirs_at, last_ours_at = excluded.last_ours_at,
      last_activity_at = excluded.last_activity_at, connection_tags = excluded.connection_tags, search_text = excluded.search_text,
      last_message = excluded.last_message, last_message_reason = excluded.last_message_reason,
      last_message_checked_at = COALESCE(excluded.last_message_checked_at, unibox_rows.last_message_checked_at), updated_at = now()
    WHERE excluded.last_message_checked_at IS NOT NULL OR (unibox_rows.last_message, unibox_rows.last_message_reason, unibox_rows.company_name, unibox_rows.company_domain, unibox_rows.name, unibox_rows.first_name, unibox_rows.last_name, unibox_rows.title, unibox_rows.emails, unibox_rows.phones, unibox_rows.person_keys, unibox_rows.relation_keys, unibox_rows.lead_ids, unibox_rows.status, unibox_rows.roles, unibox_rows.types,
           unibox_rows.lifecycle_key, unibox_rows.steps, unibox_rows.interest, unibox_rows.conversation, unibox_rows.contactability,
           unibox_rows.fit, unibox_rows.fit_note, unibox_rows.last_theirs_at, unibox_rows.last_ours_at, unibox_rows.last_activity_at,
           unibox_rows.connection_tags)
      IS DISTINCT FROM (excluded.last_message, excluded.last_message_reason, excluded.company_name, excluded.company_domain, excluded.name, excluded.first_name, excluded.last_name, excluded.title, excluded.emails, excluded.phones, excluded.person_keys, excluded.relation_keys, excluded.lead_ids, excluded.status, excluded.roles, excluded.types,
           excluded.lifecycle_key, excluded.steps, excluded.interest, excluded.conversation, excluded.contactability,
           excluded.fit, excluded.fit_note, excluded.last_theirs_at, excluded.last_ours_at, excluded.last_activity_at,
           excluded.connection_tags)
  `);
}

/** The filters of the list: each dimension takes a set (any of), absent = no filter. */
export interface UniboxFilters {
  status?: readonly string[];
  roles?: readonly string[];
  types?: readonly string[];
  lifecycle?: readonly string[];
  interest?: readonly string[];
  conversation?: readonly string[];
  contactability?: readonly string[];
  fit?: readonly string[];
  q?: string;
  /**
   * The offer / campaign scope, resolved to campaign ids (`unibox-scope.ts`, DEALS-LIFECYCLE-1021): only people who are
   * a lead on one of them. Absent = the brand's whole Unibox; empty = nobody (an offer no campaign sells yet).
   */
  campaignIds?: readonly string[];
}

/**
 * A campaign that reached the row's person, named as the lead card names it (DEALS-LIFECYCLE-1021: a Deals card says
 * which campaign reached that person): the customer's campaign once, its pipes folded in.
 */
export interface UniboxRowCampaign {
  campaignId: string;
  name: string;
  pipeCampaignIds: string[];
  /** First time it served them (the card's `servedAt`); null = filed, never served. */
  servedAt: string | null;
}

/** A list row: the row plus the campaigns that reached the person (read in the page's own statement, no extra trip). */
export interface UniboxListRow extends UniboxRow {
  /** Most recent first; within the read's offer/campaign scope when one is given. null = campaign-service unreadable. */
  campaigns: UniboxRowCampaign[] | null;
  campaignsReason: "source_unreadable" | null;
}

export interface UniboxPage {
  rows: UniboxListRow[];
  total: number;
  nextCursor: string | null;
  builtAt: string | null;
}

function toRow(r: Record<string, unknown>, ladder: readonly LifecycleRung[]): UniboxRow {
  const key = (r.lifecycle_key as string | null) ?? null;
  const rung = key === null ? null : (ladder.find((x) => x.key === key) ?? { key, rank: Number(r.lifecycle_rank), label: key });
  return {
    humanId: String(r.human_id),
    companyKey: String(r.company_key ?? ""),
    company: r.company_key ? { id: String(r.company_key), name: (r.company_name as string | null) ?? null, domain: (r.company_domain as string | null) ?? null } : null,
    name: (r.name as string | null) ?? null,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    emails: (r.emails as string[]) ?? [],
    phones: (r.phones as string[]) ?? [],
    personKeys: (r.person_keys as string[]) ?? [],
    relationKey: ((r.relation_keys as string[]) ?? [])[0] ?? null,
    relationKeys: (r.relation_keys as string[]) ?? [],
    leadIds: ((r.lead_ids as string[]) ?? []).map(String),
    status: (r.status as UniboxStatus) ?? "prospect",
    roles: (r.roles as UniboxRole[]) ?? [],
    types: (r.types as UniboxType[]) ?? [],
    lifecycle: rung,
    steps: (r.steps as Array<{ step: string; at: string | null }>) ?? [],
    interest: r.interest as UniboxInterest,
    conversation: r.conversation as UniboxConversation,
    contactability: r.contactability as UniboxContactability,
    fit: r.fit as UniboxFit,
    fitNote: (r.fit_note as string | null) ?? null,
    lastTheirsAt: iso(r.last_theirs_at as Ts | null),
    lastOursAt: iso(r.last_ours_at as Ts | null),
    lastActivityAt: iso(r.last_activity_at as Ts)!,
    connectionTags: (r.connection_tags as string[]) ?? [],
    lastMessage: (r.last_message as UniboxLastMessage | null) ?? null,
    lastMessageReason: (r.last_message_reason as UniboxLastMessageReason | null) ?? null,
  };
}

/**
 * Pure: the person's campaign filings at the grain the customer knows, as the lead card folds them (a pipe folds into the
 * campaign it belongs to; a filing that is no campaign, `signups:<brand>` / `unibox:<brand>`, is not listed). Most
 * recent first (undated last), then by name.
 */
export function foldRowCampaigns(
  filings: ReadonlyArray<{ campaignId: string; servedAt: string | null }>,
  displays: ReadonlyMap<string, CampaignDisplay>,
): UniboxRowCampaign[] {
  const byCampaign = new Map<string, UniboxRowCampaign & { parts: Set<string> }>();
  for (const f of filings) {
    const display = displays.get(f.campaignId);
    if (!display) continue;
    let v = byCampaign.get(display.id);
    if (!v) byCampaign.set(display.id, (v = { campaignId: display.id, name: display.name, pipeCampaignIds: [], servedAt: null, parts: new Set() }));
    v.parts.add(f.campaignId);
    if (f.servedAt !== null && (v.servedAt === null || Date.parse(f.servedAt) < Date.parse(v.servedAt))) v.servedAt = f.servedAt;
  }
  return [...byCampaign.values()]
    .map(({ parts, ...c }) => ({ ...c, pipeCampaignIds: [...parts].sort() }))
    .sort((a, b) => {
      if (a.servedAt !== b.servedAt) {
        if (a.servedAt === null) return 1;
        if (b.servedAt === null) return -1;
        return Date.parse(b.servedAt) - Date.parse(a.servedAt);
      }
      return a.name.localeCompare(b.name) || a.campaignId.localeCompare(b.campaignId);
    });
}

function encodeCursor(at: string, human: string, company: string): string {
  return Buffer.from(JSON.stringify([at, human, company])).toString("base64url");
}

export class UniboxCursorError extends Error {}

function decodeCursor(c: string): { at: string; human: string; company: string } {
  try {
    const [at, human, company] = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as [string, string, string];
    if (typeof at !== "string" || typeof human !== "string" || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(human)) throw new Error("shape");
    if (typeof company !== "string") throw new Error("shape");
    return { at, human, company };
  } catch {
    throw new UniboxCursorError("cursor is not one this endpoint issued");
  }
}

function filterSql(scope: Scope, f: UniboxFilters) {
  const parts = [sql`u.org_id = ${scope.orgId} AND u.brand_id = ${scope.brandId}`];
  if (f.status?.length) parts.push(sql`u.status = ANY(${sql.param([...f.status])}::text[])`);
  if (f.roles?.length) parts.push(sql`u.roles && ${sql.param([...f.roles])}::text[]`);
  if (f.types?.length) parts.push(sql`u.types && ${sql.param([...f.types])}::text[]`);
  if (f.lifecycle?.length) {
    // `none` = no rung reached yet.
    const keys = f.lifecycle.filter((k) => k !== "none");
    const none = f.lifecycle.includes("none");
    parts.push(sql`(u.lifecycle_key = ANY(${sql.param(keys)}::text[]) ${none ? sql`OR u.lifecycle_key IS NULL` : sql``})`);
  }
  if (f.interest?.length) parts.push(sql`u.interest = ANY(${sql.param([...f.interest])}::text[])`);
  if (f.conversation?.length) parts.push(sql`u.conversation = ANY(${sql.param([...f.conversation])}::text[])`);
  if (f.contactability?.length) parts.push(sql`u.contactability = ANY(${sql.param([...f.contactability])}::text[])`);
  if (f.fit?.length) parts.push(sql`u.fit = ANY(${sql.param([...f.fit])}::text[])`);
  if (f.campaignIds !== undefined) {
    // Membership only: the row (tags, Lifecycle) stays the brand's. Uncorrelated, so Postgres reads the scope's leads once.
    parts.push(sql`u.lead_ids && ARRAY(
      SELECT lc.lead_id FROM leads_campaigns lc
      WHERE lc.org_id = ${scope.orgId} AND ${scope.brandId} = ANY(lc.brand_ids) AND lc.campaign_id = ANY(${sql.param([...f.campaignIds])}::text[])
    )`);
  }
  if (f.q) parts.push(sql`u.search_text LIKE ${"%" + f.q.toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m) + "%"}`);
  return sql.join(parts, sql` AND `);
}

/**
 * The orders a caller may name besides the default (PEOPLE-SORT-BY-COMPANY-1023). Absent = most recent activity first,
 * served exactly as before (same cursor). Each named order is TOTAL: it ends on the row's key (human, company), so a
 * cursor walk visits every row once.
 *   company_asc / company_desc  people of one company side by side: companies by name (case-folded; domain when the
 *                               name is unknown) then by key, so two companies sharing a name never interleave; inside
 *                               a company, most recent activity first. Rows with no company come LAST in both directions.
 *   stage_desc / stage_asc      Lifecycle rung (highest first / lowest first); rows on no rung yet come LAST in both.
 *                               Inside a rung, most recent activity first.
 *   last_touch_asc              oldest activity first (the default is the newest-first twin).
 */
export const UNIBOX_SORTS = ["company_asc", "company_desc", "stage_desc", "stage_asc", "last_touch_asc"] as const;
export type UniboxSort = (typeof UNIBOX_SORTS)[number];

type SortKey = { expr: ReturnType<typeof sql>; dir: "asc" | "desc"; cast: string };

/** Every sort key is NOT NULL (coalesced), so a row comparison on them is exact. */
function sortKeys(sort: UniboxSort): SortKey[] {
  const at = { expr: sql`u.last_activity_at`, cast: "timestamptz" };
  const human = { expr: sql`u.human_id`, cast: "uuid" };
  const company = { expr: sql`u.company_key`, cast: "text" };
  const cname = sql`lower(coalesce(nullif(u.company_name, ''), nullif(u.company_domain, ''), ''))`;
  // 0 = a company we can name, 1 = a company known only by its key, 2 = no company.
  const crank = sql`(CASE WHEN u.company_key = '' THEN 2 WHEN coalesce(nullif(u.company_name, ''), nullif(u.company_domain, '')) IS NULL THEN 1 ELSE 0 END)`;
  switch (sort) {
    case "company_asc":
    case "company_desc": {
      const dir = sort === "company_asc" ? "asc" : "desc";
      return [
        { expr: crank, dir: "asc", cast: "int" },
        { expr: cname, dir, cast: "text" },
        { ...company, dir },
        { ...at, dir: "desc" },
        { ...human, dir: "desc" },
      ];
    }
    case "stage_desc":
    case "stage_asc":
      return [
        { expr: sql`(u.lifecycle_rank IS NULL)::int`, dir: "asc", cast: "int" },
        { expr: sql`coalesce(u.lifecycle_rank, 0)`, dir: sort === "stage_desc" ? "desc" : "asc", cast: "int" },
        { ...at, dir: "desc" },
        { ...human, dir: "desc" },
        { ...company, dir: "desc" },
      ];
    case "last_touch_asc":
      return [
        { ...at, dir: "asc" },
        { ...human, dir: "asc" },
        { ...company, dir: "asc" },
      ];
  }
}

/** Inside the page statement (`u`) the keys are their expressions; over the page CTE, its `sk<i>` columns. */
function sortOrderSql(keys: SortKey[], alias: string) {
  return sql.join(
    keys.map((k, i) => sql`${alias === "u" ? k.expr : sql.raw(`${alias}.sk${i}`)} ${sql.raw(k.dir === "asc" ? "ASC" : "DESC")}`),
    sql`, `,
  );
}

/** Rows strictly after `values` in the order `keys` (mixed directions: written out lexicographically). */
function sortAfterSql(keys: SortKey[], values: string[]) {
  const ors = keys.map((_, i) => {
    const eqs = keys.slice(0, i).map((k, j) => sql`${k.expr} = ${values[j]}::${sql.raw(k.cast)}`);
    const k = keys[i];
    const cmp = sql`${k.expr} ${sql.raw(k.dir === "asc" ? ">" : "<")} ${values[i]}::${sql.raw(k.cast)}`;
    return sql`(${sql.join([...eqs, cmp], sql` AND `)})`;
  });
  return sql`AND (${sql.join(ors, sql` OR `)})`;
}

function encodeSortCursor(sort: UniboxSort, values: string[]): string {
  return Buffer.from(JSON.stringify({ sort, values })).toString("base64url");
}

function decodeSortCursor(c: string, sort: UniboxSort, size: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  } catch {
    throw new UniboxCursorError("cursor is not one this endpoint issued");
  }
  const p = parsed as { sort?: unknown; values?: unknown };
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new UniboxCursorError("cursor is not one this endpoint issued");
  if (p.sort !== sort) throw new UniboxCursorError(`cursor was issued for another sort; ask again without a cursor`);
  if (!Array.isArray(p.values) || p.values.length !== size || p.values.some((v) => typeof v !== "string")) {
    throw new UniboxCursorError("cursor is not one this endpoint issued");
  }
  return p.values as string[];
}

/** One page of the brand's Unibox, most recent activity first unless `sort` names another order. */
export async function readUniboxPage(scope: Scope, f: UniboxFilters, page: { limit: number; cursor: string | null; sort?: UniboxSort }): Promise<UniboxPage> {
  if (page.sort === undefined) {
    // The default order, unchanged: (last_activity_at, human, company) newest first, the cursor it always issued.
    const after = page.cursor === null ? null : decodeCursor(page.cursor);
    const keyset =
      after === null ? sql`` : sql`AND (u.last_activity_at, u.human_id, u.company_key) < (${after.at}::timestamptz, ${after.human}::uuid, ${after.company})`;
    return readPage(scope, f, page.limit, {
      keyset,
      sortColumns: sql``,
      order: (alias) => sql.raw(`${alias}.last_activity_at DESC, ${alias}.human_id DESC, ${alias}.company_key DESC`),
      cursorOf: (last) => encodeCursor(last.item.lastActivityAt, last.item.humanId, last.item.companyKey),
    });
  }
  const sort = page.sort;
  const keys = sortKeys(sort);
  const after = page.cursor === null ? null : decodeSortCursor(page.cursor, sort, keys.length);
  return readPage(scope, f, page.limit, {
    keyset: after === null ? sql`` : sortAfterSql(keys, after),
    // Each key rides the page as text (`sk<i>`), so the next cursor holds the exact value the database compared.
    sortColumns: sql`, ${sql.join(keys.map((k, i) => sql`${k.expr} AS ${sql.raw(`sk${i}`)}, (${k.expr})::text AS ${sql.raw(`skt${i}`)}`), sql`, `)}`,
    order: (alias) => sortOrderSql(keys, alias),
    cursorOf: (last) => encodeSortCursor(sort, keys.map((_, i) => String(last.raw[`skt${i}`]))),
  });
}

async function readPage(
  scope: Scope,
  f: UniboxFilters,
  limit: number,
  o: {
    keyset: ReturnType<typeof sql>;
    sortColumns: ReturnType<typeof sql>;
    order: (alias: string) => ReturnType<typeof sql>;
    cursorOf: (last: { item: UniboxListRow; raw: Record<string, unknown> }) => string;
  },
): Promise<UniboxPage> {
  const catalogue = await loadLifecycleCatalogue();
  const where = filterSql(scope, f);
  // The campaigns that reached each row's person ride the page's own statement (one trip, only the page's rows):
  // their `leads_campaigns` filings at the brand, inside the read's scope when one is given.
  const inScope = f.campaignIds === undefined ? sql`` : sql`AND lc.campaign_id = ANY(${sql.param([...f.campaignIds])}::text[])`;
  const [rows, totals, built, displays] = await Promise.all([
    db.execute(sql`
      WITH page AS (
        SELECT u.* ${o.sortColumns} FROM unibox_rows u WHERE ${where} ${o.keyset}
        ORDER BY ${o.order("u")} LIMIT ${limit + 1}
      )
      SELECT page.*, (
        SELECT coalesce(json_agg(json_build_object('campaignId', x.campaign_id, 'servedAt', x.served_at)), '[]'::json)
        FROM (
          SELECT lc.campaign_id, min(lc.served_at) AS served_at FROM leads_campaigns lc
          WHERE lc.org_id = ${scope.orgId} AND ${scope.brandId} = ANY(lc.brand_ids) AND lc.lead_id = ANY(page.lead_ids) ${inScope}
          GROUP BY lc.campaign_id
        ) x
      ) AS row_campaigns
      FROM page
      ORDER BY ${o.order("page")}
    `) as unknown as Promise<Array<Record<string, unknown>>>,
    db.execute(sql`SELECT count(*)::int AS n FROM unibox_rows u WHERE ${where}`) as unknown as Promise<Array<{ n: number }>>,
    db.execute(sql`SELECT max(updated_at) AS at FROM unibox_rows WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}`) as unknown as Promise<Array<{ at: Ts | null }>>,
    loadCampaignDisplays(scope.orgId, scope.brandId).catch((error: unknown) => {
      // The list still answers (every other field is ours); the rows say their campaigns are unknown, never "none".
      console.error(`[lead-service] unibox list: campaign names unreadable (org ${scope.orgId} brand ${scope.brandId}), rows served with campaigns: null:`, error);
      return null;
    }),
  ]);
  const more = rows.length > limit;
  const items: UniboxListRow[] = rows.slice(0, limit).map((r) => {
    const filings = ((r.row_campaigns as Array<{ campaignId: string; servedAt: Ts | null }> | null) ?? []).map((c) => ({
      campaignId: String(c.campaignId),
      servedAt: iso(c.servedAt),
    }));
    return {
      ...toRow(r, catalogue.ladder),
      campaigns: displays === null ? null : foldRowCampaigns(filings, displays),
      campaignsReason: displays === null ? "source_unreadable" : null,
    };
  });
  const last = items[items.length - 1];
  const nextCursor = more && last ? o.cursorOf({ item: last, raw: rows[items.length - 1] }) : null;
  return { rows: items, total: totals[0]?.n ?? 0, nextCursor, builtAt: iso(built[0]?.at ?? null) };
}

export interface UniboxLifecycleCounts {
  /** Size of the filtered set; equals the sum of `byLifecycle`. */
  total: number;
  /** People per rung, keyed by the ladder's keys (every key present, 0 included) + `none` (no rung yet). */
  byLifecycle: Record<string, number>;
  builtAt: string | null;
}

/** How many people of the filtered set stand on each lifecycle rung (DEALS-LIFECYCLE-1021: the board's column headers). */
export async function readUniboxLifecycleCounts(scope: Scope, f: UniboxFilters): Promise<UniboxLifecycleCounts> {
  const catalogue = await loadLifecycleCatalogue();
  const where = filterSql(scope, f);
  const [groups, built] = await Promise.all([
    db.execute(sql`SELECT u.lifecycle_key AS key, count(*)::int AS n FROM unibox_rows u WHERE ${where} GROUP BY 1`) as unknown as Promise<
      Array<{ key: string | null; n: number }>
    >,
    db.execute(sql`SELECT max(updated_at) AS at FROM unibox_rows WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}`) as unknown as Promise<Array<{ at: Ts | null }>>,
  ]);
  const byLifecycle: Record<string, number> = {};
  for (const r of catalogue.ladder) byLifecycle[r.key] = 0;
  byLifecycle.none = 0;
  let total = 0;
  for (const g of groups) {
    const key = g.key ?? "none";
    if (!(key in byLifecycle)) {
      // A rung the ladder no longer serves (renamed before the next refresh): counted under its own key so the sum holds.
      console.error(`[lead-service] unibox counts: rung "${key}" is not on the ladder (org ${scope.orgId} brand ${scope.brandId}, ${g.n} rows)`);
    }
    byLifecycle[key] = (byLifecycle[key] ?? 0) + g.n;
    total += g.n;
  }
  return { total, byLifecycle, builtAt: iso(built[0]?.at ?? null) };
}

export interface UniboxCampaign {
  /** The campaign the customer launched (a pipe folds into it), else the campaign itself. */
  campaignId: string;
  /** What the customer calls it. */
  name: string;
  /** The pipe campaigns folded into it. */
  pipeCampaignIds: string[];
  servedAt: string | null;
  furthest: LifecycleRung | null;
  steps: Array<{ step: string; at: string | null }>;
}

/**
 * The lead card: the row's six tags plus EVERY campaign the relation is part of at the brand, with the steps reached
 * in it (facts the timeline attributes to that campaign, and being found by it) and the furthest one on the ladder.
 * `relationKey` names the row (PERSON-RELATIONS-1017); absent = the human's most recently active row.
 */
export async function readUniboxLead(
  scope: Scope,
  humanId: string | null,
  relationKey: string | null = null,
): Promise<{ lead: UniboxRow; campaigns: UniboxCampaign[] } | null> {
  const catalogue = await loadLifecycleCatalogue();
  const byHuman = humanId === null ? sql`` : sql`AND u.human_id = ${humanId}::uuid`;
  const byRelation = relationKey === null ? sql`` : sql`AND ${relationKey} = ANY(u.relation_keys)`;
  const rows = (await db.execute(sql`
    SELECT u.* FROM unibox_rows u WHERE u.org_id = ${scope.orgId} AND u.brand_id = ${scope.brandId} ${byHuman} ${byRelation}
    ORDER BY u.last_activity_at DESC, u.company_key LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const lead = toRow(rows[0], catalogue.ladder);
  if (lead.leadIds.length === 0) return { lead, campaigns: [] };
  const served = (await db.execute(sql`
    SELECT campaign_id, min(served_at) AS served_at FROM leads_campaigns
    WHERE org_id = ${scope.orgId} AND ${scope.brandId} = ANY(brand_ids) AND lead_id = ANY(${sql.param(lead.leadIds)}::uuid[])
    GROUP BY campaign_id
  `)) as unknown as Array<{ campaign_id: string; served_at: Ts | null }>;
  const facts = (await db.execute(sql`
    SELECT campaign_id, label, min(occurred_at) AS at FROM lead_timeline_facts
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND withdrawn_at IS NULL AND campaign_id IS NOT NULL
      AND lead_id = ANY(${sql.param(lead.leadIds)}::uuid[])
    GROUP BY 1, 2
  `)) as unknown as Array<{ campaign_id: string; label: string; at: Ts | null }>;
  // Shown at the grain the customer knows: a pipe folds into the campaign it belongs to. A filing that is no campaign
  // (a signup, a Unibox conversation: `signups:<brand>`, `unibox:<brand>`) is not listed; its steps still count in the
  // lead's Lifecycle.
  const displays = await loadCampaignDisplays(scope.orgId, scope.brandId);
  const byCampaign = new Map<string, { display: CampaignDisplay; parts: Set<string>; servedAt: string | null; steps: StepsReached }>();
  const of = (c: string) => {
    const display = displays.get(c);
    if (!display) return null;
    let v = byCampaign.get(display.id);
    if (!v) byCampaign.set(display.id, (v = { display, parts: new Set(), servedAt: null, steps: new Map() }));
    v.parts.add(c);
    return v;
  };
  for (const s of served) {
    const v = of(s.campaign_id);
    if (!v) continue;
    const at = iso(s.served_at);
    if (at !== null && (v.servedAt === null || Date.parse(at) < Date.parse(v.servedAt))) v.servedAt = at;
    reach(v.steps, "lead_found", at);
  }
  for (const f of facts) {
    const step = STEP_OF_TIMELINE_LABEL[f.label];
    const v = step ? of(f.campaign_id) : null;
    if (v && step) reach(v.steps, step, iso(f.at));
  }
  const campaigns: UniboxCampaign[] = [...byCampaign.values()].map((v) => ({
    campaignId: v.display.id,
    name: v.display.name,
    pipeCampaignIds: [...v.parts].sort(),
    servedAt: v.servedAt,
    furthest: lifecycleOf(v.steps.keys(), catalogue.ranks, catalogue.ladder),
    steps: [...v.steps.entries()]
      .map(([step, at]) => ({ step, at }))
      .sort((a, b) => (catalogue.ranks.get(a.step) ?? 0) - (catalogue.ranks.get(b.step) ?? 0) || a.step.localeCompare(b.step)),
  }));
  campaigns.sort((a, b) => (b.furthest?.rank ?? 0) - (a.furthest?.rank ?? 0) || String(b.servedAt).localeCompare(String(a.servedAt)));
  return { lead, campaigns };
}
