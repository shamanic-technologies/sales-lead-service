/**
 * What the OUTREACH provider holds about one person: the messages exchanged with them, the reply
 * statements a human recorded about them, and the opt-outs a human recorded for them.
 *
 * All three live in instantly-service, which owns them; none of them is re-derived here. The
 * messages are read from that service's own mirror of the provider's mailbox — the copy that
 * survives the provider's plan being cancelled — so this client never talks to the provider and
 * nothing here breaks when the subscription ends.
 *
 * NOTHING THROWS FOR A TRANSPORT FAILURE. A source that cannot answer returns
 * `{ ok: false, reason }` and the history read states it as unreachable, because "we could not
 * read this" and "this did not happen" are different facts and collapsing them would tell a
 * customer their prospect said nothing. A source failing must not take the whole answer down.
 */
import { errorMessage } from "./db-error.js";
import { INSTANTLY_SERVICE_URL, INSTANTLY_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

const TIMEOUT_MS = 15_000;

export interface OutreachContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

export type SourceRead<T> =
  | { ok: true; data: T }
  /** `notAsked`: there was nothing to ask this source about (a lead with no registered email), never an outage. */
  | { ok: false; reason: string; notAsked?: true };

/** One message of a conversation, exactly as instantly-service serves it. */
export interface OutreachMessage {
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  at: string;
  subject: string;
  text: string;
}

export interface OutreachConversation {
  campaignId: string;
  leadEmail: string;
  accountEmail: string | null;
  transport: "instantly" | "smtp";
  /** Which copy answered — `mirror` is the one that outlives the provider's plan. Optional: the
   * deployed contract adds it, and an older payload simply omits it. */
  source?: "mirror" | "self_send" | "provider" | null;
  messageCount: number;
  messages: OutreachMessage[];
}

export interface OutreachReplyStatement {
  id: string;
  campaignId: string;
  email: string;
  replyKind: string;
  status: string;
  qualifiedBy: string;
  notes: string | null;
  qualifiedAt: string;
  withdrawnAt: string | null;
}

export interface OutreachOptOut {
  id: string;
  email: string;
  channel: string;
  statedBy: string;
  notes: string | null;
  statedAt: string;
  withdrawnAt: string | null;
}

function headersFor(ctx: OutreachContext): Record<string, string> {
  const headers: Record<string, string> = {
    "X-API-Key": INSTANTLY_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;
  return headers;
}

async function get<T>(
  path: string,
  ctx: OutreachContext,
  /** Statuses that mean "there is nothing here", as opposed to "we could not read it". */
  emptyStatuses: number[],
  empty: T,
  parse: (body: unknown) => T,
): Promise<SourceRead<T>> {
  let response: Response;
  try {
    response = await fetchWithRetry(`${INSTANTLY_SERVICE_URL}${path}`, {
      method: "GET",
      headers: headersFor(ctx),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `instantly-service unreachable: ${errorMessage(error)}` };
  }

  if (emptyStatuses.includes(response.status)) return { ok: true, data: empty };

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `instantly-service answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }

  try {
    return { ok: true, data: parse(await response.json()) };
  } catch (error) {
    return { ok: false, reason: `instantly-service payload unreadable: ${errorMessage(error)}` };
  }
}

/**
 * The messages exchanged with one person on one campaign.
 *
 * The three answers instantly-service keeps apart are kept apart here too: a sequence this org
 * has no record of (404) is NOT a failure — nothing was exchanged there and the campaign simply
 * is not one of theirs — while a thread it holds and cannot read (502) is, and is reported as
 * such rather than as an empty conversation.
 */
export async function fetchOutreachConversation(
  campaignId: string,
  email: string,
  ctx: OutreachContext,
): Promise<SourceRead<OutreachConversation | null>> {
  const qs = `campaign_id=${encodeURIComponent(campaignId)}&email=${encodeURIComponent(email)}`;
  return get<OutreachConversation | null>(
    `/orgs/conversations?${qs}`,
    ctx,
    [404],
    null,
    (body) => {
      const conversation = (body as { conversation?: OutreachConversation }).conversation ?? null;
      if (!conversation) return null;
      return {
        ...conversation,
        messages: Array.isArray(conversation.messages) ? conversation.messages : [],
      };
    },
  );
}

/** The reply statements a human recorded for this person — optionally on one campaign. */
export async function fetchOutreachReplyStatements(
  email: string,
  ctx: OutreachContext,
): Promise<SourceRead<OutreachReplyStatement[]>> {
  const qs = `email=${encodeURIComponent(email)}&limit=500`;
  return get<OutreachReplyStatement[]>(
    `/orgs/manual-qualifications?${qs}`,
    ctx,
    [],
    [],
    (body) => {
      const rows = (body as { qualifications?: OutreachReplyStatement[] }).qualifications;
      return Array.isArray(rows) ? rows : [];
    },
  );
}

/** The opt-outs a human recorded for this person. Withdrawn records are part of the audit and are
 * returned by the producer; the history read drops them, exactly as every other read here drops a
 * withdrawn statement. */
export async function fetchOutreachOptOuts(
  email: string,
  ctx: OutreachContext,
): Promise<SourceRead<OutreachOptOut[]>> {
  const qs = `email=${encodeURIComponent(email)}&limit=500`;
  return get<OutreachOptOut[]>(`/orgs/opt-outs?${qs}`, ctx, [], [], (body) => {
    const rows = (body as { optOuts?: OutreachOptOut[] }).optOuts;
    return Array.isArray(rows) ? rows : [];
  });
}
