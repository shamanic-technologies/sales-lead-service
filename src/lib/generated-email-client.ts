/**
 * The copy we PRODUCED for one person on one campaign, and the follow-up cadence it planned —
 * content-generation-service's `GET /generations/by-lead/:leadId`.
 *
 * This is the outbound half of a history that the delivery layer can only date: the delivery
 * evidence says an email was sent, this says WHAT it said and what the sequence intended to send
 * next. Reading it campaign-scoped is what makes it exact — a person contacted by several
 * campaigns of one brand holds one generation per campaign.
 *
 * Nothing about the cadence is interpreted here. `sequence` is forwarded as the producer stores
 * it; whether a follow-up is still owed is a question this service answers from its OWN follow-up
 * state, never from a plan written before anybody replied.
 */
import {
  CONTENT_GENERATION_SERVICE_URL,
  CONTENT_GENERATION_SERVICE_API_KEY,
} from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { SourceRead } from "./outreach-client.js";

const TIMEOUT_MS = 15_000;

export interface GeneratedEmailContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
}

export interface GeneratedEmail {
  id: string;
  campaignId: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  /** The planned sequence, verbatim from the producer. Shape is the producer's, not ours. */
  sequence: unknown;
  model: string | null;
  /** The workflow run that generated this sequence (initial + follow-ups): the producer's
   * `runId`, the run the generation was requested under. Null when the producer served none. */
  runId: string | null;
  promptType: string | null;
  createdAt: string | null;
}

/**
 * The generation for one (lead, campaign), or null when that campaign never wrote to this person.
 * A 404 is that absence — not a failure — and is reported as such.
 */
export async function fetchGeneratedEmail(
  leadId: string,
  campaignId: string,
  ctx: GeneratedEmailContext,
): Promise<SourceRead<GeneratedEmail | null>> {
  if (!ctx.userId || !ctx.runId) {
    return {
      ok: false,
      reason:
        "content-generation-service requires x-user-id and x-run-id; this request carried neither, and an identity is never invented for it",
    };
  }

  const headers: Record<string, string> = {
    "X-API-Key": CONTENT_GENERATION_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  const url =
    `${CONTENT_GENERATION_SERVICE_URL}/generations/by-lead/${encodeURIComponent(leadId)}` +
    `?campaignId=${encodeURIComponent(campaignId)}` +
    (ctx.brandId ? `&brandId=${encodeURIComponent(ctx.brandId)}` : "");

  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `content-generation-service unreachable: ${(error as Error).message}`,
    };
  }

  if (response.status === 404) return { ok: true, data: null };

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `content-generation-service answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    };
  }

  try {
    const generation = (await response.json() as { generation?: Record<string, unknown> }).generation;
    if (!generation) return { ok: true, data: null };
    return {
      ok: true,
      data: {
        id: String(generation.id ?? ""),
        campaignId: (generation.campaignId as string | null) ?? null,
        subject: (generation.subject as string | null) ?? null,
        bodyText: (generation.bodyText as string | null) ?? null,
        bodyHtml: (generation.bodyHtml as string | null) ?? null,
        sequence: generation.sequence ?? null,
        model: (generation.model as string | null) ?? null,
        runId:
          typeof generation.runId === "string" && generation.runId.length > 0
            ? generation.runId
            : null,
        promptType: (generation.promptType as string | null) ?? null,
        createdAt: generation.createdAt ? String(generation.createdAt) : null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `content-generation-service payload unreadable: ${(error as Error).message}`,
    };
  }
}
