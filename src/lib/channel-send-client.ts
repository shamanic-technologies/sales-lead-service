/**
 * What the NON-EMAIL sender (crm-service: WhatsApp today) states it sent to a person, for the paid-pool retry.
 *
 * WA-RESERVE-LOOP-1014: the pool asked email-gateway alone "was this person contacted?". A WhatsApp send never
 * reaches email-gateway, so every person a WhatsApp campaign wrote to read "never contacted" and was handed back as
 * soon as the claim lease lapsed (campaign 4af21454, 2026-10-12/13: 8 people written once each, re-served 16-18 times
 * each). For a pipe whose channel does not write by email, the answer comes from the service that PERFORMED the send:
 * crm-service keeps every send with its campaign id, status and sentAt. Read, never reconstructed here.
 *
 * WA-SENDS-BATCH-1014: ONE call per pull, `POST /orgs/whatsapp/sends/query {brandId, campaignId, emails}` (this
 * campaign's sends to the listed people, any status, newest first; a person with none is absent). The per-person
 * `GET /orgs/whatsapp/messages` it replaces cost one request and one crm-service run per person.
 *
 * FAIL LOUD: any failure throws `ChannelSendsUnavailableError`, and the pool treats that as "no evidence"
 * (fail-closed: nobody is re-served on a guess). An entry crm-service names in `invalidEmails` is a person it cannot
 * match; the per-person read answered such an email with a 400, which failed the whole pull, so it still does
 * (named in the error, never read as "nothing sent").
 */
import { CRM_SERVICE_API_KEY, CRM_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { isCrmMatchableEmail, keepAccepted } from "./receiver-email-format.js";

const REQUEST_TIMEOUT_MS = 10_000;
/** crm-service's own cap on `emails` per query. */
export const CHANNEL_SENDS_QUERY_MAX_EMAILS = 500;

export class ChannelSendsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelSendsUnavailableError";
  }
}

/** One send as crm-service states it (only the fields the pool reads). */
export interface ChannelSend {
  sendId: string;
  /** `sending` | `sent` | `refused` | `failed`: the sender's own word. */
  status: string;
  campaignId: string | null;
  sentAt: string | null;
  createdAt: string | null;
}

export interface ChannelSendContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
}

function headersFor(ctx: ChannelSendContext, brandId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-API-Key": CRM_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "x-brand-id": brandId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;
  return headers;
}

function readSend(raw: unknown): ChannelSend {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.sendId !== "string" || typeof r.status !== "string") {
    throw new ChannelSendsUnavailableError(`crm-service send record unreadable: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return {
    sendId: r.sendId,
    status: r.status,
    campaignId: typeof r.campaignId === "string" ? r.campaignId : null,
    sentAt: typeof r.sentAt === "string" ? r.sentAt : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
  };
}

/** The key a person is matched on, as crm-service normalises it (trimmed, lower-cased). */
export function channelSendKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Every send THIS campaign's non-email sender holds for each listed person, keyed by `channelSendKey(email)`; a person
 * with none is absent from the map. One call. Any failure, including a person crm-service cannot match, throws.
 */
export async function fetchChannelSendsBatch(
  brandId: string,
  campaignId: string,
  emails: readonly string[],
  ctx: ChannelSendContext,
  leadOf?: ReadonlyMap<string, string>,
): Promise<Map<string, ChannelSend[]>> {
  const out = new Map<string, ChannelSend[]>();
  // An address crm-service cannot match is named in `invalidEmails`, which fails the whole pull: it is
  // dropped here, logged with its lead, and has no send (crm-service stores sends under a matchable
  // address only) — LEAD-CHANGES-INVALID-EMAIL-1016.
  const unique = keepAccepted(
    [...new Set(emails.map(channelSendKey))],
    isCrmMatchableEmail,
    `crm-service /orgs/whatsapp/sends/query (campaign ${campaignId})`,
    leadOf,
  );
  if (unique.length === 0) return out;
  if (unique.length > CHANNEL_SENDS_QUERY_MAX_EMAILS) {
    throw new ChannelSendsUnavailableError(
      `crm-service sends query takes at most ${CHANNEL_SENDS_QUERY_MAX_EMAILS} emails, asked ${unique.length}`,
    );
  }
  const path = "/orgs/whatsapp/sends/query";
  const what = `${path} campaign=${campaignId} emails=${unique.length}`;
  let response: Response;
  try {
    response = await fetchWithRetry(`${CRM_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { ...headersFor(ctx, brandId), "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, campaignId, emails: unique }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ChannelSendsUnavailableError(`crm-service unreachable for ${what}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ChannelSendsUnavailableError(`crm-service ${response.status} for ${what}: ${body.slice(0, 300)}`);
  }
  let body: { sends?: unknown; invalidEmails?: unknown };
  try {
    body = (await response.json()) as { sends?: unknown; invalidEmails?: unknown };
  } catch (error) {
    throw new ChannelSendsUnavailableError(`crm-service answer for ${what} was not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(body.sends) || !Array.isArray(body.invalidEmails)) {
    throw new ChannelSendsUnavailableError(`crm-service answer for ${what} carries no sends/invalidEmails arrays`);
  }
  if (body.invalidEmails.length > 0) {
    throw new ChannelSendsUnavailableError(
      `crm-service cannot match ${body.invalidEmails.length} email(s) for ${what}: ${JSON.stringify(body.invalidEmails).slice(0, 300)}`,
    );
  }
  for (const raw of body.sends) {
    const email = (raw as Record<string, unknown> | null)?.email;
    if (typeof email !== "string") {
      throw new ChannelSendsUnavailableError(`crm-service send record names no email: ${JSON.stringify(raw)?.slice(0, 200)}`);
    }
    const key = channelSendKey(email);
    const list = out.get(key) ?? [];
    list.push(readSend(raw));
    out.set(key, list);
  }
  return out;
}
