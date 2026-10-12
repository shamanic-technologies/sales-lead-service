/**
 * A person's messages on their PERSONAL channels, for "who is waiting on us" (owner 2026-10-12,
 * WA-RESPONDER-1012: "Needs your call" also lists a person who answered on WhatsApp and whom nobody
 * answered, and drops them when we answer on that channel).
 *
 * Source: the bronze copy of crm-service's people fact feed (`crm_facts`, `crm-fact-feed.ts`, a 2-min
 * pull), facts of source `matrix` = the personal messaging bridge (WhatsApp, LinkedIn...: every channel
 * it carries, read the same way, no per-channel branch). `message_in` is their word, `message_out` is
 * ours (the AI responder's reply sent through crm-service, or the owner typing from his phone, which
 * crm-service mirrors). A `withdrawn` fact naming a message takes it back.
 *
 * WHO: a fact names the person by emails and phones; it counts for every lead of the org that holds a
 * row at the brand and carries one of them as a registered contact method (email case-folded, phone as
 * stored). A person who is nobody's lead at the brand is not listed (nothing to open).
 *
 * WHAT their message asks of us is never a rule here: each inbound message that came after our latest
 * answer is judged ONCE by Jev (chat-service `POST /orgs/judgments`, billed to the org whose read asked)
 * against the thread it sits in, and frozen in `personal_message_judgments` with the model release. The
 * verdict plays the role the outreach provider's verdict plays for an email reply: waits on us (question,
 * interest, anything else that leaves the next move to us), closes the talk, asks us to stop (sticky
 * opt-out), or is a machine. A message not judged (no run on the read, the judgment failed) is read as
 * WAITING and the gap is stated: the list never reads a person answered or closed on a guess.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { PEOPLE_FACTS_FEED } from "./crm-fact-feed.js";
import { judgeChoice } from "./qualification-judge.js";
import type { ConversationEvent } from "./awaiting-reply.js";
import type { TimelineItemLabel } from "./timeline-labels.js";

/** The crm fact source that carries personal messaging channels. */
export const PERSONAL_MESSAGES_SOURCE = "matrix";

export const PERSONAL_MESSAGE_VERDICTS = [
  "waits_question",
  "waits_interest",
  "waits_other",
  "closing",
  "stop_request",
  "automated",
] as const;
export type PersonalMessageVerdict = (typeof PERSONAL_MESSAGE_VERDICTS)[number];

const VERDICT_OPTIONS: Record<PersonalMessageVerdict, string> = {
  waits_question:
    "They ask us a question: about the offer, the price, how it works, a time, anything they want us to answer.",
  waits_interest:
    "They say they are interested, want to go ahead, want a call or a demo, or accept what we proposed.",
  waits_other:
    "Anything else a person writes that leaves the next move to us: an answer to our question, facts about " +
    "their business, a request, a referral to someone else, a counter-proposal, a reaction we should follow up on.",
  closing:
    "Their message closes the exchange and asks nothing of us: a thanks or goodbye after we answered, an " +
    "acknowledgment of something finished, a plain no or not interested, or 'wrong person'.",
  stop_request: "They ask us to stop writing to them or to remove them.",
  automated: "An automatic message no person wrote: an away message, a business auto-reply, a system notice.",
};

const INSTRUCTIONS =
  "A person wrote to our team on a personal messaging channel (`channel`). `thread` is the conversation " +
  "so far, oldest first (`from: \"them\"` = the person, `from: \"us\"` = our team); `message` is the one to " +
  "judge, one of theirs. What does `message` ask of us? Read it in the context of the thread: a short " +
  "\"yes\" to our question leaves the next move to us, a \"thanks\" after we answered does not.";

/** A personal-channel verdict as the conversation reads it: a word with a label, or an opt-out. */
export function verdictEvent(
  verdict: PersonalMessageVerdict | null,
  base: { at: string; ref: string; channel: string },
): ConversationEvent {
  if (verdict === "stop_request") return { type: "opt_out", at: base.at };
  const word = (label: TimelineItemLabel, waits: boolean): ConversationEvent => ({
    type: "inbound",
    at: base.at,
    label,
    campaignId: null,
    subject: null,
    ref: base.ref,
    channel: base.channel,
    waits,
  });
  switch (verdict) {
    case "waits_question":
      return word("question", true);
    case "waits_interest":
      return word("interested", true);
    case "waits_other":
      return word("reply", true);
    case "closing":
      return word("reply", false);
    case "automated":
      return word("auto_reply", false);
    default:
      // Not judged: waiting until a verdict says otherwise (never guessed answered or closed).
      return word("reply", true);
  }
}

export interface PersonalMessage {
  factId: string;
  leadId: string;
  direction: "in" | "out";
  at: string;
  channel: string;
  text: string | null;
}

interface RawMessageRow {
  fact_id: string;
  lead_id: string;
  type: string;
  occurred_at: Date | string | null;
  channel: string | null;
  text: string | null;
}

/**
 * Every live personal-channel message at the brand, per lead of the brand it names. One statement: the
 * brand's leads' contact methods are built once and joined to the facts' identifiers (never a per-fact
 * scan of every contact method).
 */
export async function readPersonalMessages(orgId: string, brandId: string): Promise<PersonalMessage[]> {
  const rows = (await sql`
    WITH brand_leads AS (
      SELECT DISTINCT lead_id FROM leads_campaigns
      WHERE org_id = ${orgId} AND brand_ids @> ARRAY[${brandId}]::text[]
    ), brand_ids AS (
      SELECT DISTINCT cm.lead_id, cm.channel,
             CASE WHEN cm.channel = 'email' THEN lower(cm.value) ELSE cm.value END AS v
      FROM lead_contact_methods cm
      JOIN brand_leads bl ON bl.lead_id = cm.lead_id
      WHERE cm.channel IN ('email', 'phone')
    ), withdrawn AS (
      SELECT withdrawn_of FROM crm_facts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND type = 'withdrawn' AND withdrawn_of IS NOT NULL
    ), live AS (
      SELECT f.fact_id, f.type, f.occurred_at, f.emails, f.phones, f.payload
      FROM crm_facts f
      WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
        AND f.source = ${PERSONAL_MESSAGES_SOURCE}
        AND f.type IN ('message_in', 'message_out')
        AND f.occurred_at IS NOT NULL
        AND f.fact_id NOT IN (SELECT withdrawn_of FROM withdrawn)
    ), named AS (
      SELECT l.fact_id, 'email'::text AS channel, lower(e) AS v FROM live l, unnest(l.emails) e
      UNION
      SELECT l.fact_id, 'phone'::text, p FROM live l, unnest(l.phones) p
    )
    SELECT DISTINCT live.fact_id, b.lead_id::text AS lead_id, live.type, live.occurred_at,
           live.payload->>'channel' AS channel, live.payload->>'text' AS text
    FROM named
    JOIN brand_ids b ON b.channel = named.channel AND b.v = named.v
    JOIN live ON live.fact_id = named.fact_id
  `) as unknown as RawMessageRow[];

  const out: PersonalMessage[] = [];
  for (const r of rows) {
    const at = toIsoTimestamp(r.occurred_at);
    if (at === null) continue;
    out.push({
      factId: r.fact_id,
      leadId: r.lead_id,
      direction: r.type === "message_out" ? "out" : "in",
      at,
      channel: r.channel && r.channel.length > 0 ? r.channel : "personal",
      text: r.text,
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.factId.localeCompare(b.factId));
}

/** Frozen verdicts at the brand, by fact id. */
export async function readPersonalMessageVerdicts(orgId: string, brandId: string): Promise<Map<string, PersonalMessageVerdict>> {
  const rows = (await sql`
    SELECT fact_id, verdict FROM personal_message_judgments WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `) as unknown as Array<{ fact_id: string; verdict: string }>;
  const map = new Map<string, PersonalMessageVerdict>();
  for (const r of rows) {
    if ((PERSONAL_MESSAGE_VERDICTS as readonly string[]).includes(r.verdict)) map.set(r.fact_id, r.verdict as PersonalMessageVerdict);
  }
  return map;
}

/** Whether the crm fact copy reached the feed's end once (before that, our answers could be missing). */
export async function personalFeedCaughtUp(): Promise<boolean> {
  const rows = (await sql`
    SELECT caught_up_at FROM crm_feed_cursors WHERE feed = ${PEOPLE_FACTS_FEED}
  `) as unknown as Array<{ caught_up_at: Date | string | null }>;
  return rows[0]?.caught_up_at != null;
}

export interface PersonalMessagesReport {
  /** Personal-channel messages of theirs judged by this read. */
  judged: number;
  /** False when a message could not be judged (it is listed as waiting) or the copy is not whole. */
  complete: boolean;
  unjudged: Array<{ leadId: string; factId: string; reason: string }>;
  /** Why nothing was read or judged at all, else null. */
  reason: string | null;
}

export interface PersonalJudgeContext {
  orgId: string;
  brandId: string;
  userId: string | null;
  runId: string | null;
}

const MAX_TEXT_CHARS = 4_000;
const THREAD_CONTEXT_MESSAGES = 12;
const JUDGMENTS_IN_FLIGHT = 6;

function clip(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  return t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t;
}

/** Pure: the state Jev reads for one message of theirs. */
export function personalJudgmentState(thread: readonly PersonalMessage[], message: PersonalMessage) {
  const before = thread.filter((m) => m.factId !== message.factId && Date.parse(m.at) <= Date.parse(message.at));
  return {
    channel: message.channel,
    thread: before.slice(-THREAD_CONTEXT_MESSAGES).map((m) => ({ from: m.direction === "in" ? "them" : "us", at: m.at, text: clip(m.text) })),
    message: { at: message.at, text: clip(message.text) },
  };
}

/**
 * Judge every message of theirs that came after our latest answer and holds no verdict yet. `lastAnswerAt`
 * is per lead, over EVERY channel (an email answer counts). Verdicts are written to `verdicts` as they land.
 */
export async function judgeUnansweredPersonalMessages(
  messages: readonly PersonalMessage[],
  lastAnswerAt: ReadonlyMap<string, number>,
  verdicts: Map<string, PersonalMessageVerdict>,
  ctx: PersonalJudgeContext,
): Promise<PersonalMessagesReport> {
  const report: PersonalMessagesReport = { judged: 0, complete: true, unjudged: [], reason: null };
  const byLead = new Map<string, PersonalMessage[]>();
  for (const m of messages) {
    const list = byLead.get(m.leadId);
    if (list) list.push(m);
    else byLead.set(m.leadId, [m]);
  }
  const todo: Array<{ message: PersonalMessage; thread: PersonalMessage[] }> = [];
  for (const [leadId, thread] of byLead) {
    const since = lastAnswerAt.get(leadId) ?? Number.NEGATIVE_INFINITY;
    for (const m of thread) {
      if (m.direction === "in" && Date.parse(m.at) > since && !verdicts.has(m.factId)) todo.push({ message: m, thread });
    }
  }
  if (todo.length === 0) return report;
  if (!ctx.runId) {
    return {
      ...report,
      complete: false,
      reason: "the request carried no x-run-id: personal-channel messages cannot be judged, they are listed as waiting",
      unjudged: todo.map((t) => ({ leadId: t.message.leadId, factId: t.message.factId, reason: "no_run" })),
    };
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { message, thread } = todo[next++];
      try {
        const answer = await judgeChoice(
          personalJudgmentState(thread, message),
          { instructions: INSTRUCTIONS, options: VERDICT_OPTIONS },
          { orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId!, brandId: ctx.brandId },
        );
        const verdict = answer.choice as PersonalMessageVerdict;
        await sql`
          INSERT INTO personal_message_judgments (fact_id, org_id, brand_id, lead_id, occurred_at, verdict, confidence, model)
          VALUES (${message.factId}, ${ctx.orgId}, ${ctx.brandId}, ${message.leadId}::uuid, ${message.at}::timestamptz,
                  ${verdict}, ${answer.confidence}, ${answer.model})
          ON CONFLICT (fact_id) DO NOTHING
        `;
        verdicts.set(message.factId, verdict);
        report.judged += 1;
        console.log(
          `[lead-service] personal message judged org=${ctx.orgId} brand=${ctx.brandId} lead=${message.leadId} fact=${message.factId} channel=${message.channel} verdict=${verdict}`,
        );
      } catch (error) {
        report.complete = false;
        report.unjudged.push({ leadId: message.leadId, factId: message.factId, reason: (error as Error).message.slice(0, 300) });
        console.warn(`[lead-service] personal message judgment failed fact=${message.factId}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JUDGMENTS_IN_FLIGHT, todo.length) }, worker));
  return report;
}
