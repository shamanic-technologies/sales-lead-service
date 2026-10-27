/**
 * Client Sentiment (CLIENT-SENTIMENT-1027, owner 2026-10-27: « On détecte le Client Sentiment de chaque message, et on
 * compte le nombre de sentiments positifs. Un peu comme les replies et les positive replies. »).
 *
 * WHAT: every message a CLIENT of a brand writes the brand, on every channel crm-service mirrors into the Unibox
 * (Gmail, WhatsApp, LinkedIn...: crm's people fact feed, `crm_facts` type `message_in`, no per-channel branch), gets ONE
 * verdict: positive / neutral / negative. features-service counts the positives as the "Client Satisfied" outcome.
 *
 * WHO is a client: a relationship SUBJECT of the brand (one human x one company, PERSON-RELATIONS-1017) whose decided
 * `customer` tag is yes (a person's word > a source's evidence such as a payment or a won sale > Jev's judgment of the
 * thread, `decideTags`), and not `team`. A subject holding a staff address or an address of a member of the brand's own
 * org is never a client (a member who paid while testing is the brand's side, org-members.ts). A lead, a personal
 * contact or anyone else is never judged here. Generic: no brand, org or address list anywhere.
 *
 * HOW: Jev (chat-service platform judgments, a `choice`) reads the message with the few messages just before it on the
 * same contact point, judged ONCE per fact and frozen in `client_sentiment_judgments` with the model release
 * (`ON CONFLICT DO NOTHING`: a judgment is never asked, nor billed, twice). Never a rule on words. The pass runs in the
 * background, newest messages first, `SENTIMENT_PER_TICK` per pass, so the history since inception fills in on its own.
 *
 * READ: a message counts for its brand only while its writer is a client NOW (a tag withdrawn takes their messages out
 * of the read; the stored verdict stays, never re-asked). Messages of a client not judged yet are counted in
 * `unjudged`, so a consumer never reads a zero it cannot trust.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { judgeChoice } from "./qualification-judge.js";
import { loadOrgMemberKeys, isMemberAddress } from "./org-members.js";
import { loadRelationshipsAt } from "./relationship-read.js";
import { subjectKey } from "./relationship-subjects.js";
import { JUDGED_YES } from "./relationship-tags.js";
import type { RunSupport } from "./run-tasks.js";
import { isStaffEmail } from "./staff-identity.js";
import { upsertTimelineFacts, type TimelineFactRow } from "./timeline-facts.js";

export const CLIENT_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type ClientSentiment = (typeof CLIENT_SENTIMENTS)[number];

/** Messages judged per pass, fleet-wide (the platform's judgment credit is shared by every Jev call of the fleet). */
export const SENTIMENT_PER_TICK = 30;
/** Background cadence: ~900 messages an hour at most, the history since inception (~1.3k on 2026-10-27) within ~2 h. */
export const CLIENT_SENTIMENT_INTERVAL_MS = 2 * 60_000;
const FIRST_DELAY_MS = 180_000;
/** What Jev reads: the message, and the messages just before it on the same contact point. */
const MESSAGE_CHARS = 2_000;
const THREAD_MESSAGES = 6;
const THREAD_MESSAGE_CHARS = 400;

/**
 * WHOSE WORK the judgment is (PLATFORM-CALLER-RUN-1024): a fleet-wide background pass no org request starts and no run
 * stands behind; it states a fact about a message (the client's sentiment) that features-service counts.
 */
export const CLIENT_SENTIMENT_SUPPORT: RunSupport = {
  kind: "platform_llm",
  reason: "Fleet-wide pass judging once per message a client writes the brand whether it reads positive, neutral or negative (Client Sentiment).",
};

export const SENTIMENT_OPTIONS: Record<ClientSentiment, string> = {
  positive:
    "The client shows they are pleased with the brand or its service: they thank us for something, praise it, share " +
    "good news about their results, sound excited, or want more of it.",
  negative:
    "The client shows they are unhappy, worried, disappointed or impatient, even politely: a complaint, results slower " +
    "or lower than they hoped, something that does not work or does not happen (nothing sent yet, a feature missing " +
    "or broken), a doubt about the value, a refund, pause or cancel request.",
  neutral:
    "No feeling about the brand shows: a plain question or request with no complaint in it, a fact, logistics, a " +
    "bare acknowledgment (ok, got it, will do, I will try), or a message no person wrote (an automatic reply).",
};

export const SENTIMENT_INSTRUCTIONS =
  "A client of the brand (someone who pays the brand for its service) wrote `message` to the brand's team on `channel`. " +
  "`thread` is what came just before on the same conversation, oldest first (`from: \"client\"` = the client, " +
  "`from: \"brand\"` = the brand's team). What does `message` say about how the client feels about the brand and its " +
  "service? Judge `message` only; the thread is its context.";

export interface Scope {
  orgId: string;
  brandId: string;
}

/** A client relation of the brand: its subject key and the contact points its messages arrive on. */
export interface ClientRelation {
  humanId: string;
  companyKey: string;
  contactPoints: string[];
  emails: string[];
  phones: string[];
}

type Ts = Date | string;

/** The (org, brand) scopes where somebody may be a client: any basis says `customer` about a subject. */
export async function clientScopes(): Promise<Scope[]> {
  const rows = (await db.execute(sql`
    SELECT org_id, brand_id FROM relationship_evidence WHERE tag = 'customer'
    UNION
    SELECT org_id, brand_id FROM relationship_statements WHERE tag = 'customer' AND state = 'yes' AND withdrawn_at IS NULL
    UNION
    SELECT org_id, brand_id FROM relationship_judgments WHERE (probabilities->>'customer')::float >= ${JUDGED_YES}
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}

/** PURE: is this relation a client of the brand, on its decided tags and its addresses? */
export function isClientRelation(
  block: { tags: readonly string[] } | undefined,
  emails: readonly string[],
  members: ReadonlySet<string>,
): boolean {
  if (!block || !block.tags.includes("customer") || block.tags.includes("team")) return false;
  return !emails.some((e) => isStaffEmail(e) || isMemberAddress(e, members));
}

/**
 * The brand's client relations now. Candidates are the subjects any basis says `customer` about; the decided tags
 * (person > evidence > Jev) then say yes or no. Throws when the org's members are unreadable (never "nobody is a member").
 */
export async function clientRelations(scope: Scope): Promise<ClientRelation[]> {
  const candidates = (await db.execute(sql`
    SELECT s.human_id::text AS human_id, s.company_key, s.emails, s.phones, s.contact_points FROM relationship_subjects s
    WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId}
      AND (
        EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.org_id = s.org_id AND e.brand_id = s.brand_id
                AND e.human_id = s.human_id AND e.company_key = s.company_key AND e.tag = 'customer')
        OR EXISTS (SELECT 1 FROM relationship_statements t WHERE t.org_id = s.org_id AND t.brand_id = s.brand_id
                AND t.human_id = s.human_id AND t.company_key = s.company_key AND t.tag = 'customer' AND t.state = 'yes' AND t.withdrawn_at IS NULL)
        OR EXISTS (SELECT 1 FROM relationship_judgments j WHERE j.org_id = s.org_id AND j.brand_id = s.brand_id
                AND j.human_id = s.human_id AND j.company_key = s.company_key AND (j.probabilities->>'customer')::float >= ${JUDGED_YES})
      )
  `)) as unknown as Array<{ human_id: string; company_key: string; emails: string[]; phones: string[]; contact_points: string[] }>;
  if (candidates.length === 0) return [];
  const [blocks, members] = await Promise.all([
    loadRelationshipsAt(scope.orgId, scope.brandId, candidates.map((c) => ({ humanId: c.human_id, companyKey: c.company_key }))),
    loadOrgMemberKeys(scope.orgId),
  ]);
  return candidates
    .filter((c) => isClientRelation(blocks.get(subjectKey(c.human_id, c.company_key)), c.emails ?? [], members))
    .map((c) => ({ humanId: c.human_id, companyKey: c.company_key, contactPoints: c.contact_points ?? [], emails: c.emails ?? [], phones: c.phones ?? [] }))
    .filter((c) => c.contactPoints.length > 0);
}

const pointsOf = (clients: readonly ClientRelation[]) => Array.from(new Set(clients.flatMap((c) => c.contactPoints)));

/** SQL: the brand's live client messages (alias `f`), on the given client points. */
function clientMessagesWhere(scope: Scope, points: readonly string[]): SQL {
  return sql`f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId} AND f.type = 'message_in'
    AND f.contact_point = ANY(${sql.param([...points])}::text[])
    AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)`;
}

interface MessageRow {
  fact_id: string;
  contact_point: string;
  source: string;
  channel: string | null;
  subject: string | null;
  text: string | null;
  at: Ts | null;
}

async function unjudgedMessages(scope: Scope, points: readonly string[], limit: number): Promise<MessageRow[]> {
  if (points.length === 0 || limit <= 0) return [];
  return (await db.execute(sql`
    SELECT f.fact_id, f.contact_point, f.source, f.payload->>'channel' AS channel, f.payload->>'subject' AS subject,
           f.payload->>'text' AS text, f.occurred_at AS at
    FROM crm_facts f
    WHERE ${clientMessagesWhere(scope, points)}
      AND NOT EXISTS (SELECT 1 FROM client_sentiment_judgments j WHERE j.fact_id = f.fact_id)
    ORDER BY f.occurred_at DESC NULLS LAST, f.seq DESC
    LIMIT ${limit}
  `)) as unknown as MessageRow[];
}

async function threadBefore(scope: Scope, m: MessageRow): Promise<Array<{ from: "client" | "brand"; at: string | null; text: string }>> {
  if (m.at === null) return [];
  const rows = (await db.execute(sql`
    SELECT f.type, f.occurred_at AS at, f.payload->>'subject' AS subject, f.payload->>'text' AS text FROM crm_facts f
    WHERE f.org_id = ${scope.orgId} AND f.brand_id = ${scope.brandId} AND f.contact_point = ${m.contact_point}
      AND f.type IN ('message_in', 'message_out') AND f.fact_id <> ${m.fact_id} AND f.occurred_at <= ${toIsoTimestamp(m.at)}
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
    ORDER BY f.occurred_at DESC, f.seq DESC
    LIMIT ${THREAD_MESSAGES}
  `)) as unknown as Array<{ type: string; at: Ts | null; subject: string | null; text: string | null }>;
  return rows.reverse().map((r) => ({
    from: r.type === "message_in" ? "client" : "brand",
    at: r.at === null ? null : toIsoTimestamp(r.at),
    text: [r.subject, r.text].filter(Boolean).join("\n").slice(0, THREAD_MESSAGE_CHARS),
  }));
}

/** PURE: the state Jev reads for one message. */
export function sentimentState(
  m: { source: string; channel: string | null; subject: string | null; text: string | null; at: string | null },
  thread: ReadonlyArray<{ from: "client" | "brand"; at: string | null; text: string }>,
) {
  return {
    channel: m.channel ?? m.source,
    thread,
    message: { at: m.at, subject: m.subject ?? null, text: (m.text ?? "").slice(0, MESSAGE_CHARS) },
  };
}

/** Judge one scope's next client messages, each frozen once. One failure stops the pass (the caller logs it). */
export async function judgeScope(scope: Scope, limit: number): Promise<{ judged: number; positive: number }> {
  const clients = await clientRelations(scope);
  const todo = await unjudgedMessages(scope, pointsOf(clients), limit);
  let judged = 0;
  let positive = 0;
  for (const m of todo) {
    const at = m.at === null ? null : toIsoTimestamp(m.at);
    const state = sentimentState({ ...m, at }, await threadBefore(scope, m));
    const { choice, confidence, model } = await judgeChoice(
      state,
      { instructions: SENTIMENT_INSTRUCTIONS, options: SENTIMENT_OPTIONS },
      { platform: { support: CLIENT_SENTIMENT_SUPPORT } },
    );
    await db.execute(sql`
      INSERT INTO client_sentiment_judgments (fact_id, sentiment, confidence, model, judged_at)
      VALUES (${m.fact_id}, ${choice}, ${confidence}, ${model}, now())
      ON CONFLICT (fact_id) DO NOTHING
    `);
    judged++;
    if (choice === "positive") positive++;
  }
  return { judged, positive };
}

/** One fleet pass: every client scope, `limit` messages at most in total. A scope that fails is logged, the next runs. */
export async function judgeClientSentimentOnce(limit = SENTIMENT_PER_TICK): Promise<{ judged: number; positive: number }> {
  let judged = 0;
  let positive = 0;
  for (const scope of await clientScopes()) {
    if (judged >= limit) break;
    try {
      const r = await judgeScope(scope, limit - judged);
      judged += r.judged;
      positive += r.positive;
    } catch (err) {
      console.error(`[lead-service] client sentiment: pass failed for org ${scope.orgId} brand ${scope.brandId}:`, err);
    }
  }
  return { judged, positive };
}

/**
 * The brand's lead rows of each client relation, keyed `subjectKey`: leads registered on the relation's OWN emails or
 * phones (never the human's other relations) that hold a follow-up date at the brand (every lead of a brand does),
 * oldest first.
 */
export async function relationLeads(scope: Scope, clients: readonly ClientRelation[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (clients.length === 0) return out;
  const rows = (await db.execute(sql`
    WITH rel AS (
      SELECT * FROM unnest(
        ${sql.param(clients.map((c) => subjectKey(c.humanId, c.companyKey)))}::text[],
        ${sql.param(clients.map((c) => JSON.stringify(c.emails.map((e) => e.toLowerCase()))))}::text[],
        ${sql.param(clients.map((c) => JSON.stringify(c.phones)))}::text[]
      ) AS r(key, emails, phones)
    )
    SELECT rel.key, array_agg(l.id::text ORDER BY l.created_at, l.id) AS lead_ids
    FROM rel
    JOIN lead_contact_methods m ON (m.channel = 'email' AND lower(m.value) IN (SELECT jsonb_array_elements_text(rel.emails::jsonb)))
                                OR (m.channel = 'phone' AND m.value IN (SELECT jsonb_array_elements_text(rel.phones::jsonb)))
    JOIN leads l ON l.id = m.lead_id
    WHERE EXISTS (SELECT 1 FROM lead_followup_dates d WHERE d.lead_id = l.id AND d.org_id = ${scope.orgId} AND d.brand_id = ${scope.brandId})
    GROUP BY rel.key
  `)) as unknown as Array<{ key: string; lead_ids: string[] }>;
  for (const r of rows) out.set(r.key, Array.from(new Set(r.lead_ids)));
  return out;
}

/** The timeline label of a positive client message: the catalogue step key features-service counts ("Client Satisfied"). */
export const CLIENT_SATISFIED_LABEL = "client_satisfied" as const;

/** PURE: one timeline row per positive verdict x lead row of its writer. */
export function clientSatisfiedRows(scope: Scope, verdicts: readonly ClientMessageVerdict[]): TimelineFactRow[] {
  const rows: TimelineFactRow[] = [];
  for (const v of verdicts) {
    if (v.sentiment !== "positive") continue;
    for (const leadId of v.leadIds) {
      rows.push({
        id: `${CLIENT_SATISFIED_LABEL}:${v.messageId}:${leadId}`,
        org_id: scope.orgId,
        brand_id: scope.brandId,
        offer_id: null,
        lead_id: leadId,
        campaign_id: null,
        occurred_at: v.occurredAt,
        label: CLIENT_SATISFIED_LABEL,
        source: "client_message",
        source_ref: v.messageId,
        attributable: null,
        attribution_basis: null,
        url: null,
        detail: { channel: v.channel, confidence: v.confidence, model: v.model },
        withdrawn_at: null,
      });
    }
  }
  return rows;
}

/**
 * Write the brand's `client_satisfied` timeline facts from the verdicts as they read NOW (idempotent), and withdraw
 * every earlier one no longer backed (the writer stopped being a client, the message was withdrawn).
 */
export async function syncClientSatisfiedFacts(scope: Scope): Promise<{ facts: number; written: number; withdrawn: number }> {
  const read = await readClientSentiment(scope, { sentiment: "positive" });
  const rows = clientSatisfiedRows(scope, read.verdicts);
  const written = await upsertTimelineFacts(rows);
  const stale = (await db.execute(sql`
    UPDATE lead_timeline_facts SET withdrawn_at = now(), updated_at = now()
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND label = ${CLIENT_SATISFIED_LABEL} AND withdrawn_at IS NULL
      AND id <> ALL(${sql.param(rows.map((r) => r.id))}::text[])
    RETURNING 1
  `)) as unknown as unknown[];
  return { facts: rows.length, written, withdrawn: stale.length };
}

/** Every scope to keep in step: the client scopes, and any scope still holding a live `client_satisfied` fact. */
async function factScopes(): Promise<Scope[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id, brand_id FROM lead_timeline_facts WHERE label = ${CLIENT_SATISFIED_LABEL} AND withdrawn_at IS NULL
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  const all = new Map<string, Scope>();
  for (const s of [...(await clientScopes()), ...rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }))]) all.set(`${s.orgId}|${s.brandId}`, s);
  return [...all.values()];
}

/** One pass over every scope's facts; a scope that fails is logged and keeps its facts as they were. */
export async function syncAllClientSatisfiedFacts(): Promise<{ written: number; withdrawn: number }> {
  let written = 0;
  let withdrawn = 0;
  for (const scope of await factScopes()) {
    try {
      const r = await syncClientSatisfiedFacts(scope);
      written += r.written;
      withdrawn += r.withdrawn;
    } catch (err) {
      console.error(`[lead-service] client satisfied facts: sync failed for org ${scope.orgId} brand ${scope.brandId}, its facts stay as they were:`, err);
    }
  }
  return { written, withdrawn };
}

export function startClientSentimentWorker(): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await judgeClientSentimentOnce();
      const f = await syncAllClientSatisfiedFacts();
      if (r.judged > 0 || f.written > 0 || f.withdrawn > 0) {
        console.log(`[lead-service] client sentiment: judged=${r.judged} positive=${r.positive} factsWritten=${f.written} factsWithdrawn=${f.withdrawn}`);
      }
    } catch (err) {
      console.error("[lead-service] client sentiment pass failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), CLIENT_SENTIMENT_INTERVAL_MS).unref();
}

export interface ClientMessageVerdict {
  /** crm-service's fact id of the message (one message = one id). */
  messageId: string;
  occurredAt: string | null;
  channel: string;
  sentiment: ClientSentiment;
  confidence: number;
  model: string;
  judgedAt: string;
  humanId: string;
  companyKey: string;
  /** The brand's lead rows of the writer's relation (registered on its emails or phones, dated at the brand), oldest first; empty = no lead row. */
  leadIds: string[];
}

export interface ClientSentimentRead {
  brandId: string;
  /** Live client messages of the brand. `judged + unjudged = messages`. */
  messages: number;
  judged: number;
  /** Client messages not judged yet: while > 0 the counts are not final. */
  unjudged: number;
  /** The newest client message every older one of which is judged (null = none judged, or no message). */
  judgedThrough: string | null;
  counts: Record<ClientSentiment, number>;
  /** Per UTC day of the message, every live client message (undated ones only in the totals). */
  days: ClientSentimentDay[];
  verdicts: ClientMessageVerdict[];
}

export interface ClientSentimentDay {
  day: string;
  positive: number;
  neutral: number;
  negative: number;
  unjudged: number;
}

/** PURE: newest instant `t` such that every message at or before `t` is judged. */
export function judgedThroughOf(rows: ReadonlyArray<{ at: string | null; judged: boolean }>): string | null {
  const dated = rows.filter((r) => r.at !== null).sort((a, b) => (a.at! < b.at! ? -1 : a.at! > b.at! ? 1 : 0));
  let through: string | null = null;
  for (const r of dated) {
    if (!r.judged) break;
    through = r.at;
  }
  return through;
}

/**
 * The brand's client messages and their verdicts (since inception, or from `since`), oldest first. Only messages of a
 * relation that is a client NOW; `sentiment` filters the listed verdicts, never the counts.
 */
export async function readClientSentiment(
  scope: Scope,
  opts: { since?: string; sentiment?: ClientSentiment } = {},
): Promise<ClientSentimentRead> {
  const clients = await clientRelations(scope);
  const points = pointsOf(clients);
  const empty: ClientSentimentRead = {
    brandId: scope.brandId,
    messages: 0,
    judged: 0,
    unjudged: 0,
    judgedThrough: null,
    counts: { positive: 0, neutral: 0, negative: 0 },
    days: [],
    verdicts: [],
  };
  if (points.length === 0) return empty;
  const rows = (await db.execute(sql`
    SELECT f.fact_id, f.contact_point, f.source, f.payload->>'channel' AS channel, f.occurred_at AS at,
           j.sentiment, j.confidence, j.model, j.judged_at
    FROM crm_facts f
    LEFT JOIN client_sentiment_judgments j ON j.fact_id = f.fact_id
    WHERE ${clientMessagesWhere(scope, points)}
      ${opts.since ? sql`AND f.occurred_at >= ${opts.since}` : sql``}
    ORDER BY f.occurred_at NULLS FIRST, f.seq
  `)) as unknown as Array<{
    fact_id: string;
    contact_point: string;
    source: string;
    channel: string | null;
    at: Ts | null;
    sentiment: ClientSentiment | null;
    confidence: number | null;
    model: string | null;
    judged_at: Ts | null;
  }>;
  const leadsOf = await relationLeads(scope, clients);
  const ownerOf = new Map<string, ClientRelation>();
  for (const c of clients) for (const p of c.contactPoints) if (!ownerOf.has(p)) ownerOf.set(p, c);
  const out: ClientSentimentRead = { ...empty, counts: { positive: 0, neutral: 0, negative: 0 }, days: [], verdicts: [] };
  const days = new Map<string, ClientSentimentDay>();
  for (const r of rows) {
    out.messages++;
    const day = r.at === null ? null : (toIsoTimestamp(r.at)?.slice(0, 10) ?? null);
    const d = day === null ? null : (days.get(day) ?? days.set(day, { day, positive: 0, neutral: 0, negative: 0, unjudged: 0 }).get(day)!);
    if (r.sentiment === null) {
      out.unjudged++;
      if (d) d.unjudged++;
      continue;
    }
    if (d) d[r.sentiment]++;
    out.judged++;
    out.counts[r.sentiment]++;
    if (opts.sentiment && r.sentiment !== opts.sentiment) continue;
    const owner = ownerOf.get(r.contact_point)!;
    out.verdicts.push({
      messageId: r.fact_id,
      occurredAt: r.at === null ? null : toIsoTimestamp(r.at),
      channel: r.channel ?? r.source,
      sentiment: r.sentiment,
      confidence: Number(r.confidence),
      model: r.model!,
      judgedAt: toIsoTimestamp(r.judged_at!)!,
      humanId: owner.humanId,
      companyKey: owner.companyKey,
      leadIds: leadsOf.get(subjectKey(owner.humanId, owner.companyKey)) ?? [],
    });
  }
  out.days = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  out.judgedThrough = judgedThroughOf(rows.map((r) => ({ at: r.at === null ? null : toIsoTimestamp(r.at), judged: r.sentiment !== null })));
  return out;
}
