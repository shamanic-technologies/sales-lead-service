/**
 * WHO IS WAITING ON US (owner 2026-10-11, dashboard "Needs your call"): the people who wrote back
 * and whose latest message came after any answer of ours. Pure: it reads one person's conversation
 * at a brand and says whether they are waiting, since when, and what kind of message they sent.
 *
 * What counts, and why:
 *   - A message FROM the person is a reply fact of the outreach provider, placed by the SAME
 *     `replyLabel` the timeline uses (never a kind name). A machine's answer (`auto_reply`) is not a
 *     person's word and is ignored. A reply not judged yet (`replyLabel` null) is ignored until it is.
 *   - An ANSWER of ours is any email we sent into their thread outside the sequence (`reply_sent`:
 *     our replies route, a person or the AI responder, either transport; a staff answer CC'd to the
 *     mailbox; an answer typed into the provider's Unibox) OR a person's statement "I answered this
 *     person outside the platform" (answered_outside_statements), dated when stated, OR an email one
 *     of our people sent them from a mirrored Gmail that Jev judged an answer to what they wrote
 *     (outside_answer_judgments, `outside-answers.ts`), dated when sent. A sequence
 *     follow-up is NOT an answer: it was scheduled before they wrote.
 *   - They are waiting iff their latest word, after the latest answer, is one that asks something of
 *     us (`WAITING_LABELS`: interest, a question, a referral, another proposal, a hand-over to a
 *     person). A no, a wrong contact, a changed job, "already a client" is a last word that waits on
 *     nobody.
 *   - An opt-out is absolute and sticky: a stop request in any reply, or an unsubscribe, takes the
 *     person out for good whatever they said around it.
 *   - `waitingSince` is the FIRST word of theirs after our latest answer (two unanswered messages
 *     wait since the first); `lastMessage` is the latest. No age limit: a two-month-old reply nobody
 *     answered stays and shows its age.
 *   - Website visitors never enter: only a message they wrote does.
 * Undated facts cannot be ordered against an answer and are left out.
 */
import type { TimelineItemLabel } from "./timeline-labels.js";

/** The last words that ask something of us. */
export const WAITING_LABELS: ReadonlySet<TimelineItemLabel> = new Set<TimelineItemLabel>([
  "interested",
  "question_answerable",
  "question_to_escalate",
  "question",
  "referral",
  "other_proposal",
  "hand_over",
]);

/** The coarse kind the dashboard words its one line on. */
export type AwaitingMessageKind = "question" | "interest" | "other";

export function messageKindOf(label: TimelineItemLabel): AwaitingMessageKind {
  if (label === "question" || label === "question_answerable" || label === "question_to_escalate") return "question";
  if (label === "interested") return "interest";
  return "other";
}

/** One thing that happened in a person's conversation at the brand. */
export type ConversationEvent =
  | { type: "inbound"; at: string; label: TimelineItemLabel; campaignId: string | null; subject: string | null; ref: string }
  | { type: "answer"; at: string; via: AnswerVia }
  | { type: "opt_out"; at: string };

/** How we answered: a reply_sent fact's own `via`, or a person's statement. */
export type AnswerVia = "replies_route" | "staff_client" | "provider_unibox" | "answered_outside" | "mailbox_judged" | "unknown";

export interface AwaitingReply {
  waitingSince: string;
  lastMessage: {
    at: string;
    kind: AwaitingMessageKind;
    label: TimelineItemLabel;
    subject: string | null;
    campaignId: string | null;
  };
  /** When we last answered (any way), null = never. */
  lastAnsweredAt: string | null;
  /** How many of their messages are unanswered (person's words only). */
  unansweredMessages: number;
}

function ms(at: string): number {
  return Date.parse(at);
}

/** The person's waiting state, or null when they are not waiting on us. */
export function awaitingReplyOf(events: readonly ConversationEvent[]): AwaitingReply | null {
  const dated = events.filter((e) => !Number.isNaN(ms(e.at)));
  if (dated.some((e) => e.type === "opt_out")) return null;

  let lastAnsweredMs = Number.NEGATIVE_INFINITY;
  let lastAnsweredAt: string | null = null;
  for (const e of dated) {
    if (e.type === "answer" && ms(e.at) > lastAnsweredMs) {
      lastAnsweredMs = ms(e.at);
      lastAnsweredAt = e.at;
    }
  }

  const unanswered = dated
    .filter((e): e is Extract<ConversationEvent, { type: "inbound" }> => e.type === "inbound")
    .filter((e) => e.label !== "auto_reply" && ms(e.at) > lastAnsweredMs)
    .sort((a, b) => ms(a.at) - ms(b.at) || a.ref.localeCompare(b.ref));
  if (unanswered.length === 0) return null;

  const last = unanswered[unanswered.length - 1];
  if (!WAITING_LABELS.has(last.label)) return null;

  return {
    waitingSince: new Date(ms(unanswered[0].at)).toISOString(),
    lastMessage: {
      at: new Date(ms(last.at)).toISOString(),
      kind: messageKindOf(last.label),
      label: last.label,
      subject: last.subject,
      campaignId: last.campaignId,
    },
    lastAnsweredAt: lastAnsweredAt === null ? null : new Date(lastAnsweredMs).toISOString(),
    unansweredMessages: unanswered.length,
  };
}
