/**
 * EVERY ADDRESS ON A MESSAGE IS A PERSON (EVERY-PERSON-ON-THE-THREAD-1109, owner 2026-11-09). Living Vital: our cold
 * email went to Thomas, Thomas forwarded it, his colleague Markus replied in the same thread. instantly-service files
 * that reply under the thread's lead (`leadEmail` = Thomas) and states who wrote it: `participants`
 * (`[{email, role: from|to|cc|bcc}]`, instantly-service EVERY-PERSON-ON-THE-THREAD-1109) and, on facts copied before
 * it, `reply.fromEmail`.
 *
 * PURE. This module only READS the addresses a fact states; it never decides who a person is: "is Markus a lead of the
 * brand" is crm-service's judgment (the Unibox intake files him once crm-service hands him over), "is this address the
 * same human as Thomas" is human-service's. A writer address is used only when it is a REGISTERED address of a lead of
 * the brand OTHER than the thread's lead, so an alias of Thomas, our own mailbox, a no-reply robot or the brand's own
 * team (never a lead of its brand) writes nothing.
 */

export const PARTICIPANT_ROLES = ["from", "to", "cc", "bcc"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export interface MessageParticipant {
  email: string;
  role: ParticipantRole;
}

/** The id of the timeline row a reply's writer gets on their OWN lead: `<subject key>#writer:<lead id>`. */
export const WRITER_ROW_SEPARATOR = "#writer:";

export function writerRowId(subjectKey: string, leadId: string): string {
  return `${subjectKey}${WRITER_ROW_SEPARATOR}${leadId}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function address(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s.length > 0 && s.includes("@") ? s : null;
}

/**
 * Every address one outreach fact states, with its role. `participants` when the fact carries it (an unreadable entry
 * is skipped, never guessed); else a reply's `reply.fromEmail` as its `from`. Deduped per (address, role).
 */
export function participantsOf(raw: Record<string, unknown>): MessageParticipant[] {
  const out = new Map<string, MessageParticipant>();
  const add = (email: string | null, role: ParticipantRole) => {
    if (email) out.set(`${role}|${email}`, { email, role });
  };
  if (Array.isArray(raw.participants)) {
    for (const p of raw.participants) {
      const entry = obj(p);
      const role = entry?.role;
      if (typeof role === "string" && (PARTICIPANT_ROLES as readonly string[]).includes(role)) {
        add(address(entry?.email), role as ParticipantRole);
      }
    }
  } else {
    add(address(obj(raw.reply)?.fromEmail), "from");
  }
  return [...out.values()];
}

/** The mailboxes of ours a fact names (the sending account): never a person of the prospect's side. */
function ourMailboxes(raw: Record<string, unknown>): Set<string> {
  const mine = new Set<string>();
  for (const block of [obj(raw.send), obj(raw.replySent), obj(raw.reply)]) {
    const a = address(block?.accountEmail);
    if (a) mine.add(a);
  }
  return mine;
}

/**
 * Who WROTE a reply when it was not the thread's lead's own address: the `from` addresses other than `leadEmail` and
 * our own mailbox. Only a `reply` has a writer of theirs (our sends are written by us).
 */
export function otherWritersOf(type: string, raw: Record<string, unknown>, leadEmail: string): string[] {
  if (type !== "reply") return [];
  const lead = leadEmail.trim().toLowerCase();
  const mine = ourMailboxes(raw);
  return [...new Set(participantsOf(raw).filter((p) => p.role === "from").map((p) => p.email))]
    .filter((e) => e !== lead && !mine.has(e))
    .sort();
}

/** The thread key a fact states (RFC root Message-Id), or null. */
export function threadKeyOf(raw: Record<string, unknown>): string | null {
  return typeof raw.threadKey === "string" && raw.threadKey.length > 0 ? raw.threadKey : null;
}
