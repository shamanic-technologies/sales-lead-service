/**
 * Which acts of a person COUNT as "they did something toward this brand" (LEADS-JUDGE-BRAND-1021, owner 2026-10-21),
 * the half of `actedTowardUsSql` (lead-followup-date.ts) read off crm-service's fact copy, stored as
 * `lead_followup_dates.last_action_at`.
 *
 * Incident 2026-10-16 → 10-19: "Lead follow-up due" re-served dmeyer@ushg.com to distribute.you on an out-of-office
 * ("Automatic reply: [EXTERNAL] workforce transition") that answered ANOTHER org's campaign send from a shared Gmail,
 * and Doc Dinners' prospects (regina@cookchiropracticcenter.com...) on their replies about chiropractic dinners. An act
 * counts only when BOTH hold, each a fact someone else judged, never a rule on words, subjects or mailboxes:
 *   1. it happened on a contact point crm-service reads as professional TO the brand: a point of one of the brand's
 *      relationship subjects (crm's `professional_to_brand` relations), and not a conversation crm-service judged NOT
 *      about the brand (a live `connection_tag` with that conversation as basis, none of them `professional_to_brand`);
 *   2. a PERSON wrote it: every inbound message (`message_in`) is judged once by Jev, "a person or a machine?"
 *      (`crm_act_judgments`, platform-billed, `ACT_JUDGMENTS_PER_TICK`); unjudged = not counted yet (fail closed: a
 *      serve waits a tick, it never writes to a machine's sender). Other acts (a signup, a form, a payment, a visit)
 *      are the person's by their type.
 * Both can change after the act landed (crm-service re-judges a conversation, a relation is withdrawn), so the store
 * keeps every act (`lead_crm_acts`) and `refreshActedAt` re-derives the last counted one on every pass.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { judgeYesNo, type YesNoQuestion } from "./qualification-judge.js";
import type { RunSupport } from "./run-tasks.js";
import type { ObservedSend } from "./lead-followup-date.js";

/** Inbound messages judged per pass, fleet-wide (the platform's judgment credit is shared by every Jev call). */
export const ACT_JUDGMENTS_PER_TICK = 40;

/**
 * WHOSE WORK the "a person or a machine?" judgment is (PLATFORM-CALLER-RUN-1024): no run stands behind it by design.
 * A fleet-wide 2-min pass over every org's inbound messages, judged once per fact; it produces no catalogue outcome
 * (it only says whether a message counts as an act of theirs), so it is platform LLM support, reported apart.
 */
export const AUTOMATED_ACT_SUPPORT: RunSupport = {
  kind: "platform_llm",
  reason: "Fleet-wide pass judging once per inbound message whether a person or a machine wrote it, before it counts as an act toward the brand; produces no outcome.",
};
/** A message reads as a machine's from this probability up (Jev's "more likely than not"). */
export const AUTOMATED_MIN_PROBABILITY = 0.5;
/** What Jev reads of a message: its subject and first words say whether a person wrote it. */
const MESSAGE_CHARS = 1_500;

export const AUTOMATED_QUESTION: YesNoQuestion = {
  instructions:
    "Was `message` sent automatically, with no person writing it for this exchange: an out-of-office or away reply, " +
    "an automatic acknowledgment or ticket notice, a delivery or system notice, a newsletter or notification?",
  whenTrue: "No person wrote this message for this exchange: a machine or an automatic rule sent it.",
  whenFalse: "A person wrote this message themselves, however short.",
};

/** Store every act of theirs read off a Unibox fact (one row per fact x lead it names). Idempotent. */
export async function recordTheirActs(acts: readonly ObservedSend[]): Promise<number> {
  const rows = acts.filter((a) => a.fact);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1_000) {
    const chunk = rows.slice(i, i + 1_000);
    const out = (await db.execute(sql`
      INSERT INTO lead_crm_acts (org_id, brand_id, lead_id, fact_id, type, contact_point, at)
      SELECT * FROM unnest(
        ${sql.param(chunk.map((r) => r.orgId))}::text[],
        ${sql.param(chunk.map((r) => r.brandId))}::text[],
        ${sql.param(chunk.map((r) => r.leadId))}::uuid[],
        ${sql.param(chunk.map((r) => r.fact!.factId))}::text[],
        ${sql.param(chunk.map((r) => r.fact!.type))}::text[],
        ${sql.param(chunk.map((r) => r.fact!.contactPoint))}::text[],
        ${sql.param(chunk.map((r) => r.sentAt))}::timestamptz[]
      )
      ON CONFLICT (org_id, brand_id, lead_id, fact_id) DO NOTHING
      RETURNING 1
    `)) as unknown as unknown[];
    inserted += out.length;
  }
  return inserted;
}

export interface ActScope {
  orgId: string;
  brandId: string;
}

const scoped = (alias: SQL, scope: ActScope | null): SQL =>
  scope ? sql`${alias}.org_id = ${scope.orgId} AND ${alias}.brand_id = ${scope.brandId}` : sql`TRUE`;

/**
 * SQL CTEs `to_brand_points` (org, brand, cp): the contact points an act may count on (rule 1), for the scope.
 * The subjects' points are unnested once (a per-act `= ANY(contact_points)` scans every subject). Each list is
 * MATERIALIZED: inlined, the planner estimated one row and re-ran the not-this-brand aggregation over every crm tag
 * for each act (the fleet pass hit the statement timeout every 2 min in prod; materialized: 0.95 s).
 */
function toBrandPointsCte(scope: ActScope | null): SQL {
  return sql`
    subject_points AS MATERIALIZED (
      SELECT DISTINCT s.org_id, s.brand_id, cp FROM relationship_subjects s CROSS JOIN LATERAL unnest(s.contact_points) AS cp
      WHERE ${scoped(sql`s`, scope)}
    ),
    not_brand_conversations AS MATERIALIZED (
      SELECT r.org_id, r.brand_id, b->>'ref' AS cp
      FROM crm_registry_facts r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload->'basis', '[]'::jsonb)) AS b
      WHERE r.type = 'connection_tag' AND b->>'kind' = 'conversation' AND ${scoped(sql`r`, scope)}
        AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = r.fact_id)
      GROUP BY 1, 2, 3
      HAVING bool_and(r.payload->>'tag' IS DISTINCT FROM 'professional_to_brand')
    ),
    to_brand_points AS MATERIALIZED (
      SELECT p.org_id, p.brand_id, p.cp FROM subject_points p
      WHERE NOT EXISTS (SELECT 1 FROM not_brand_conversations n WHERE n.org_id = p.org_id AND n.brand_id = p.brand_id AND n.cp = p.cp)
    )`;
}

/** The inbound messages that would count but nobody judged yet, newest first. */
async function messagesToJudge(limit: number): Promise<Array<{ fact_id: string; subject: string | null; text: string | null; channel: string | null; source: string }>> {
  return (await db.execute(sql`
    WITH ${toBrandPointsCte(null)},
    todo AS (
      SELECT DISTINCT a.fact_id, max(a.at) AS at FROM lead_crm_acts a
      JOIN to_brand_points p ON p.org_id = a.org_id AND p.brand_id = a.brand_id AND p.cp = a.contact_point
      WHERE a.type = 'message_in'
        AND NOT EXISTS (SELECT 1 FROM crm_act_judgments j WHERE j.fact_id = a.fact_id)
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = a.fact_id)
      GROUP BY a.fact_id
      ORDER BY at DESC
      LIMIT ${limit}
    )
    SELECT f.fact_id, f.payload->>'subject' AS subject, f.payload->>'text' AS text, f.payload->>'channel' AS channel, f.source
    FROM todo JOIN crm_facts f ON f.fact_id = todo.fact_id
  `)) as unknown as Array<{ fact_id: string; subject: string | null; text: string | null; channel: string | null; source: string }>;
}

/** PURE: what Jev reads to say "a person or a machine?". */
export function automatedState(m: { subject: string | null; text: string | null; channel: string | null; source: string }) {
  return {
    context:
      "A person a brand works with sent the brand's people this message (`message`, inbound). Say whether a person " +
      "wrote it or it was sent automatically.",
    message: { channel: m.channel ?? m.source, subject: m.subject ?? null, text: (m.text ?? "").slice(0, MESSAGE_CHARS) },
  };
}

/** Judge the next inbound messages that would count, frozen per fact. One failure stops the pass (logged by the caller). */
export async function judgeAutomatedActs(limit = ACT_JUDGMENTS_PER_TICK): Promise<{ judged: number; automated: number }> {
  const todo = await messagesToJudge(limit);
  let judged = 0;
  let automated = 0;
  for (const m of todo) {
    const { probabilities, model } = await judgeYesNo(automatedState(m), { automated: AUTOMATED_QUESTION }, { platform: { support: AUTOMATED_ACT_SUPPORT } });
    const p = probabilities.automated;
    const isAutomated = p >= AUTOMATED_MIN_PROBABILITY;
    await db.execute(sql`
      INSERT INTO crm_act_judgments (fact_id, automated, probability, model, judged_at)
      VALUES (${m.fact_id}, ${isAutomated}, ${p}, ${model}, now())
      ON CONFLICT (fact_id) DO NOTHING
    `);
    judged++;
    if (isAutomated) automated++;
  }
  return { judged, automated };
}

/**
 * SQL (CTE body name `counted_acts`): per (org, brand, lead) the latest act that COUNTS now (rules 1 and 2).
 * Exported for the read-only replay.
 */
export function countedActsSql(scope: ActScope | null): SQL {
  return sql`
    WITH ${toBrandPointsCte(scope)},
    counted_acts AS (
      SELECT a.org_id, a.brand_id, a.lead_id, max(a.at) AS at
      FROM lead_crm_acts a
      JOIN to_brand_points p ON p.org_id = a.org_id AND p.brand_id = a.brand_id AND p.cp = a.contact_point
      WHERE ${scoped(sql`a`, scope)}
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = a.fact_id)
        AND (a.type <> 'message_in' OR EXISTS (SELECT 1 FROM crm_act_judgments j WHERE j.fact_id = a.fact_id AND NOT j.automated))
      GROUP BY a.org_id, a.brand_id, a.lead_id
    )`;
}

/** Re-derive `last_action_at` for every lead date of the scope (all, unscoped) from the acts that count now. */
export async function refreshActedAt(scope: ActScope | null): Promise<{ changed: number }> {
  const rows = (await db.execute(sql`
    ${countedActsSql(scope)},
    target AS (
      SELECT d.org_id, d.brand_id, d.lead_id, c.at
      FROM lead_followup_dates d
      LEFT JOIN counted_acts c ON c.org_id = d.org_id AND c.brand_id = d.brand_id AND c.lead_id = d.lead_id
      WHERE ${scoped(sql`d`, scope)} AND (d.last_action_at IS NOT NULL OR c.at IS NOT NULL)
    )
    UPDATE lead_followup_dates d SET last_action_at = t.at, updated_at = now()
    FROM target t
    WHERE d.org_id = t.org_id AND d.brand_id = t.brand_id AND d.lead_id = t.lead_id
      AND d.last_action_at IS DISTINCT FROM t.at
    RETURNING 1
  `)) as unknown as unknown[];
  return { changed: rows.length };
}
