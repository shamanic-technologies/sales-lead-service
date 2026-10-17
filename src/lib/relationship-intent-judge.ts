/**
 * Jev's answer to "does this lead WANT to do business with the brand?" (HOT-INBOUND-UNANSWERED-1016; rules in
 * relationship-intent.ts). Asked of every lead of the brand who WROTE to us (`relationship_subjects.wrote_to_us`:
 * a message on any mirrored channel, a signup, a form, a meeting, a payment, a reply to our outreach), once, then again
 * only when the thread moved (`thread_seq`) or the person wrote again (`last_inbound_at`). Frozen in
 * `relationship_intent_judgments`.
 *
 * One question, on the NEWEST part of the thread (`INTENT_THREAD_BUDGET_CHARS`): what someone wants now is in what
 * they said last. Billed to the PLATFORM like the tags (no org request starts the sweep; the TypeSafe credit is shared
 * by every judgment of the fleet, hence the per-tick cap in the sweep).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { judgeYesNo, type YesNoQuestion } from "./qualification-judge.js";
import { brandCard, fitThread } from "./relationship-judge.js";
import { loadRelationshipsAt } from "./relationship-read.js";
import { readThread, subjectKey, toSubject, type Scope, type Subject } from "./relationship-subjects.js";
import { JUDGED_NO } from "./relationship-tags.js";

export const INTENT_THREAD_BUDGET_CHARS = 12_000;

const CONTEXT =
  "You read everything a brand knows about ONE person who wrote to it: every message between the person and the " +
  "brand's own people (email, WhatsApp, LinkedIn), signups, payments, forms, meetings, and what the brand's cold " +
  "outreach sent them and what they answered. Messages with direction `out` were written by the brand's own people; " +
  "`in` were written by the person. `asOf` is today. Say how likely it is that the person, as of their latest words " +
  "and acts, wants to do business with the brand.";

export const WANTS_BUSINESS_QUESTION: YesNoQuestion = {
  instructions:
    "Does this person WANT to do business with the brand now: buy, start, keep using or expand what the brand sells, " +
    "or move toward it (they asked about the offer or its price, asked for a call or a demo, said they are looking for " +
    "what the brand sells, signed up and use it, or are a client who wants to keep going)?",
  whenTrue: "Their latest words or acts show they want to buy from the brand, keep buying, or are moving toward it.",
  whenFalse:
    "They declined, asked to stop, only write about something else (private life, selling their own services to the " +
    "brand, press, hiring, a partnership with no purchase), or never showed any wish to buy.",
};

/**
 * Leads of the brand who wrote to us and whose answer is missing or older than their thread. A candidate is a person
 * some basis already makes a lead (prospect / customer: evidence, a person's yes, or a judgment from the unsure edge);
 * the read decides for sure before anyone is asked.
 */
export async function intentSubjectsToJudge(scope: Scope, limit: number): Promise<Subject[]> {
  const rows = (await db.execute(sql`
    SELECT s.* FROM relationship_subjects s
    LEFT JOIN relationship_intent_judgments i ON i.org_id = s.org_id AND i.brand_id = s.brand_id AND i.human_id = s.human_id
      AND i.company_key = s.company_key
    WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId} AND s.wrote_to_us AND s.has_direct
      AND (i.human_id IS NULL OR i.thread_seq < s.thread_seq OR (s.shares_human AND i.thread_scope <> 'relation')
        OR (s.last_inbound_at IS NOT NULL AND (i.inbound_at IS NULL OR s.last_inbound_at > i.inbound_at)))
      AND (
        EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.org_id = s.org_id AND e.brand_id = s.brand_id AND e.human_id = s.human_id
          AND e.company_key = s.company_key AND e.tag IN ('prospect', 'customer'))
        OR EXISTS (SELECT 1 FROM relationship_statements t WHERE t.org_id = s.org_id AND t.brand_id = s.brand_id AND t.human_id = s.human_id
          AND t.company_key = s.company_key AND t.tag IN ('prospect', 'customer') AND t.state = 'yes' AND t.withdrawn_at IS NULL)
        OR EXISTS (SELECT 1 FROM relationship_judgments j WHERE j.org_id = s.org_id AND j.brand_id = s.brand_id AND j.human_id = s.human_id
          AND j.company_key = s.company_key AND ((j.probabilities->>'prospect')::float8 >= ${JUDGED_NO} OR (j.probabilities->>'customer')::float8 >= ${JUDGED_NO}))
      )
    ORDER BY (i.human_id IS NULL) DESC, s.last_inbound_at DESC NULLS LAST
    LIMIT ${limit * 3}
  `)) as unknown as Array<Record<string, unknown>>;
  const candidates = rows.map(toSubject);
  if (candidates.length === 0) return [];
  const blocks = await loadRelationshipsAt(scope.orgId, scope.brandId, candidates.map((c) => ({ humanId: c.humanId, companyKey: c.companyKey })));
  return candidates.filter((c) => {
    const lead = blocks.get(subjectKey(c.humanId, c.companyKey))?.lead.state ?? null;
    return lead === "yes" || lead === "unsure";
  }).slice(0, limit);
}

/** Judge one lead and freeze the answer. Throws on any failure (nothing written). */
export async function judgeIntent(s: Subject, runId: string): Promise<number> {
  const brand = await brandCard(s.brandId);
  const thread = fitThread(await readThread(s), INTENT_THREAD_BUDGET_CHARS);
  const state = { context: CONTEXT, asOf: new Date().toISOString(), brand, person: { name: s.name, emails: s.emails, channels: s.channels }, thread };
  const { probabilities, model } = await judgeYesNo(state, { wants_business: WANTS_BUSINESS_QUESTION }, "platform");
  const p = probabilities.wants_business;
  await db.execute(sql`
    INSERT INTO relationship_intent_judgments (org_id, brand_id, human_id, company_key, p_wants_business, thread_seq, thread_scope, inbound_at, model, run_id, judged_at)
    VALUES (${s.orgId}, ${s.brandId}, ${s.humanId}::uuid, ${s.companyKey}, ${p}, ${s.threadSeq}::bigint, 'relation', ${s.lastInboundAt}::timestamptz, ${model}, ${runId}, now())
    ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET
      p_wants_business = excluded.p_wants_business, thread_scope = excluded.thread_scope, thread_seq = excluded.thread_seq, inbound_at = excluded.inbound_at,
      model = excluded.model, run_id = excluded.run_id, judged_at = excluded.judged_at
  `);
  return p;
}

