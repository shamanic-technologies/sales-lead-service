/**
 * What the NON-EMAIL sender (crm-service: WhatsApp today) states it sent to a person, for the paid-pool retry.
 *
 * WA-RESERVE-LOOP-1014: the pool asked email-gateway alone "was this person contacted?". A WhatsApp send never
 * reaches email-gateway, so every person a WhatsApp campaign wrote to read "never contacted" and was handed back as
 * soon as the claim lease lapsed (campaign 4af21454, 2026-10-12/13: 8 people written once each, re-served 16-18 times
 * each). For a pipe whose channel does not write by email, the answer comes from the service that PERFORMED the send:
 * crm-service keeps every send with its campaign id, status and sentAt. Read, never reconstructed here.
 *
 * crm-service serves the record one person at a time (`GET /orgs/whatsapp/messages?brandId=&email=`), so a bounded
 * batch is asked with bounded concurrency. FAIL LOUD: any failure throws `ChannelSendsUnavailableError`, and the pool
 * treats that as "no evidence" (fail-closed: nobody is re-served on a guess).
 */
import { CRM_SERVICE_API_KEY, CRM_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

const REQUEST_TIMEOUT_MS = 10_000;
/** Per-person reads in flight at once: each one is a crm-service request + its run. */
export const CHANNEL_SEND_READ_CONCURRENCY = 4;

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

/** Every send the brand's non-email sender holds for ONE person (any campaign), as it states them. */
export async function fetchChannelSends(
  brandId: string,
  email: string,
  ctx: ChannelSendContext,
): Promise<ChannelSend[]> {
  const path = `/orgs/whatsapp/messages?brandId=${encodeURIComponent(brandId)}&email=${encodeURIComponent(email)}`;
  let response: Response;
  try {
    response = await fetchWithRetry(`${CRM_SERVICE_URL}${path}`, {
      method: "GET",
      headers: headersFor(ctx, brandId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ChannelSendsUnavailableError(`crm-service unreachable for ${path}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ChannelSendsUnavailableError(`crm-service ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
  let body: { sends?: unknown };
  try {
    body = (await response.json()) as { sends?: unknown };
  } catch (error) {
    throw new ChannelSendsUnavailableError(`crm-service answer for ${path} was not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(body.sends)) {
    throw new ChannelSendsUnavailableError(`crm-service answer for ${path} carries no sends array`);
  }
  return body.sends.map(readSend);
}

/**
 * The sends of a bounded batch of people, keyed by lowercased email. One failure fails the whole batch (the pool
 * then re-serves nobody this pull rather than deciding on half the evidence).
 */
export async function fetchChannelSendsBatch(
  brandId: string,
  emails: readonly string[],
  ctx: ChannelSendContext,
): Promise<Map<string, ChannelSend[]>> {
  const out = new Map<string, ChannelSend[]>();
  const queue = [...new Set(emails.map((e) => e.toLowerCase()))];
  async function worker(): Promise<void> {
    for (let email = queue.shift(); email !== undefined; email = queue.shift()) {
      out.set(email, await fetchChannelSends(brandId, email, ctx));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHANNEL_SEND_READ_CONCURRENCY, queue.length) }, worker));
  return out;
}
