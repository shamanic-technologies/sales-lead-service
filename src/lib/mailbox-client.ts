/**
 * The exchange that lives in the CUSTOMER'S OWN mailbox — google-service's Gmail mirror.
 *
 * For some prospects this is the only copy of the conversation: a thread that moved off the
 * outreach sequence into a personal reply exists nowhere else, and nothing in this fleet read it
 * until now. google-service owns the mirror and derives the readable bodies; this client asks it
 * for one address and carries the answer through.
 *
 * `bodyStatus` is forwarded verbatim and never collapsed. "unavailable" (we hold the message and
 * could not read it) is NOT "empty" (it exists and says nothing) — the same distinction the whole
 * history read is built on.
 *
 * Identity: this read requires `x-user-id` and `x-run-id` as UUIDs. When the caller carries
 * neither, this source answers `{ ok: false }` with that reason — a stand-in identity is never
 * invented for it.
 */
import { GOOGLE_SERVICE_URL, GOOGLE_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { SourceRead } from "./outreach-client.js";

const TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MailboxContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

export interface MailboxMessage {
  gmailMessageId: string;
  threadId: string;
  direction: "inbound" | "outbound" | "other";
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: string | null;
  labels: string[];
  bodyText: string | null;
  bodyHtml: string | null;
  bodyStatus: "ok" | "empty" | "unavailable";
}

export interface MailboxThread {
  threadId: string;
  subject: string | null;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  messages: MailboxMessage[];
}

export interface MailboxConversation {
  address: string;
  status: "ok" | "partial" | "unreadable";
  threadCount: number;
  messageCount: number;
  truncated: boolean;
  threads: MailboxThread[];
}

/**
 * The whole exchange with one address out of the org's Gmail mirror, or null when the org has
 * connected no mailbox / the mirror holds nothing for that address. Both of those are 404s at the
 * producer and both mean "nothing here", not "unreadable" — which the producer signals inside a
 * 200 as `status: "unreadable" | "partial"` and this client forwards untouched.
 */
export async function fetchMailboxConversation(
  email: string,
  ctx: MailboxContext,
  limit = 200,
): Promise<SourceRead<MailboxConversation | null>> {
  if (!ctx.userId || !UUID_RE.test(ctx.userId) || !ctx.runId || !UUID_RE.test(ctx.runId)) {
    return {
      ok: false,
      reason:
        "google-service requires x-user-id and x-run-id as UUIDs; this request carried neither, and an identity is never invented for it",
    };
  }

  const headers: Record<string, string> = {
    "X-API-Key": GOOGLE_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  const url = `${GOOGLE_SERVICE_URL}/orgs/google/conversation?email=${encodeURIComponent(email)}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `google-service unreachable: ${(error as Error).message}` };
  }

  if (response.status === 404) return { ok: true, data: null };

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `google-service answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }

  try {
    const conversation = (await response.json()) as MailboxConversation;
    return {
      ok: true,
      data: {
        ...conversation,
        threads: Array.isArray(conversation.threads) ? conversation.threads : [],
      },
    };
  } catch (error) {
    return { ok: false, reason: `google-service payload unreadable: ${(error as Error).message}` };
  }
}

/**
 * Our STAFF's side of the exchange with one address, out of their own Gmail mirrors
 * (google-service `GET /internal/staff-mailboxes/conversation`). A staff member operating a brand
 * as the agency answers prospects by hand from their own mailbox, which lives under THEIR org, so
 * the org-scoped read above can never see it. google-service returns ONLY messages between a
 * staff address and this person — never the rest of a thread, never anything else of the mailbox.
 *
 * Both 404 reasons (no staff mailbox mirrored / no such exchange) mean "nothing here"; any other
 * failure is a stated `{ ok: false }`, never an empty answer.
 */
export async function fetchStaffMailboxConversation(
  email: string,
  ctx: MailboxContext,
  limit = 200,
): Promise<SourceRead<MailboxConversation | null>> {
  if (!ctx.userId || !UUID_RE.test(ctx.userId) || !ctx.runId || !UUID_RE.test(ctx.runId)) {
    return {
      ok: false,
      reason:
        "google-service requires x-user-id and x-run-id as UUIDs; this request carried neither, and an identity is never invented for it",
    };
  }

  const headers: Record<string, string> = {
    "X-API-Key": GOOGLE_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  const url = `${GOOGLE_SERVICE_URL}/internal/staff-mailboxes/conversation?email=${encodeURIComponent(email)}&limit=${limit}`;

  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, reason: `google-service unreachable: ${(error as Error).message}` };
  }

  if (response.status === 404) return { ok: true, data: null };

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `google-service answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }

  try {
    const conversation = (await response.json()) as MailboxConversation;
    return {
      ok: true,
      data: {
        ...conversation,
        threads: Array.isArray(conversation.threads) ? conversation.threads : [],
      },
    };
  } catch (error) {
    return { ok: false, reason: `google-service payload unreadable: ${(error as Error).message}` };
  }
}
