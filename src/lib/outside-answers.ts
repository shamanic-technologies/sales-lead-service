/**
 * "Did one of our people answer them OUTSIDE the platform?" (owner 2026-10-12: "MUST BE
 * AUTOMATED. Jev should choose if my email was an answer to their email or something unrelated.")
 *
 * Our people answer prospects by hand from their own Gmail, outside every sending inbox. Two
 * google-service mirrors hold those emails, and both are read for every person waiting on us:
 *   - the ORG's own mailboxes (`GET /orgs/google/conversation`): an org member's Gmail;
 *   - the STAFF mailboxes (`GET /internal/staff-mailboxes/conversation`): staff operate client
 *     brands and answer from their own Gmail, mirrored under the staff org, never the client's.
 * Who is "ours" is the mirror's own `direction: "outbound"` (the mailbox owner's addresses and
 * aliases, decided by google-service), never a header read here.
 *
 * A candidate = an outbound email to the person (in its To), sent after their first unanswered
 * message. Whether it ANSWERS them is never decided by a rule: each candidate is judged ONCE by Jev
 * (chat-service `POST /orgs/judgments`, billed to the org whose request asked) against what they
 * wrote, and the verdict is frozen in `outside_answer_judgments` with the model release. A "yes"
 * is an answer of ours dated when the email was sent; a "no" (unrelated email) keeps them waiting
 * and is kept so the email is never judged again.
 *
 * Nothing here can make the list lie in the "answered" direction: a mirror or a judgment we could
 * not read leaves the person listed and is STATED (`complete: false` + reasons), never guessed.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { judgeYesNo } from "./qualification-judge.js";
import {
  fetchMailboxConversation,
  fetchStaffMailboxConversation,
  type MailboxContext,
  type MailboxConversation,
} from "./mailbox-client.js";
import { fetchOutreachConversation } from "./outreach-client.js";

export type MailboxKind = "org" | "staff";

/** One email of ours to the person, out of a mirror. */
export interface OutsideCandidate {
  gmailMessageId: string;
  mailbox: MailboxKind;
  fromEmail: string | null;
  sentAt: string;
  subject: string | null;
  text: string | null;
}

/** Their unanswered word, as the outreach copy placed it. */
export interface InboundWord {
  at: string;
  ref: string;
  campaignId: string | null;
  subject: string | null;
  label: string;
}

const MAX_TEXT_CHARS = 6_000;
const PEOPLE_IN_FLIGHT = 6;
/** A person whose mirrors answered completely is not re-read for this long (per HTTP thread). */
const RECHECK_AFTER_MS = 2 * 60_000;
/** A yes-probability at or above this is an answer. */
export const ANSWERS_THRESHOLD = 0.5;

function clip(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t;
}

/**
 * Pure: the emails of ours to `email` sent strictly after `since`, out of the mirrors that
 * answered, one per Gmail message (the org copy wins over the staff copy of the same message),
 * oldest first.
 */
export function outsideAnswerCandidates(
  email: string,
  since: string,
  reads: ReadonlyArray<{ mailbox: MailboxKind; conversation: MailboxConversation | null }>,
): OutsideCandidate[] {
  const who = email.trim().toLowerCase();
  const sinceMs = Date.parse(since);
  const byId = new Map<string, OutsideCandidate>();
  for (const { mailbox, conversation } of reads) {
    for (const thread of conversation?.threads ?? []) {
      for (const m of thread.messages ?? []) {
        if (m.direction !== "outbound" || !m.gmailMessageId || !m.sentAt) continue;
        const sentMs = Date.parse(m.sentAt);
        if (Number.isNaN(sentMs) || !(sentMs > sinceMs)) continue;
        if (!(m.to ?? []).some((t) => t.trim().toLowerCase() === who)) continue;
        if (byId.has(m.gmailMessageId)) continue;
        byId.set(m.gmailMessageId, {
          gmailMessageId: m.gmailMessageId,
          mailbox,
          fromEmail: m.fromEmail,
          sentAt: new Date(sentMs).toISOString(),
          subject: m.subject,
          text: clip(m.bodyText ?? m.snippet),
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.gmailMessageId.localeCompare(b.gmailMessageId));
}

/** A frozen "yes, it answered them" verdict, as an answer event of ours. */
export interface JudgedAnswer {
  leadId: string;
  sentAt: string;
}

/** Every "it answered them" verdict at the brand (the read folds them in as answers). */
export async function readJudgedAnswers(orgId: string, brandId: string, leadIds?: readonly string[]): Promise<JudgedAnswer[]> {
  const rows = (await sql`
    SELECT lead_id::text AS lead_id, sent_at
    FROM outside_answer_judgments
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND answers = true
  `) as unknown as Array<{ lead_id: string; sent_at: Date | string }>;
  const only = leadIds ? new Set(leadIds) : null;
  return rows
    .filter((r) => !only || only.has(r.lead_id))
    .map((r) => ({ leadId: r.lead_id, sentAt: toIsoTimestamp(r.sent_at)! }));
}

async function readJudgedMessageIds(orgId: string, brandId: string, leadId: string): Promise<Set<string>> {
  const rows = (await sql`
    SELECT gmail_message_id FROM outside_answer_judgments
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ${leadId}::uuid
  `) as unknown as Array<{ gmail_message_id: string }>;
  return new Set(rows.map((r) => r.gmail_message_id));
}

const QUESTION = {
  instructions:
    "A prospect wrote to us (their messages are `theirMessages`). Later, one of our people sent them the email in " +
    "`ourEmail`, by hand, from their own mailbox. Does `ourEmail` answer what the prospect wrote: does it respond to " +
    "their question, their interest or their request, even briefly or partly?",
  whenTrue:
    "Our email responds to what they wrote: it answers their question, follows up on their interest or request, " +
    "gives them what they asked for, or replies to their message in any way a person would read as our answer.",
  whenFalse:
    "Our email is about something else: a different topic, a newsletter or announcement, a message meant for " +
    "another conversation, or anything that leaves what they wrote unaddressed.",
};

/** Pure: the state Jev reads. */
export function judgmentState(theirMessages: ReadonlyArray<{ at: string; subject: string | null; text: string | null; label: string | null }>, ours: OutsideCandidate) {
  return {
    theirMessages: theirMessages.map((m) => ({ sentAt: m.at, subject: m.subject, text: m.text, whatTheyAsked: m.label })),
    ourEmail: { sentAt: ours.sentAt, from: ours.fromEmail, subject: ours.subject, text: ours.text },
  };
}

export interface OutsideCheckPerson {
  leadId: string;
  email: string;
  /** Their first unanswered word. */
  waitingSince: string;
  /** Their unanswered words, oldest first. */
  inbound: readonly InboundWord[];
}

export interface OutsideCheckContext extends MailboxContext {
  orgId: string;
  brandId: string;
  userId: string | null;
  runId: string | null;
}

export interface OutsideCheckReport {
  /** People whose mirrors were read (or recently read) for this answer. */
  checked: number;
  /** False when at least one mirror or judgment could not be read: those people stay listed. */
  complete: boolean;
  unreadable: Array<{ leadId: string; email: string; reason: string }>;
  /** Verdicts written by this read. */
  judged: number;
  /** Why nothing was read at all (the request carried no user/run to read the mirrors with), else null. */
  reason: string | null;
}

const recentlyChecked = new Map<string, number>();

/** Test seam: forget the per-thread recheck memo. */
export function resetOutsideAnswerMemo(): void {
  recentlyChecked.clear();
}

async function theirWords(
  person: OutsideCheckPerson,
  before: string,
  ctx: OutsideCheckContext,
  mailboxReads: ReadonlyArray<{ mailbox: MailboxKind; conversation: MailboxConversation | null }>,
): Promise<{ ok: true; words: Array<{ at: string; subject: string | null; text: string | null; label: string | null }> } | { ok: false; reason: string }> {
  const fromMs = Date.parse(person.waitingSince);
  const toMs = Date.parse(before);
  const inWindow = (at: string) => {
    const t = Date.parse(at);
    return !Number.isNaN(t) && t >= fromMs - 60_000 && t < toMs;
  };
  const who = person.email.toLowerCase();
  const words: Array<{ at: string; subject: string | null; text: string | null; label: string | null }> = [];

  const campaigns = [...new Set(person.inbound.map((w) => w.campaignId).filter((c): c is string => !!c))];
  for (const campaignId of campaigns) {
    const read = await fetchOutreachConversation(campaignId, person.email, ctx);
    if (!read.ok) return { ok: false, reason: read.reason };
    for (const m of read.data?.messages ?? []) {
      if (m.direction === "inbound" && inWindow(m.at)) words.push({ at: m.at, subject: m.subject, text: clip(m.text), label: null });
    }
  }
  for (const { conversation } of mailboxReads) {
    for (const thread of conversation?.threads ?? []) {
      for (const m of thread.messages ?? []) {
        if (m.direction === "inbound" && m.sentAt && (m.fromEmail ?? "").toLowerCase() === who && inWindow(m.sentAt)) {
          words.push({ at: m.sentAt, subject: m.subject, text: clip(m.bodyText ?? m.snippet), label: null });
        }
      }
    }
  }
  // What the outreach copy understood of each word (question, interest...) rides beside the text;
  // a word whose text no copy holds still reaches Jev by its subject and label.
  const placed = person.inbound.filter((w) => Date.parse(w.at) < toMs);
  if (words.length === 0) {
    for (const w of placed) words.push({ at: w.at, subject: w.subject, text: null, label: w.label });
  } else if (placed.length > 0) {
    words[words.length - 1] = { ...words[words.length - 1], label: placed[placed.length - 1].label };
  }
  words.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ok: true, words };
}

async function checkPerson(person: OutsideCheckPerson, ctx: OutsideCheckContext): Promise<{ judged: number } | { reason: string }> {
  const [org, staff] = await Promise.all([
    fetchMailboxConversation(person.email, ctx),
    fetchStaffMailboxConversation(person.email, ctx),
  ]);
  if (!org.ok) return { reason: `org mailbox: ${org.reason}` };
  if (!staff.ok) return { reason: `staff mailbox: ${staff.reason}` };
  const reads = [
    { mailbox: "org" as const, conversation: org.data },
    { mailbox: "staff" as const, conversation: staff.data },
  ];
  const candidates = outsideAnswerCandidates(person.email, person.waitingSince, reads);
  if (candidates.length === 0) return { judged: 0 };

  const done = await readJudgedMessageIds(ctx.orgId, ctx.brandId, person.leadId);
  let judged = 0;
  for (const c of candidates) {
    if (done.has(c.gmailMessageId)) continue;
    if (!ctx.runId) return { reason: "no run id on the request: the judgment has no run to hang on" };
    const words = await theirWords(person, c.sentAt, ctx, reads);
    if (!words.ok) return { reason: `their messages: ${words.reason}` };
    const latest = person.inbound.filter((w) => Date.parse(w.at) < Date.parse(c.sentAt)).at(-1) ?? null;
    let verdict: { probabilities: { answers: number }; model: string };
    try {
      verdict = await judgeYesNo(judgmentState(words.words, c), { answers: QUESTION }, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        runId: ctx.runId,
        brandId: ctx.brandId,
      });
    } catch (error) {
      return { reason: `judgment: ${(error as Error).message}` };
    }
    const p = verdict.probabilities.answers;
    await sql`
      INSERT INTO outside_answer_judgments
        (org_id, brand_id, lead_id, gmail_message_id, mailbox, from_email, sent_at, subject, inbound_ref, answers, probability, model)
      VALUES (${ctx.orgId}, ${ctx.brandId}, ${person.leadId}::uuid, ${c.gmailMessageId}, ${c.mailbox}, ${c.fromEmail},
              ${c.sentAt}::timestamptz, ${c.subject}, ${latest?.ref ?? null}, ${p >= ANSWERS_THRESHOLD}, ${p}, ${verdict.model})
      ON CONFLICT (org_id, brand_id, lead_id, gmail_message_id) DO NOTHING
    `;
    judged += 1;
    console.log(
      `[lead-service] outside answer judged org=${ctx.orgId} brand=${ctx.brandId} lead=${person.leadId} message=${c.gmailMessageId} mailbox=${c.mailbox} answers=${p >= ANSWERS_THRESHOLD} p=${p.toFixed(3)}`,
    );
    // Once an email answers them, a later one changes nothing until they write again.
    if (p >= ANSWERS_THRESHOLD) break;
  }
  return { judged };
}

/**
 * Read both mirrors for every person waiting, and judge every new email of ours to them. Bounded
 * (six people in flight); a person whose mirrors answered completely is not re-read for two minutes.
 */
export async function checkOutsideAnswers(people: readonly OutsideCheckPerson[], ctx: OutsideCheckContext): Promise<OutsideCheckReport> {
  const report: OutsideCheckReport = { checked: 0, complete: true, unreadable: [], judged: 0, reason: null };
  if (people.length === 0) return report;
  if (!ctx.userId || !ctx.runId) {
    return { ...report, complete: false, reason: "the request carried no x-user-id/x-run-id: the Gmail mirrors cannot be read without them" };
  }
  const now = Date.now();
  const todo = people.filter((p) => {
    const key = `${ctx.orgId}|${ctx.brandId}|${p.leadId}|${p.waitingSince}`;
    const at = recentlyChecked.get(key);
    if (at !== undefined && now - at < RECHECK_AFTER_MS) {
      report.checked += 1;
      return false;
    }
    return true;
  });
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const person = todo[next++];
      const result = await checkPerson(person, ctx);
      if ("reason" in result) {
        report.complete = false;
        report.unreadable.push({ leadId: person.leadId, email: person.email, reason: result.reason });
        console.warn(`[lead-service] outside answer check incomplete org=${ctx.orgId} brand=${ctx.brandId} lead=${person.leadId}: ${result.reason}`);
        continue;
      }
      report.checked += 1;
      report.judged += result.judged;
      recentlyChecked.set(`${ctx.orgId}|${ctx.brandId}|${person.leadId}|${person.waitingSince}`, Date.now());
    }
  };
  await Promise.all(Array.from({ length: Math.min(PEOPLE_IN_FLIGHT, todo.length) }, worker));
  return report;
}
