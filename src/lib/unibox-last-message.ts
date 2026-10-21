/**
 * The LAST message of a Unibox row's thread, ours or theirs (UNIBOX-LAST-MESSAGE-PREVIEW-1021, owner 2026-10-21:
 * scan the Unibox like Gmail). The thread is crm-service's: `POST /internal/people/relations/latest-messages`
 * (crm-service v0.83.0) answers the latest message of each relation, every channel it merges. Here we only pick the
 * latest over the relations folded into one row and cut its text into one line (`unibox-preview.ts`).
 *
 * Unknown = null WITH a reason, never an empty line that reads as "no message": `no_message` (every thread read,
 * nothing in it), `source_unreadable` (a thread crm-service could not read yet), `relation_unknown` (crm-service does
 * not know the relation), `no_relation` (the row names none), `no_text` (a message with no readable words: the
 * message is still served, its `preview` null).
 *
 * crm-service's store lags its sources (2026-10-21: a cold email sent 05:08 was indexed 05:46), so a row is asked
 * again while its activity is recent (`needsAsking`) and left alone once settled; a failed read keeps what is stored.
 */
import { CRM_SERVICE_API_KEY, CRM_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { messagePreview } from "./unibox-preview.js";

export const LATEST_MESSAGES_BATCH = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Ask again while the row moved within this long before the last check (the store's lag). */
export const RECHECK_AFTER_ACTIVITY_MS = 2 * 60 * 60_000;
/** A settled row is still asked again this often (a message nothing of ours observed). */
export const RECHECK_SETTLED_MS = 6 * 60 * 60_000;
/** A row crm-service could not answer (thread unreadable, relation unknown) is asked again this often. */
export const RECHECK_UNANSWERED_MS = 30 * 60_000;

export interface CrmLatestMessage {
  at: string | null;
  source: string;
  channel: string;
  direction: "inbound" | "outbound" | "other";
  sentBy: "person" | "automation" | null;
  subject: string | null;
  text: string | null;
  textBasis: string | null;
  textTruncated: boolean;
  from: string | null;
}

export interface CrmRelationLatest {
  relationKey: string;
  status: "message" | "no_message" | "unreadable" | "unknown";
  reason: string | null;
  message: CrmLatestMessage | null;
}

export type UniboxLastMessageReason = "no_message" | "source_unreadable" | "relation_unknown" | "no_relation" | "no_text";

/** What a Unibox row serves: the first words of its last message, who wrote it, by which channel, when. */
export interface UniboxLastMessage {
  at: string | null;
  /** theirs = the person wrote; ours = the brand did (a person of ours or one of our machines); null = neither said. */
  side: "theirs" | "ours" | null;
  /** On our side: person = typed by a human of the brand, automation = one of our machines, null = the source does not say. */
  sentBy: "person" | "automation" | null;
  channel: string;
  source: string;
  subject: string | null;
  /** The first words, one line, quoted history and signature dropped when recognizable; null = no readable words. */
  preview: string | null;
}

export interface UniboxLastMessageAnswer {
  lastMessage: UniboxLastMessage | null;
  reason: UniboxLastMessageReason | null;
}

export class LatestMessagesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LatestMessagesUnavailableError";
  }
}

/** crm-service's latest message of each relation (batched); any failure throws, never "no message". */
export async function fetchLatestMessages(orgId: string, brandId: string, relationKeys: readonly string[]): Promise<Map<string, CrmRelationLatest>> {
  const out = new Map<string, CrmRelationLatest>();
  const keys = Array.from(new Set(relationKeys));
  for (let i = 0; i < keys.length; i += LATEST_MESSAGES_BATCH) {
    const path = "/internal/people/relations/latest-messages";
    let response: Response;
    try {
      response = await fetchWithRetry(`${CRM_SERVICE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": CRM_SERVICE_API_KEY },
        body: JSON.stringify({ orgId, brandId, relationKeys: keys.slice(i, i + LATEST_MESSAGES_BATCH) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LatestMessagesUnavailableError(`crm-service unreachable for ${path}: ${(err as Error).message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LatestMessagesUnavailableError(`crm-service ${response.status} for ${path}: ${body.slice(0, 300)}`);
    }
    const body = (await response.json()) as { relations?: CrmRelationLatest[] };
    if (!Array.isArray(body.relations)) throw new LatestMessagesUnavailableError(`crm-service ${path}: no relations[] in the answer`);
    for (const r of body.relations) out.set(r.relationKey, r);
  }
  for (const k of keys) if (!out.has(k)) throw new LatestMessagesUnavailableError(`crm-service latest-messages did not answer relation ${k}`);
  return out;
}

const time = (at: string | null) => (at === null ? -Infinity : Date.parse(at));

/** The row's answer over its folded relations: the latest message of any, else the strongest reason none is known. */
export function lastMessageOfRow(relationKeys: readonly string[], answers: ReadonlyMap<string, CrmRelationLatest>): UniboxLastMessageAnswer {
  if (relationKeys.length === 0) return { lastMessage: null, reason: "no_relation" };
  const got = relationKeys.map((k) => answers.get(k)).filter((a): a is CrmRelationLatest => a !== undefined);
  const latest = got
    .filter((a) => a.status === "message" && a.message !== null)
    .map((a) => a.message!)
    .sort((a, b) => time(b.at) - time(a.at))[0];
  if (!latest) {
    // A thread nobody could read is not an empty thread; an unknown relation is neither.
    const reason: UniboxLastMessageReason = got.some((a) => a.status === "unreadable")
      ? "source_unreadable"
      : got.some((a) => a.status === "no_message")
        ? "no_message"
        : "relation_unknown";
    return { lastMessage: null, reason };
  }
  const preview = messagePreview(latest.text) ?? messagePreview(latest.subject);
  return {
    lastMessage: {
      at: latest.at,
      side: latest.direction === "inbound" ? "theirs" : latest.direction === "outbound" ? "ours" : null,
      sentBy: latest.direction === "outbound" ? latest.sentBy : null,
      channel: latest.channel,
      source: latest.source,
      subject: latest.subject,
      preview,
    },
    reason: preview === null ? "no_text" : null,
  };
}

/** Ask crm-service again? Never asked, not settled (a reason that can change), or the row moved recently / long ago. */
export function needsAsking(stored: { checkedAt: string | null; reason: string | null } | undefined, lastActivityAt: string, now: number): boolean {
  if (!stored || stored.checkedAt === null) return true;
  const checked = Date.parse(stored.checkedAt);
  if (now - checked >= RECHECK_SETTLED_MS) return true;
  if ((stored.reason === "source_unreadable" || stored.reason === "relation_unknown") && now - checked >= RECHECK_UNANSWERED_MS) return true;
  return checked < Date.parse(lastActivityAt) + RECHECK_AFTER_ACTIVITY_MS;
}
