/**
 * The leads of a brand the relationship sweep looks at (RELATIONSHIP-TAGS-1014), and each one's WHOLE
 * merged thread.
 *
 * WHO: every person of the brand's CRM fact feed (bronze `crm_facts`: their mailbox, their WhatsApp /
 * LinkedIn bridge, signups, payments, CRM contacts), grouped by the HUMAN the org sees
 * (human-service: the fleet human, then the org's own judgment links; `org_human_aliases`). A person
 * the feed names without a human yet is resolved with the keys it carries (never created here: a person
 * with no key waits for crm-service to resolve them). One subject = one lead of the brand = one Unibox
 * row: the human at its company (`company_key`, '' while unknown).
 *
 * THREAD: every live fact of every person key of the subject at the brand (messages both ways, group
 * memberships, signups, payments, forms, meetings...), plus what our outreach did and heard (the
 * labelled timeline of the human's leads at the brand). Read whole; the judge sees the newest part when
 * it does not fit.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { HumanIdentityError, resolveHuman } from "./human-identity-client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const RESOLVE_PER_TICK = 300;
const RESOLVE_RETRY_AFTER = "1 day";
/** Fact types that are bookkeeping of the feed, never something that happened with the person. */
export const NON_EVENT_FACT_TYPES = ["withdrawn", "person_merged", "person_split"];
/** Facts that only say the person sits in / wrote in a group chat shared with the brand's own people. */
export const GROUP_FACT_TYPES = ["group_member", "group_message"];

export interface Scope {
  orgId: string;
  brandId: string;
}

/** Every (org, brand) the CRM fact feed names. */
export async function listScopes(): Promise<Scope[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id, brand_id FROM crm_facts ORDER BY org_id, brand_id
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.filter((r) => UUID_RE.test(r.org_id) && UUID_RE.test(r.brand_id)).map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}

interface PersonRow {
  person_key: string;
  fact_human: string | null;
  name: string | null;
  sources: string[];
  max_seq: string;
  has_messages: boolean;
  has_direct: boolean;
}

async function personRows(scope: Scope): Promise<PersonRow[]> {
  return (await db.execute(sql`
    SELECT f.person_key,
      (array_agg(f.raw->>'humanId' ORDER BY f.seq DESC) FILTER (WHERE f.raw->>'humanId' ~* '^[0-9a-f-]{36}$'))[1] AS fact_human,
      (array_agg(f.full_name ORDER BY (f.full_name LIKE '%(%)') , f.seq DESC) FILTER (WHERE coalesce(f.full_name, '') <> ''))[1] AS name,
      array_agg(DISTINCT f.source) AS sources,
      max(f.seq)::text AS max_seq,
      bool_or(f.type IN ('message_in', 'message_out', 'group_message', 'group_member')) AS has_messages,
      bool_or(f.type <> ALL(${sql.param(GROUP_FACT_TYPES)}::text[])) AS has_direct
    FROM crm_facts f
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId}
      AND f.type <> ALL(${sql.param(NON_EVENT_FACT_TYPES)}::text[])
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
    GROUP BY f.person_key
  `)) as unknown as PersonRow[];
}

async function personKeysOf(scope: Scope): Promise<Map<string, { emails: string[]; phones: string[] }>> {
  const emails = (await db.execute(sql`
    SELECT f.person_key, array_agg(DISTINCT lower(e)) AS v
    FROM crm_facts f, unnest(f.emails) e
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId}
    GROUP BY f.person_key
  `)) as unknown as Array<{ person_key: string; v: string[] }>;
  const phones = (await db.execute(sql`
    SELECT f.person_key, array_agg(DISTINCT p) AS v
    FROM crm_facts f, unnest(f.phones) p
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId}
    GROUP BY f.person_key
  `)) as unknown as Array<{ person_key: string; v: string[] }>;
  const out = new Map<string, { emails: string[]; phones: string[] }>();
  for (const r of emails) out.set(r.person_key, { emails: r.v ?? [], phones: [] });
  for (const r of phones) out.set(r.person_key, { emails: out.get(r.person_key)?.emails ?? [], phones: r.v ?? [] });
  return out;
}

/**
 * Person keys with no human on their facts and none recorded: resolved by their keys (read-only), at
 * most RESOLVE_PER_TICK per scope; an unknown or keyless person is asked again a day later.
 */
async function resolvePersonHumans(scope: Scope, persons: PersonRow[], keys: Map<string, { emails: string[]; phones: string[] }>): Promise<void> {
  const known = (await db.execute(sql`
    SELECT person_key, atomic_human_id::text AS human, resolved_at > now() - ${RESOLVE_RETRY_AFTER}::interval AS fresh
    FROM relationship_person_humans WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}
  `)) as unknown as Array<{ person_key: string; human: string | null; fresh: boolean }>;
  const knownOf = new Map(known.map((k) => [k.person_key, k]));
  const toWrite: Array<{ key: string; human: string | null }> = [];
  let asked = 0;
  for (const p of persons) {
    const k = knownOf.get(p.person_key);
    if (p.fact_human) {
      if (k?.human !== p.fact_human) toWrite.push({ key: p.person_key, human: p.fact_human });
      continue;
    }
    if (k && (k.human || k.fresh)) continue;
    if (asked >= RESOLVE_PER_TICK) continue;
    const kk = keys.get(p.person_key) ?? { emails: [], phones: [] };
    const emails = kk.emails.filter((e) => e.includes("@")).slice(0, 50);
    const phones = kk.phones.filter((ph) => E164_RE.test(ph)).slice(0, 50);
    if (emails.length === 0 && phones.length === 0) {
      toWrite.push({ key: p.person_key, human: null });
      continue;
    }
    asked++;
    try {
      const r = await resolveHuman({ emails, phones, create: false, orgId: scope.orgId });
      toWrite.push({ key: p.person_key, human: r.atomicHumanId ?? r.humanId });
    } catch (err) {
      if (err instanceof HumanIdentityError && err.status === 400) {
        toWrite.push({ key: p.person_key, human: null });
        continue;
      }
      throw err;
    }
  }
  if (toWrite.length === 0) return;
  await db.execute(sql`
    INSERT INTO relationship_person_humans (org_id, brand_id, person_key, atomic_human_id, resolved_at)
    SELECT ${scope.orgId}, ${scope.brandId}, k, NULLIF(h, '')::uuid, now()
    FROM unnest(${sql.param(toWrite.map((w) => w.key))}::text[], ${sql.param(toWrite.map((w) => w.human ?? ""))}::text[]) AS v(k, h)
    ON CONFLICT (org_id, brand_id, person_key) DO UPDATE
      SET atomic_human_id = excluded.atomic_human_id, resolved_at = excluded.resolved_at
  `);
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

/** The company each human is at for this brand: its lead's employer first, then what this org learned. */
async function companyKeys(scope: Scope, humans: readonly string[]): Promise<Map<string, string>> {
  if (humans.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT h.id::text AS human,
      COALESCE(
        (SELECT COALESCE(l.company_id::text, l.organization_id::text)
           FROM leads l JOIN leads_campaigns lc ON lc.lead_id = l.id
          WHERE l.human_id = h.id AND lc.org_id = ${scope.orgId} AND ${scope.brandId} = ANY(lc.brand_ids)
            AND (l.company_id IS NOT NULL OR l.organization_id IS NOT NULL)
          ORDER BY lc.created_at DESC LIMIT 1),
        (SELECT rc.company_id FROM relationship_companies rc WHERE rc.org_id = ${scope.orgId} AND rc.human_id = h.id AND rc.company_id IS NOT NULL),
        ''
      ) AS company_key
    FROM unnest(${sql.param(humans as string[])}::uuid[]) AS h(id)
  `)) as unknown as Array<{ human: string; company_key: string }>;
  return new Map(rows.map((r) => [r.human, r.company_key]));
}

export interface SubjectRefresh {
  persons: number;
  subjects: number;
  withoutHuman: number;
}

/** Rebuild the brand's subjects from its feed (one row per human; company moves carry tags). */
export async function refreshSubjects(scope: Scope): Promise<SubjectRefresh> {
  const persons = await personRows(scope);
  const keys = await personKeysOf(scope);
  await resolvePersonHumans(scope, persons, keys);
  const mapped = (await db.execute(sql`
    SELECT person_key, atomic_human_id::text AS human FROM relationship_person_humans
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND atomic_human_id IS NOT NULL
  `)) as unknown as Array<{ person_key: string; human: string }>;
  const atomicOf = new Map(mapped.map((m) => [m.person_key, m.human]));
  const canon = await canonicalHumans(scope.orgId, [...atomicOf.values()]);

  interface Acc { names: string[]; emails: Set<string>; phones: Set<string>; channels: Set<string>; keys: string[]; seq: bigint; messages: boolean; direct: boolean }
  const byHuman = new Map<string, Acc>();
  let withoutHuman = 0;
  for (const p of persons) {
    const atomic = atomicOf.get(p.person_key);
    if (!atomic) {
      withoutHuman++;
      continue;
    }
    const h = canon.get(atomic) ?? atomic;
    const acc = byHuman.get(h) ?? { names: [], emails: new Set(), phones: new Set(), channels: new Set(), keys: [], seq: 0n, messages: false, direct: false };
    if (p.name) acc.names.push(p.name);
    for (const e of keys.get(p.person_key)?.emails ?? []) acc.emails.add(e);
    for (const ph of keys.get(p.person_key)?.phones ?? []) acc.phones.add(ph);
    for (const s of p.sources ?? []) acc.channels.add(s);
    acc.keys.push(p.person_key);
    const seq = BigInt(p.max_seq);
    if (seq > acc.seq) acc.seq = seq;
    acc.messages = acc.messages || p.has_messages;
    acc.direct = acc.direct || p.has_direct;
    byHuman.set(h, acc);
  }
  const humans = [...byHuman.keys()];
  const company = await companyKeys(scope, humans);
  const rows = humans.map((h) => {
    const a = byHuman.get(h)!;
    return {
      human: h,
      company: company.get(h) ?? "",
      name: bestName(a.names),
      emails: [...a.emails].sort(),
      phones: [...a.phones].sort(),
      channels: [...a.channels].sort(),
      keys: a.keys.sort(),
      seq: a.seq.toString(),
      messages: a.messages,
      direct: a.direct,
    };
  });
  for (let i = 0; i < rows.length; i += 500) await writeSubjects(scope, rows.slice(i, i + 500));
  // A human merged into another (the org's links, fleet merges) is no row of its own any more.
  await db.execute(sql`
    DELETE FROM relationship_subjects
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND human_id <> ALL(${sql.param(humans)}::uuid[])
  `);
  return { persons: persons.length, subjects: rows.length, withoutHuman };
}

/** A person's real name over a channel label ("Yulia (WA)", "+33... (WA)"), longest real one first. */
export function bestName(names: readonly string[]): string | null {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0);
  const real = clean.filter((n) => !/\(\w+\)\s*$/.test(n) && !/^\+?[\d\s∙().-]+$/.test(n));
  const pool = real.length > 0 ? real : clean;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

async function writeSubjects(
  scope: Scope,
  rows: Array<{ human: string; company: string; name: string | null; emails: string[]; phones: string[]; channels: string[]; keys: string[]; seq: string; messages: boolean; direct: boolean }>,
): Promise<void> {
  if (rows.length === 0) return;
  const data = JSON.stringify(rows);
  // A lead whose company became known ('' -> X) keeps its tags: every row of '' moves to X first.
  for (const table of ["relationship_evidence", "relationship_judgments", "relationship_statements"] as const) {
    await db.execute(sql`
      UPDATE ${sql.raw(table)} t SET company_key = v.company
      FROM jsonb_to_recordset(${data}::jsonb) AS v(human uuid, company text)
      WHERE t.org_id = ${scope.orgId} AND t.brand_id = ${scope.brandId} AND t.human_id = v.human
        AND t.company_key = '' AND v.company <> ''
        AND NOT EXISTS (SELECT 1 FROM ${sql.raw(table)} x WHERE x.org_id = t.org_id AND x.brand_id = t.brand_id
          AND x.human_id = t.human_id AND x.company_key = v.company ${sql.raw(table === "relationship_judgments" ? "" : "AND x.tag = t.tag")})
    `);
  }
  await db.execute(sql`
    INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name, emails, phones, channels, person_keys, thread_seq, has_messages, has_direct, updated_at)
    SELECT ${scope.orgId}, ${scope.brandId}, v.human, v.company, v.name,
      ARRAY(SELECT jsonb_array_elements_text(v.emails)), ARRAY(SELECT jsonb_array_elements_text(v.phones)),
      ARRAY(SELECT jsonb_array_elements_text(v.channels)), ARRAY(SELECT jsonb_array_elements_text(v.keys)),
      v.seq::bigint, v.messages, v.direct, now()
    FROM jsonb_to_recordset(${data}::jsonb) AS v(human uuid, company text, name text, emails jsonb, phones jsonb, channels jsonb, keys jsonb, seq text, messages boolean, direct boolean)
    ON CONFLICT (org_id, brand_id, human_id) DO UPDATE SET
      company_key = excluded.company_key, name = excluded.name, emails = excluded.emails, phones = excluded.phones,
      channels = excluded.channels, person_keys = excluded.person_keys, thread_seq = excluded.thread_seq,
      has_messages = excluded.has_messages, has_direct = excluded.has_direct, updated_at = now()
    WHERE (relationship_subjects.company_key, relationship_subjects.name, relationship_subjects.emails, relationship_subjects.phones,
           relationship_subjects.channels, relationship_subjects.person_keys, relationship_subjects.thread_seq, relationship_subjects.has_messages,
           relationship_subjects.has_direct)
      IS DISTINCT FROM (excluded.company_key, excluded.name, excluded.emails, excluded.phones, excluded.channels,
           excluded.person_keys, excluded.thread_seq, excluded.has_messages, excluded.has_direct)
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
  threadSeq: string;
  hasMessages: boolean;
  hasDirect: boolean;
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
    threadSeq: String(r.thread_seq ?? "0"),
    hasMessages: Boolean(r.has_messages),
    hasDirect: r.has_direct === undefined ? true : Boolean(r.has_direct),
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
const DETAIL_KEYS = ["subject", "channel", "group", "groupName", "roomName", "amount", "amountCents", "currency", "status", "stage", "formName", "offer", "url", "title", "website", "company"];

/** Every live fact of the subject's persons at the brand, oldest first, plus our outreach's labels. */
export async function readThread(s: Subject): Promise<ThreadLine[]> {
  const facts = (await db.execute(sql`
    SELECT f.type, f.source, f.occurred_at, f.payload
    FROM crm_facts f
    WHERE f.org_id = ${s.orgId} AND f.brand_id = ${s.brandId} AND f.person_key = ANY(${sql.param(s.personKeys)}::text[])
      AND f.type <> ALL(${sql.param(NON_EVENT_FACT_TYPES)}::text[])
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
    ORDER BY f.occurred_at NULLS FIRST, f.seq
  `)) as unknown as Array<{ type: string; source: string; occurred_at: Date | string | null; payload: Record<string, unknown> }>;
  const lines: ThreadLine[] = [];
  let visits = 0;
  for (const f of facts) {
    if (f.type === "website_visit") {
      visits++;
      continue;
    }
    const p = f.payload ?? {};
    const detail: Record<string, unknown> = {};
    for (const k of DETAIL_KEYS) if (p[k] !== undefined && p[k] !== null && p[k] !== "") detail[k] = p[k];
    lines.push({
      at: f.occurred_at === null ? null : toIsoTimestamp(f.occurred_at),
      source: f.source,
      kind: MESSAGE_TYPES.has(f.type) ? "message" : f.type,
      direction: f.type === "message_in" ? "in" : f.type === "message_out" ? "out" : null,
      // A relationship shows in how people talk, not in a long email body: the head of each message is enough.
      text: typeof p.text === "string" ? p.text.slice(0, MESSAGE_HEAD_CHARS) : null,
      detail: Object.keys(detail).length > 0 ? detail : null,
    });
  }
  if (visits > 0) lines.push({ at: null, source: "website", kind: `visited the brand's website ${visits} time(s)`, direction: null, text: null, detail: null });
  const outreach = (await db.execute(sql`
    SELECT f.label, f.occurred_at, f.source
    FROM lead_timeline_facts f JOIN leads l ON l.id = f.lead_id
    WHERE l.human_id = ${s.humanId}::uuid AND f.org_id = ${s.orgId} AND f.brand_id = ${s.brandId} AND f.withdrawn_at IS NULL
    ORDER BY f.occurred_at DESC NULLS LAST LIMIT 60
  `)) as unknown as Array<{ label: string; occurred_at: Date | string | null; source: string }>;
  for (const o of outreach.reverse()) {
    lines.push({ at: o.occurred_at === null ? null : toIsoTimestamp(o.occurred_at), source: `our_outreach:${o.source}`, kind: o.label, direction: null, text: null, detail: null });
  }
  return lines;
}
