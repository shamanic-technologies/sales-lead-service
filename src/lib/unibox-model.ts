/**
 * The Unibox read model (UNIBOX-SIX-TAGS-1017, owner 2026-10-17: "the Unibox list is read from lead-service; crm
 * keeps the thread and the sending"): one row per lead of the brand (a relationship SUBJECT = a person crm-service
 * tags professional to the brand, at their company) carrying the six tag dimensions (`unibox-dimensions.ts`), the
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
import { loadRelationships } from "./relationship-read.js";
import { loadLeadAndCompanyMarks, effectiveLeadOrCompanyMark } from "./lead-disqualification.js";
import { NON_EVENT_FACT_TYPES, type Scope } from "./relationship-subjects.js";
import {
  contactabilityOf,
  conversationOf,
  fitOf,
  interestOf,
  lifecycleOf,
  rolesOf,
  statusOf,
  STEP_OF_TIMELINE_LABEL,
  typesOf,
  type LifecycleRung,
  type StepRanks,
  type UniboxContactability,
  type UniboxConversation,
  type UniboxFit,
  type UniboxInterest,
  type UniboxRole,
  type UniboxStatus,
  type UniboxType,
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
const UNSUBSCRIBED_LABELS = ["unsubscribed", "opt_out"];

export interface UniboxRow {
  humanId: string;
  companyKey: string;
  name: string | null;
  emails: string[];
  phones: string[];
  /** crm-service's person keys of the human at the brand: open their thread with one (crm `/orgs/people/timeline?personKey=`). */
  personKeys: string[];
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
}

interface SubjectRow {
  human: string;
  company_key: string;
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
  const humans = subjects.map((s) => s.human);
  const blocks = await loadRelationships(scope.orgId, scope.brandId, humans);

  // The person's leads at the brand: every atomic human this org folds into theirs (its own links, fleet merges), then
  // their lead rows (index on leads.human_id), and when each was first served at the brand.
  const atoms = (await db.execute(sql`
    SELECT h.id::text AS human, h.id::text AS atomic FROM unnest(${sql.param(humans)}::uuid[]) AS h(id)
    UNION SELECT o.human_id::text, o.atomic_human_id::text FROM org_human_aliases o
      WHERE o.org_id = ${scope.orgId} AND o.human_id = ANY(${sql.param(humans)}::uuid[])
    UNION SELECT ha.human_id::text, ha.atomic_human_id::text FROM human_aliases ha WHERE ha.human_id = ANY(${sql.param(humans)}::uuid[])
  `)) as unknown as Array<{ human: string; atomic: string }>;
  const humanOfAtom = new Map(atoms.map((a) => [a.atomic, a.human]));
  const leadRows = (await db.execute(sql`
    SELECT l.human_id::text AS atomic, l.id::text AS lead_id, min(lc.served_at) AS served_at
    FROM leads l JOIN leads_campaigns lc ON lc.lead_id = l.id
    WHERE l.human_id = ANY(${sql.param([...humanOfAtom.keys()])}::uuid[]) AND lc.org_id = ${scope.orgId} AND ${scope.brandId} = ANY(lc.brand_ids)
    GROUP BY 1, 2
  `)) as unknown as Array<{ atomic: string; lead_id: string; served_at: Ts | null }>;
  const leads = leadRows.map((r) => ({ human: humanOfAtom.get(r.atomic)!, lead_id: r.lead_id, served_at: r.served_at }));
  const leadIds = leads.map((l) => l.lead_id);
  const humanOfLead = new Map(leads.map((l) => [l.lead_id, l.human]));

  const [timeline, crm, humanFacts, marks] = await Promise.all([
    leadIds.length === 0
      ? Promise.resolve([] as Array<{ lead_id: string; label: string; first_at: Ts | null; last_at: Ts | null }>)
      : (db.execute(sql`
          SELECT lead_id::text AS lead_id, label, min(occurred_at) AS first_at, max(occurred_at) AS last_at
          FROM lead_timeline_facts
          WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND withdrawn_at IS NULL AND lead_id = ANY(${sql.param(leadIds)}::uuid[])
          GROUP BY 1, 2
        `) as unknown as Promise<Array<{ lead_id: string; label: string; first_at: Ts | null; last_at: Ts | null }>>),
    db.execute(sql`
      SELECT s.human_id::text AS human, f.type, f.payload, f.occurred_at
      FROM relationship_subjects s
      JOIN crm_facts f ON f.org_id = s.org_id AND f.brand_id = s.brand_id AND f.person_key = ANY(s.person_keys)
      WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId} AND s.human_id = ANY(${sql.param(humans)}::uuid[])
        AND f.type <> ALL(${sql.param(NON_EVENT_FACT_TYPES)}::text[])
        AND (f.type = ANY(${sql.param([...CRM_STEP_OF_TYPE.keys(), "message_out"])}::text[]))
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
    `) as unknown as Promise<Array<{ human: string; type: string; payload: Record<string, unknown>; occurred_at: Ts | null }>>,
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
  ]);

  const steps = new Map<string, StepsReached>();
  const theirsAt = new Map<string, string | null>();
  const oursAt = new Map<string, string | null>();
  const activity = new Map<string, string | null>();
  const unsubscribed = new Set<string>();
  const bounced = new Set<string>();
  const stepsOf = (h: string) => {
    let s = steps.get(h);
    if (!s) steps.set(h, (s = new Map()));
    return s;
  };
  const touch = (h: string, at: string | null) => activity.set(h, later(activity.get(h) ?? null, at));

  for (const l of leads) {
    reach(stepsOf(l.human), "lead_found", iso(l.served_at));
    touch(l.human, iso(l.served_at));
  }
  for (const t of timeline) {
    const h = humanOfLead.get(t.lead_id);
    if (!h) continue;
    const step = STEP_OF_TIMELINE_LABEL[t.label];
    if (step) reach(stepsOf(h), step, iso(t.first_at));
    if (SEND_LABELS.includes(t.label)) oursAt.set(h, later(oursAt.get(h) ?? null, iso(t.last_at)));
    if (UNSUBSCRIBED_LABELS.includes(t.label)) unsubscribed.add(h);
    if (t.label === "bounced") bounced.add(h);
    touch(h, iso(t.last_at));
  }
  for (const f of crm) {
    const at = iso(f.occurred_at);
    touch(f.human, at);
    if (f.type === "message_out") {
      oursAt.set(f.human, later(oursAt.get(f.human) ?? null, at));
      continue;
    }
    if (f.type === "payment" && !paymentStands(f.payload)) continue;
    const step = CRM_STEP_OF_TYPE.get(f.type);
    if (step) reach(stepsOf(f.human), step, at);
  }
  const optOut = new Map(humanFacts.map((r) => [r.human, r]));

  const out: UniboxRow[] = [];
  for (const s of subjects) {
    const h = s.human;
    const block = blocks.get(h);
    const reached = stepsOf(h);
    const lastIn = iso(s.last_inbound_at);
    theirsAt.set(h, lastIn);
    touch(h, lastIn);
    const myLeads = leads.filter((l) => l.human === h).map((l) => l.lead_id);
    let fit: UniboxFit = "fit";
    let fitNote: string | null = null;
    for (const leadId of myLeads) {
      const mark = effectiveLeadOrCompanyMark(marks, leadId, scope.brandId, null);
      if (!mark) continue;
      const f = fitOf({ lead: mark.level !== "company", company: mark.level === "company" });
      // A wrong-person mark on any of the person's leads answers before a company one.
      if (fit === "fit" || f === "wrong_person") {
        fit = f;
        fitNote = mark.note;
      }
    }
    const hf = optOut.get(h);
    const contactability = contactabilityOf({
      doNotContact: hf?.do_not_contact === true,
      optedOut: hf?.opted_out === true,
      unsubscribed: unsubscribed.has(h),
      bounced: bounced.has(h),
    });
    const interest = interestOf(block?.wantsBusiness.state ?? null);
    const lastOurs = oursAt.get(h) ?? null;
    const lifecycle = lifecycleOf(reached.keys(), catalogue.ranks, catalogue.ladder);
    out.push({
      humanId: h,
      companyKey: s.company_key,
      name: s.name,
      emails: s.emails ?? [],
      phones: s.phones ?? [],
      personKeys: [...(s.person_keys ?? [])].sort(),
      leadIds: myLeads.sort(),
      // Churned waits on a source stating the end of the relationship (crm-service fact feed): none read yet.
      status: statusOf({ customer: (block?.tags ?? []).includes("customer"), churned: false }),
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
      lastActivityAt: activity.get(h) ?? iso(s.updated_at)!,
      connectionTags: block?.connectionTags ?? [],
    });
  }
  return out;
}

/** Rebuild the brand's Unibox rows from its subjects; rows of people no longer subjects are removed. */
export async function refreshUniboxRows(scope: Scope): Promise<{ rows: number; removed: number }> {
  const catalogue = await loadLifecycleCatalogue();
  const subjects = (await db.execute(sql`
    SELECT human_id::text AS human, company_key, name, emails, phones, person_keys, last_inbound_at, updated_at
    FROM relationship_subjects WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}
    ORDER BY human_id
  `)) as unknown as SubjectRow[];
  let written = 0;
  for (let i = 0; i < subjects.length; i += CHUNK) {
    const rows = await deriveUniboxRows(scope, subjects.slice(i, i + CHUNK), catalogue);
    await writeRows(scope, rows);
    written += rows.length;
  }
  const removed = (await db.execute(sql`
    DELETE FROM unibox_rows u
    WHERE u.org_id = ${scope.orgId} AND u.brand_id = ${scope.brandId}
      AND NOT EXISTS (SELECT 1 FROM relationship_subjects s WHERE s.org_id = u.org_id AND s.brand_id = u.brand_id AND s.human_id = u.human_id)
    RETURNING 1
  `)) as unknown as unknown[];
  return { rows: written, removed: removed.length };
}

async function writeRows(scope: Scope, rows: readonly UniboxRow[]): Promise<void> {
  if (rows.length === 0) return;
  const data = JSON.stringify(
    rows.map((r) => ({
      human: r.humanId,
      company: r.companyKey,
      name: r.name,
      emails: r.emails,
      phones: r.phones,
      pkeys: r.personKeys,
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
    })),
  );
  await db.execute(sql`
    INSERT INTO unibox_rows (org_id, brand_id, human_id, company_key, name, emails, phones, person_keys, lead_ids, status, roles, types, lifecycle_key, lifecycle_rank,
      steps, interest, conversation, contactability, fit, fit_note, last_theirs_at, last_ours_at, last_activity_at, connection_tags, search_text, updated_at)
    SELECT ${scope.orgId}, ${scope.brandId}, v.human, v.company, v.name,
      ARRAY(SELECT jsonb_array_elements_text(v.emails)), ARRAY(SELECT jsonb_array_elements_text(v.phones)),
      ARRAY(SELECT jsonb_array_elements_text(v.pkeys)), ARRAY(SELECT jsonb_array_elements_text(v.leads))::uuid[], v.status, ARRAY(SELECT jsonb_array_elements_text(v.roles)),
      ARRAY(SELECT jsonb_array_elements_text(v.types)),
      v.lkey, v.lrank, v.steps, v.interest, v.conversation, v.contactability, v.fit, v.note,
      v.theirs::timestamptz, v.ours::timestamptz, v.activity::timestamptz, ARRAY(SELECT jsonb_array_elements_text(v.conn)),
      lower(coalesce(v.name, '') || ' ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(v.emails)), ' ')), now()
    FROM jsonb_to_recordset(${data}::jsonb) AS v(human uuid, company text, name text, emails jsonb, phones jsonb, pkeys jsonb, leads jsonb, status text, roles jsonb, types jsonb,
      lkey text, lrank int, steps jsonb, interest text, conversation text, contactability text, fit text, note text, theirs text, ours text,
      activity text, conn jsonb)
    ON CONFLICT (org_id, brand_id, human_id) DO UPDATE SET
      company_key = excluded.company_key, name = excluded.name, emails = excluded.emails, phones = excluded.phones,
      person_keys = excluded.person_keys, lead_ids = excluded.lead_ids, status = excluded.status, roles = excluded.roles,
      types = excluded.types, lifecycle_key = excluded.lifecycle_key, lifecycle_rank = excluded.lifecycle_rank, steps = excluded.steps,
      interest = excluded.interest, conversation = excluded.conversation, contactability = excluded.contactability, fit = excluded.fit,
      fit_note = excluded.fit_note, last_theirs_at = excluded.last_theirs_at, last_ours_at = excluded.last_ours_at,
      last_activity_at = excluded.last_activity_at, connection_tags = excluded.connection_tags, search_text = excluded.search_text, updated_at = now()
    WHERE (unibox_rows.company_key, unibox_rows.name, unibox_rows.emails, unibox_rows.phones, unibox_rows.person_keys, unibox_rows.lead_ids, unibox_rows.status, unibox_rows.roles, unibox_rows.types,
           unibox_rows.lifecycle_key, unibox_rows.steps, unibox_rows.interest, unibox_rows.conversation, unibox_rows.contactability,
           unibox_rows.fit, unibox_rows.fit_note, unibox_rows.last_theirs_at, unibox_rows.last_ours_at, unibox_rows.last_activity_at,
           unibox_rows.connection_tags)
      IS DISTINCT FROM (excluded.company_key, excluded.name, excluded.emails, excluded.phones, excluded.person_keys, excluded.lead_ids, excluded.status, excluded.roles, excluded.types,
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
}

export interface UniboxPage {
  rows: UniboxRow[];
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
    name: (r.name as string | null) ?? null,
    emails: (r.emails as string[]) ?? [],
    phones: (r.phones as string[]) ?? [],
    personKeys: (r.person_keys as string[]) ?? [],
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
  };
}

function encodeCursor(at: string, human: string): string {
  return Buffer.from(JSON.stringify([at, human])).toString("base64url");
}

export class UniboxCursorError extends Error {}

function decodeCursor(c: string): { at: string; human: string } {
  try {
    const [at, human] = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as [string, string];
    if (typeof at !== "string" || typeof human !== "string" || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(human)) throw new Error("shape");
    return { at, human };
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
  if (f.q) parts.push(sql`u.search_text LIKE ${"%" + f.q.toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m) + "%"}`);
  return sql.join(parts, sql` AND `);
}

/** One page of the brand's Unibox, most recent activity first. */
export async function readUniboxPage(scope: Scope, f: UniboxFilters, page: { limit: number; cursor: string | null }): Promise<UniboxPage> {
  const catalogue = await loadLifecycleCatalogue();
  const where = filterSql(scope, f);
  const after = page.cursor === null ? null : decodeCursor(page.cursor);
  const keyset = after === null ? sql`` : sql`AND (u.last_activity_at, u.human_id) < (${after.at}::timestamptz, ${after.human}::uuid)`;
  const [rows, totals, built] = await Promise.all([
    db.execute(sql`
      SELECT u.* FROM unibox_rows u WHERE ${where} ${keyset}
      ORDER BY u.last_activity_at DESC, u.human_id DESC LIMIT ${page.limit + 1}
    `) as unknown as Promise<Array<Record<string, unknown>>>,
    db.execute(sql`SELECT count(*)::int AS n FROM unibox_rows u WHERE ${where}`) as unknown as Promise<Array<{ n: number }>>,
    db.execute(sql`SELECT max(updated_at) AS at FROM unibox_rows WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}`) as unknown as Promise<Array<{ at: Ts | null }>>,
  ]);
  const more = rows.length > page.limit;
  const items = rows.slice(0, page.limit).map((r) => toRow(r, catalogue.ladder));
  const last = items[items.length - 1];
  return { rows: items, total: totals[0]?.n ?? 0, nextCursor: more && last ? encodeCursor(last.lastActivityAt, last.humanId) : null, builtAt: iso(built[0]?.at ?? null) };
}

export interface UniboxCampaign {
  campaignId: string;
  servedAt: string | null;
  /** The furthest rung reached in this campaign. */
  furthest: LifecycleRung | null;
  steps: Array<{ step: string; at: string | null }>;
}

/**
 * The lead card: the row's six tags plus EVERY campaign the person is part of at the brand, with the steps reached
 * in it (facts the timeline attributes to that campaign, and being found by it) and the furthest one on the ladder.
 */
export async function readUniboxLead(scope: Scope, humanId: string): Promise<{ lead: UniboxRow; campaigns: UniboxCampaign[] } | null> {
  const catalogue = await loadLifecycleCatalogue();
  const rows = (await db.execute(sql`
    SELECT u.* FROM unibox_rows u WHERE u.org_id = ${scope.orgId} AND u.brand_id = ${scope.brandId} AND u.human_id = ${humanId}::uuid
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
  const byCampaign = new Map<string, { servedAt: string | null; steps: StepsReached }>();
  const of = (c: string) => {
    let v = byCampaign.get(c);
    if (!v) byCampaign.set(c, (v = { servedAt: null, steps: new Map() }));
    return v;
  };
  for (const s of served) {
    const v = of(s.campaign_id);
    v.servedAt = iso(s.served_at);
    reach(v.steps, "lead_found", v.servedAt);
  }
  for (const f of facts) {
    const step = STEP_OF_TIMELINE_LABEL[f.label];
    if (step) reach(of(f.campaign_id).steps, step, iso(f.at));
  }
  const campaigns: UniboxCampaign[] = [...byCampaign.entries()].map(([campaignId, v]) => ({
    campaignId,
    servedAt: v.servedAt,
    furthest: lifecycleOf(v.steps.keys(), catalogue.ranks, catalogue.ladder),
    steps: [...v.steps.entries()]
      .map(([step, at]) => ({ step, at }))
      .sort((a, b) => (catalogue.ranks.get(a.step) ?? 0) - (catalogue.ranks.get(b.step) ?? 0) || a.step.localeCompare(b.step)),
  }));
  campaigns.sort((a, b) => (b.furthest?.rank ?? 0) - (a.furthest?.rank ?? 0) || String(b.servedAt).localeCompare(String(a.servedAt)));
  return { lead, campaigns };
}
