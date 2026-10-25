/**
 * The leads of a brand the relationship sweep looks at (RELATIONSHIP-TAGS-1014), and each one's thread.
 *
 * WHO (PERSON-RELATIONS-1017, owner 2026-10-17: « Chaque ligne de unibox n'est pas un Human, c'est un Human x
 * Organisation »): one subject per PROFESSIONAL relation crm-service states for the brand (fact `relation`,
 * capacity professional, its own tags holding `professional_to_brand`), keyed on the human crm states (followed
 * through this org's links and fleet merges) at the relation's company (`company_key` = crm's companyId, '' =
 * professional, company unknown). A personal relation makes NO subject; nobody crm does not tag is one. How a contact
 * point is read (capacity, company) is crm-service's. One subject = one lead of the brand = one Unibox row.
 *
 * THREAD: every live fact on the relation's OWN contact points at the brand (`crm_facts.contact_point`), plus what
 * our outreach did and heard on its addresses. Never the human's other relations (a friend's personal chat never
 * reaches their professional row).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { INBOUND_FACT_TYPES } from "./relationship-intent.js";
import { WORD_LABELS } from "./timeline-labels.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The connection tag that makes a person a subject (crm-service's registry). */
export const PROFESSIONAL_TO_BRAND = "professional_to_brand";
/** Fact types that are bookkeeping of the feed, never something that happened with the person. */
export const NON_EVENT_FACT_TYPES = ["withdrawn", "person_merged", "person_split"];
/** Facts that only say the person sits in / wrote in a group chat shared with the brand's own people. */
export const GROUP_FACT_TYPES = ["group_member", "group_message"];

export interface Scope {
  orgId: string;
  brandId: string;
}

/** Every (org, brand) crm-service states a relation for. */
export async function listScopes(): Promise<Scope[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id, brand_id FROM crm_registry_facts WHERE type = 'relation' ORDER BY org_id, brand_id
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.filter((r) => UUID_RE.test(r.org_id) && UUID_RE.test(r.brand_id)).map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}

/** A live professional relation crm-service states for the brand (PERSON-RELATIONS-1017, fact `relation`). */
export interface ProRelation {
  human: string | null;
  personKey: string;
  name: string | null;
  relationKey: string;
  companyId: string | null;
  contactPoints: string[];
  emails: string[];
  phones: string[];
  seq: string;
}

/**
 * The brand's live relations (a withdrawn one is gone): the professional ones whose own tags hold
 * `professional_to_brand` are subjects; every relation of a human (personal included) counts for `shares_human`.
 */
async function liveRelations(scope: Scope): Promise<{ pro: ProRelation[]; perHuman: Map<string, number> }> {
  const rows = (await db.execute(sql`
    SELECT CASE WHEN f.raw->>'humanId' ~* '^[0-9a-f-]{36}$' THEN f.raw->>'humanId' END AS human,
      f.person_key, f.full_name AS name, f.seq::text AS seq, f.payload
    FROM crm_registry_facts f
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId} AND f.type = 'relation'
      AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id)
  `)) as unknown as Array<{ human: string | null; person_key: string; name: string | null; seq: string; payload: Record<string, unknown> }>;
  const pro: ProRelation[] = [];
  const perHuman = new Map<string, number>();
  for (const r of rows) {
    const p = r.payload ?? {};
    if (r.human) perHuman.set(r.human, (perHuman.get(r.human) ?? 0) + 1);
    const tags = Array.isArray(p.tags) ? (p.tags as Array<{ tag?: unknown }>).map((t) => t?.tag) : [];
    if (p.capacity !== "professional" || !tags.includes(PROFESSIONAL_TO_BRAND) || typeof p.relationKey !== "string") continue;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    pro.push({
      human: r.human,
      personKey: r.person_key,
      name: r.name,
      relationKey: p.relationKey,
      companyId: typeof p.companyId === "string" && p.companyId ? p.companyId : null,
      contactPoints: Array.isArray(p.contactPoints)
        ? (p.contactPoints as Array<{ id?: unknown }>).map((c) => c?.id).filter((x): x is string => typeof x === "string")
        : [],
      emails: strings(p.emails).map((e) => e.toLowerCase()),
      phones: strings(p.phones),
      seq: r.seq,
    });
  }
  return { pro, perHuman };
}

interface PointRow {
  contact_point: string;
  name: string | null;
  sources: string[];
  max_seq: string;
  has_messages: boolean;
  has_direct: boolean;
  wrote: boolean;
  last_in: Date | string | null;
}

/** What happened on each contact point at the brand (its live facts only). */
async function pointRows(scope: Scope, points: readonly string[]): Promise<PointRow[]> {
  if (points.length === 0) return [];
  return (await db.execute(sql`
    SELECT f.contact_point,
      (array_agg(f.full_name ORDER BY (f.full_name LIKE '%(%)') , f.seq DESC) FILTER (WHERE coalesce(f.full_name, '') <> ''))[1] AS name,
      array_agg(DISTINCT f.source) AS sources,
      max(f.seq)::text AS max_seq,
      bool_or(f.type IN ('message_in', 'message_out', 'group_message', 'group_member')) AS has_messages,
      bool_or(f.type <> ALL(${sql.param(GROUP_FACT_TYPES)}::text[])) AS has_direct,
      bool_or(f.type = ANY(${sql.param([...INBOUND_FACT_TYPES])}::text[])) AS wrote,
      max(f.occurred_at) FILTER (WHERE f.type = ANY(${sql.param([...INBOUND_FACT_TYPES])}::text[])) AS last_in
    FROM crm_facts f
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId}
      AND f.type <> ALL(${sql.param(NON_EVENT_FACT_TYPES)}::text[])
      AND f.contact_point = ANY(${sql.param([...points])}::text[])
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
    GROUP BY f.contact_point
  `)) as unknown as PointRow[];
}

/** The id this org sees for each atomic human: its own judgment links, then fleet merges. */
export async function canonicalHumans(orgId: string, atomicIds: readonly string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(atomicIds));
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT a.id::text AS atomic,
      COALESCE(o.human_id, (SELECT ha.human_id FROM human_aliases ha WHERE ha.atomic_human_id = COALESCE(f.human_id, a.id)), f.human_id, a.id)::text AS human
    FROM unnest(${sql.param(ids)}::uuid[]) AS a(id)
    LEFT JOIN human_aliases f ON f.atomic_human_id = a.id
    LEFT JOIN org_human_aliases o ON o.org_id = ${orgId} AND o.atomic_human_id = COALESCE(f.human_id, a.id)
  `)) as unknown as Array<{ atomic: string; human: string }>;
  return new Map(rows.map((r) => [r.atomic, r.human]));
}

export interface SubjectRefresh {
  persons: number;
  subjects: number;
  withoutHuman: number;
}

/** The subject key of a human at a company ('' = company unknown). */
export const subjectKey = (human: string, companyKey: string) => `${human}|${companyKey}`;

/**
 * Rebuild the brand's subjects: ONE per professional relation crm-service states (the human at a company,
 * PERSON-RELATIONS-1017), with only that relation's contact points, emails, phones and what happened on them.
 * A personal relation makes no subject. Two relations of one human at one company (two crm persons) fold into one.
 */
export async function refreshSubjects(scope: Scope): Promise<SubjectRefresh> {
  const { pro, perHuman } = await liveRelations(scope);
  const canon = await canonicalHumans(scope.orgId, pro.map((p) => p.human).filter((h): h is string => h !== null));
  const relationsOfCanon = new Map<string, number>();
  for (const [atomic, n] of perHuman) {
    const h = canon.get(atomic) ?? atomic;
    relationsOfCanon.set(h, (relationsOfCanon.get(h) ?? 0) + n);
  }

  interface Acc { human: string; company: string; names: string[]; emails: Set<string>; phones: Set<string>; channels: Set<string>; keys: Set<string>; relations: Set<string>; points: Set<string>; seq: bigint; messages: boolean; direct: boolean; lastIn: number | null; wrote: boolean }
  const bySubject = new Map<string, Acc>();
  let withoutHuman = 0;
  for (const r of pro) {
    if (!r.human) {
      withoutHuman++;
      continue;
    }
    const human = canon.get(r.human) ?? r.human;
    const company = r.companyId ?? "";
    const k = subjectKey(human, company);
    const acc =
      bySubject.get(k) ??
      ({ human, company, names: [], emails: new Set(), phones: new Set(), channels: new Set(), keys: new Set(), relations: new Set(), points: new Set(), seq: 0n, messages: false, direct: false, lastIn: null, wrote: false } as Acc);
    if (r.name) acc.names.push(r.name);
    for (const e of r.emails) acc.emails.add(e);
    for (const ph of r.phones) acc.phones.add(ph);
    for (const c of r.contactPoints) acc.points.add(c);
    acc.keys.add(r.personKey);
    acc.relations.add(r.relationKey);
    bySubject.set(k, acc);
  }
  const subjectOfPoint = new Map<string, string[]>();
  for (const [k, a] of bySubject) for (const c of a.points) subjectOfPoint.set(c, [...(subjectOfPoint.get(c) ?? []), k]);
  for (const p of await pointRows(scope, [...subjectOfPoint.keys()])) {
    for (const k of subjectOfPoint.get(p.contact_point) ?? []) {
      const acc = bySubject.get(k)!;
      if (p.name) acc.names.push(p.name);
      for (const s of p.sources ?? []) acc.channels.add(s);
      const seq = BigInt(p.max_seq);
      if (seq > acc.seq) acc.seq = seq;
      acc.messages = acc.messages || p.has_messages;
      acc.direct = acc.direct || p.has_direct;
      acc.wrote = acc.wrote || p.wrote;
      acc.lastIn = laterOf(acc.lastIn, p.last_in);
    }
  }
  // A reply to our outreach is the person writing to us too (HOT-INBOUND-UNANSWERED-1016), on THIS relation's addresses.
  const replies = await outreachRepliesByEmail(scope, [...new Set([...bySubject.values()].flatMap((a) => [...a.emails]))]);
  for (const a of bySubject.values()) {
    for (const e of a.emails) {
      const at = replies.get(e);
      if (at === undefined) continue;
      a.wrote = true;
      a.lastIn = laterOf(a.lastIn, at);
    }
  }
  const rows = [...bySubject.values()].map((a) => ({
    human: a.human,
    company: a.company,
    name: bestName(a.names),
    emails: [...a.emails].sort(),
    phones: [...a.phones].sort(),
    channels: [...a.channels].sort(),
    keys: [...a.keys].sort(),
    relations: [...a.relations].sort(),
    points: [...a.points].sort(),
    shares: (relationsOfCanon.get(a.human) ?? 0) > a.relations.size,
    seq: a.seq.toString(),
    messages: a.messages,
    direct: a.direct,
    wrote: a.wrote,
    lastIn: a.lastIn === null ? null : new Date(a.lastIn).toISOString(),
  }));
  // A lead whose company became known ('' -> X) keeps its tags, only when that human has no other relation left
  // ('' is then the same relation, found its company).
  const companiesOf = new Map<string, string[]>();
  for (const r of rows) companiesOf.set(r.human, [...(companiesOf.get(r.human) ?? []), r.company]);
  const moves = rows.filter((r) => r.company !== "" && companiesOf.get(r.human)!.length === 1);
  for (let i = 0; i < moves.length; i += 500) await moveUnknownCompany(scope, moves.slice(i, i + 500));
  for (let i = 0; i < rows.length; i += 500) await writeSubjects(scope, rows.slice(i, i + 500));
  // A relation that went (withdrawn, merged into another human, no longer professional to the brand) is no row.
  const keep = JSON.stringify(rows.map((r) => ({ human: r.human, company: r.company })));
  await db.execute(sql`
    DELETE FROM relationship_subjects s
    WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId}
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${keep}::jsonb) AS v(human uuid, company text)
        WHERE v.human = s.human_id AND v.company = s.company_key)
  `);
  return { persons: pro.length, subjects: rows.length, withoutHuman };
}

function laterOf(current: number | null, v: Date | string | null): number | null {
  if (v === null || v === undefined) return current;
  const iso = toIsoTimestamp(v);
  const t = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(t)) return current;
  return current === null || t > current ? t : current;
}

/** The latest word written back to our outreach at the brand, per registered address (labelled timeline). */
async function outreachRepliesByEmail(scope: Scope, emails: readonly string[]): Promise<Map<string, Date | string | null>> {
  if (emails.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT lower(m.value) AS email, max(f.occurred_at) AS at
    FROM lead_timeline_facts f
    JOIN lead_contact_methods m ON m.lead_id = f.lead_id AND m.channel = 'email'
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId} AND f.withdrawn_at IS NULL
      AND f.label = ANY(${sql.param([...WORD_LABELS])}::text[])
      AND lower(m.value) = ANY(${sql.param([...emails])}::text[])
    GROUP BY 1
  `)) as unknown as Array<{ email: string; at: Date | string | null }>;
  return new Map(rows.map((r) => [r.email, r.at]));
}

/** A person's real name over a channel label ("Yulia (WA)", "+33... (WA)"), longest real one first. */
export function bestName(names: readonly string[]): string | null {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0);
  const real = clean.filter((n) => !/\(\w+\)\s*$/.test(n) && !/^\+?[\d\s∙().-]+$/.test(n));
  const pool = real.length > 0 ? real : clean;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

type SubjectWrite = { human: string; company: string; name: string | null; emails: string[]; phones: string[]; channels: string[]; keys: string[]; relations: string[]; points: string[]; shares: boolean; seq: string; messages: boolean; direct: boolean; wrote: boolean; lastIn: string | null };

/** A relation whose company became known ('' -> X): its tags, judgments and statements move with it. */
async function moveUnknownCompany(scope: Scope, rows: readonly SubjectWrite[]): Promise<void> {
  if (rows.length === 0) return;
  const data = JSON.stringify(rows.map((r) => ({ human: r.human, company: r.company })));
  for (const table of ["relationship_evidence", "relationship_judgments", "relationship_statements", "relationship_intent_judgments"] as const) {
    const sameRow = table === "relationship_judgments" || table === "relationship_intent_judgments" ? "" : "AND x.tag = t.tag";
    await db.execute(sql`
      UPDATE ${sql.raw(table)} t SET company_key = v.company
      FROM jsonb_to_recordset(${data}::jsonb) AS v(human uuid, company text)
      WHERE t.org_id = ${scope.orgId} AND t.brand_id = ${scope.brandId} AND t.human_id = v.human
        AND t.company_key = '' AND v.company <> ''
        AND NOT EXISTS (SELECT 1 FROM ${sql.raw(table)} x WHERE x.org_id = t.org_id AND x.brand_id = t.brand_id
          AND x.human_id = t.human_id AND x.company_key = v.company ${sql.raw(sameRow)})
    `);
  }
}

async function writeSubjects(scope: Scope, rows: readonly SubjectWrite[]): Promise<void> {
  if (rows.length === 0) return;
  const data = JSON.stringify(rows);
  await db.execute(sql`
    INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name, emails, phones, channels, person_keys, relation_keys, contact_points, shares_human,
      thread_seq, has_messages, has_direct, wrote_to_us, last_inbound_at, updated_at)
    SELECT ${scope.orgId}, ${scope.brandId}, v.human, v.company, v.name,
      ARRAY(SELECT jsonb_array_elements_text(v.emails)), ARRAY(SELECT jsonb_array_elements_text(v.phones)),
      ARRAY(SELECT jsonb_array_elements_text(v.channels)), ARRAY(SELECT jsonb_array_elements_text(v.keys)),
      ARRAY(SELECT jsonb_array_elements_text(v.relations)), ARRAY(SELECT jsonb_array_elements_text(v.points)), v.shares,
      v.seq::bigint, v.messages, v.direct, v.wrote, v."lastIn"::timestamptz, now()
    FROM jsonb_to_recordset(${data}::jsonb) AS v(human uuid, company text, name text, emails jsonb, phones jsonb, channels jsonb, keys jsonb,
      relations jsonb, points jsonb, shares boolean, seq text, messages boolean, direct boolean, wrote boolean, "lastIn" text)
    ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET
      name = excluded.name, emails = excluded.emails, phones = excluded.phones,
      channels = excluded.channels, person_keys = excluded.person_keys, relation_keys = excluded.relation_keys,
      contact_points = excluded.contact_points, shares_human = excluded.shares_human, thread_seq = excluded.thread_seq,
      has_messages = excluded.has_messages, has_direct = excluded.has_direct, wrote_to_us = excluded.wrote_to_us,
      last_inbound_at = excluded.last_inbound_at, updated_at = now()
    WHERE (relationship_subjects.name, relationship_subjects.emails, relationship_subjects.phones,
           relationship_subjects.channels, relationship_subjects.person_keys, relationship_subjects.relation_keys, relationship_subjects.contact_points,
           relationship_subjects.shares_human, relationship_subjects.thread_seq, relationship_subjects.has_messages,
           relationship_subjects.has_direct, relationship_subjects.wrote_to_us, relationship_subjects.last_inbound_at)
      IS DISTINCT FROM (excluded.name, excluded.emails, excluded.phones, excluded.channels,
           excluded.person_keys, excluded.relation_keys, excluded.contact_points, excluded.shares_human, excluded.thread_seq,
           excluded.has_messages, excluded.has_direct, excluded.wrote_to_us, excluded.last_inbound_at)
  `);
}

export interface Subject {
  orgId: string;
  brandId: string;
  humanId: string;
  companyKey: string;
  name: string | null;
  emails: string[];
  phones: string[];
  channels: string[];
  personKeys: string[];
  /** crm-service's relation keys folded into this subject (open the thread with one: crm `?relationKey=`). */
  relationKeys: string[];
  /** The relation's contact points: its thread is the facts of these only. */
  contactPoints: string[];
  /** The human holds another relation at the brand (personal, another company). */
  sharesHuman: boolean;
  threadSeq: string;
  hasMessages: boolean;
  hasDirect: boolean;
  wroteToUs: boolean;
  lastInboundAt: string | null;
}

export function toSubject(r: Record<string, unknown>): Subject {
  return {
    orgId: String(r.org_id),
    brandId: String(r.brand_id),
    humanId: String(r.human_id),
    companyKey: String(r.company_key ?? ""),
    name: (r.name as string | null) ?? null,
    emails: (r.emails as string[]) ?? [],
    phones: (r.phones as string[]) ?? [],
    channels: (r.channels as string[]) ?? [],
    personKeys: (r.person_keys as string[]) ?? [],
    relationKeys: (r.relation_keys as string[]) ?? [],
    contactPoints: (r.contact_points as string[]) ?? [],
    sharesHuman: Boolean(r.shares_human),
    threadSeq: String(r.thread_seq ?? "0"),
    hasMessages: Boolean(r.has_messages),
    hasDirect: r.has_direct === undefined ? true : Boolean(r.has_direct),
    wroteToUs: Boolean(r.wrote_to_us),
    lastInboundAt: r.last_inbound_at === null || r.last_inbound_at === undefined ? null : (toIsoTimestamp(r.last_inbound_at as Date | string) ?? null),
  };
}

export interface ThreadLine {
  at: string | null;
  source: string;
  kind: string;
  direction: "in" | "out" | null;
  text: string | null;
  detail: Record<string, unknown> | null;
}

const MESSAGE_TYPES = new Set(["message_in", "message_out"]);
const MESSAGE_HEAD_CHARS = 500;
// crm-service also states `group_member` (both are in a group chat, `groupName`) and `group_message` (a word they wrote
// in it): read as their own kinds, text and group name carried.
// JEV-WEAK-EVIDENCE-1025: what a VISIT shows (entry page, first URL with its utm source, pages, referrer) and how the
// brand's own CRM files a contact (`contactType` lead/customer, its lead source) are evidence too. Stripping them left
// Jev one undated "visited the website" line: a newsletter reader who walked our signup read as "nothing to the brand".
const DETAIL_KEYS = [
  "subject", "channel", "group", "groupName", "roomName", "amount", "amountCents", "currency", "status", "stage", "formName", "offer", "url", "title", "website", "company",
  "entryPath", "firstUrl", "paths", "pageviews", "referrer", "contactType", "leadSource", "origin", "originMedium",
];
const DETAIL_VALUE_CHARS = 300;
/** The newest visits read one by one (dated, with what they show); older ones are counted on the summary line. */
export const VISIT_LINES = 5;

export interface ThreadFact {
  type: string;
  source: string;
  occurred_at: Date | string | null;
  payload: Record<string, unknown> | null;
}

function detailOf(p: Record<string, unknown>): Record<string, unknown> | null {
  const detail: Record<string, unknown> = {};
  for (const k of DETAIL_KEYS) {
    const v = p[k];
    if (v === undefined || v === null || v === "") continue;
    detail[k] = typeof v === "string" ? v.slice(0, DETAIL_VALUE_CHARS) : v;
  }
  return Object.keys(detail).length > 0 ? detail : null;
}

/**
 * PURE: the thread lines Jev reads from the subject's live facts (oldest first) and our outreach labels (oldest first).
 * Visits: the newest VISIT_LINES each a dated line with what the visit shows, plus one summary line (count, first date).
 */
export function threadLinesOf(facts: readonly ThreadFact[], outreach: ReadonlyArray<{ label: string; occurred_at: Date | string | null; source: string }>): ThreadLine[] {
  const at = (v: Date | string | null) => (v === null ? null : toIsoTimestamp(v));
  const visits = facts.filter((f) => f.type === "website_visit");
  let seen = 0;
  const lines: ThreadLine[] = [];
  for (const f of facts) {
    const p = f.payload ?? {};
    if (f.type === "website_visit") {
      seen++;
      if (seen <= visits.length - VISIT_LINES) continue;
      lines.push({ at: at(f.occurred_at), source: f.source, kind: "visited the brand's website", direction: null, text: null, detail: detailOf(p) });
      continue;
    }
    lines.push({
      at: at(f.occurred_at),
      source: f.source,
      kind: MESSAGE_TYPES.has(f.type) ? "message" : f.type,
      direction: f.type === "message_in" ? "in" : f.type === "message_out" ? "out" : null,
      // A relationship shows in how people talk, not in a long email body: the head of each message is enough.
      text: typeof p.text === "string" ? p.text.slice(0, MESSAGE_HEAD_CHARS) : null,
      detail: detailOf(p),
    });
  }
  if (visits.length > 0) {
    const first = visits.find((v) => v.occurred_at !== null);
    const since = first ? ` since ${at(first.occurred_at)!.slice(0, 10)}` : "";
    lines.push({ at: null, source: "website", kind: `visited the brand's website ${visits.length} time(s)${since}`, direction: null, text: null, detail: null });
  }
  for (const o of outreach) {
    lines.push({ at: at(o.occurred_at), source: `our_outreach:${o.source}`, kind: o.label, direction: null, text: null, detail: null });
  }
  return lines;
}

/**
 * The leads of a relation: the leads registered on ITS addresses (our outreach wrote to that address, so that thread is
 * this relation's), never every lead of the human (a lead on a personal address is the personal relation's).
 */
export function relationLeadIdsSql(s: { emails: readonly string[] }) {
  return sql`SELECT m.lead_id FROM lead_contact_methods m WHERE m.channel = 'email' AND lower(m.value) = ANY(${sql.param([...s.emails.map((e) => e.toLowerCase()), ""])}::text[])`;
}

/** Every live fact on the subject's contact points at the brand, oldest first, plus our outreach's labels on its addresses. */
export async function readThread(s: Subject): Promise<ThreadLine[]> {
  const facts = (await db.execute(sql`
    SELECT f.type, f.source, f.occurred_at, f.payload
    FROM crm_facts f
    WHERE f.org_id = ${s.orgId} AND f.brand_id = ${s.brandId} AND f.contact_point = ANY(${sql.param(s.contactPoints)}::text[])
      AND f.type <> ALL(${sql.param(NON_EVENT_FACT_TYPES)}::text[])
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
    ORDER BY f.occurred_at NULLS FIRST, f.seq
  `)) as unknown as ThreadFact[];
  const outreach = (await db.execute(sql`
    SELECT f.label, f.occurred_at, f.source
    FROM lead_timeline_facts f
    WHERE f.lead_id IN (${relationLeadIdsSql(s)}) AND f.org_id = ${s.orgId} AND f.brand_id = ${s.brandId} AND f.withdrawn_at IS NULL
    ORDER BY f.occurred_at DESC NULLS LAST LIMIT 60
  `)) as unknown as Array<{ label: string; occurred_at: Date | string | null; source: string }>;
  return threadLinesOf(facts, outreach.reverse());
}
