import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL } from "../config.js";
import { db } from "../db/index.js";
import { triggerEventOutbox } from "../db/schema.js";
import { fetchCampaign } from "./campaign-client.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * EVERY ASK FOR A LEAD IS RECORDED AT campaign-service AS A `lead_requested` TRIGGER EVENT
 * (owner 2026-10-09: every leg is PROACTIVE or REACTIVE; the sourcing channels are REACTIVE on
 * `lead_requested`, and that ask is this service's serve, performed in-process).
 *
 * One serve (`POST /orgs/buffer/next`, one caller `x-run-id`) = one event, posted to campaign-service
 * `POST /internal/trigger-events` as ALREADY PERFORMED (nothing is dispatched there):
 *   - a lead found  -> `{outcome: "ran", campaignId}` = the campaign the serve RUN was filed under: the
 *                      ON source campaign of the audience's origin (source-campaign.ts), else the
 *                      outreach campaign (an offer whose sources are not campaigns yet).
 *   - nothing found -> `{outcome: "skipped", reason}` = the serve's own empty reason (serve-reasons.ts).
 * `requestedByCampaignId` is the outreach campaign that asked, `leadId` the lead served.
 *
 * Rules:
 *   1. Recording NEVER blocks, slows or fails a serve: the route calls `recordLeadRequested` without
 *      awaiting it, and nothing it does can throw into the route.
 *   2. Exactly once: the idempotency key is the caller's run (`lead_requested:<x-run-id>`), so our
 *      own redelivery and the caller's retry both replay the first event at campaign-service. A
 *      retry answered from the serve's idempotency cache is not a new ask and records nothing. A
 *      serve that 500s records nothing (the caller's retry under the same run is the ask).
 *   3. Every serve ends up recorded: a delivery that fails (campaign-service down, route not deployed
 *      yet) is kept in `trigger_event_outbox` and redelivered by the background thread with backoff.
 *      A 400 is a refusal no retry fixes: the row is kept with `refused_at` + the answer, never
 *      dropped. The table IS the visible count of unrecorded asks; every miss is logged loud.
 *   4. `offerId` (required by campaign-service) is the source campaign's offer when the serve had one,
 *      else read from the outreach campaign at delivery time, off the serve path. A campaign stating
 *      no offer cannot be recorded: refused with that reason, visible in the outbox.
 */

export const LEAD_REQUESTED_TRIGGER_ID = "lead_requested" as const;

const CALL_TIMEOUT_MS = 10_000;
export const OUTBOX_DRAIN_INTERVAL_MS = 60_000;
const OUTBOX_FIRST_DRAIN_DELAY_MS = 60_000;
const OUTBOX_BATCH_SIZE = 100;
const MAX_BACKOFF_MS = 60 * 60_000;

export type LeadRequestedPerformed =
  | { outcome: "ran"; campaignId: string }
  | { outcome: "skipped"; reason: string; detail?: string };

/** The event as this service knows it at the serve; `offerId` may still be unknown. */
export interface LeadRequestedEvent {
  orgId: string;
  brandId: string;
  /** The offer when the serve already knew it (a source campaign's), else null: read at delivery. */
  offerId: string | null;
  /** The outreach campaign that asked (`x-campaign-id`). */
  requestedByCampaignId: string;
  /** The caller's run (`x-run-id`): one ask. */
  callerRunId: string;
  leadId: string | null;
  occurredAt: string;
  performed: LeadRequestedPerformed;
}

export function leadRequestedIdempotencyKey(callerRunId: string): string {
  return `${LEAD_REQUESTED_TRIGGER_ID}:${callerRunId}`;
}

/** A delivery answer: delivered, worth retrying, or refused for good. */
type DeliveryResult = { kind: "delivered" } | { kind: "retry"; error: string } | { kind: "refused"; error: string };

async function resolveOfferId(event: LeadRequestedEvent): Promise<string | null> {
  if (event.offerId) return event.offerId;
  const campaign = await fetchCampaign(event.requestedByCampaignId, event.orgId);
  return campaign?.offerId ?? null;
}

/** One attempt to record the event at campaign-service. Never throws. */
export async function deliverLeadRequested(event: LeadRequestedEvent): Promise<DeliveryResult> {
  let offerId: string | null;
  try {
    offerId = await resolveOfferId(event);
  } catch (err) {
    return { kind: "retry", error: `offer read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!offerId) {
    return { kind: "refused", error: `campaign ${event.requestedByCampaignId} states no offer: an event needs one` };
  }

  const body = {
    triggerId: LEAD_REQUESTED_TRIGGER_ID,
    brandId: event.brandId,
    offerId,
    ...(event.leadId ? { leadId: event.leadId } : {}),
    requestedByCampaignId: event.requestedByCampaignId,
    idempotencyKey: leadRequestedIdempotencyKey(event.callerRunId),
    occurredAt: event.occurredAt,
    performed: event.performed,
  };
  try {
    const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/internal/trigger-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": event.orgId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.ok) return { kind: "delivered" };
    const text = (await response.text()).slice(0, 500);
    // 400 = campaign-service read the event and refused it (unknown trigger, unknown campaign, shape):
    // resending the same bytes cannot succeed. Anything else (404 before the route deploys, 401, 5xx,
    // 502 catalogue_unavailable) can.
    if (response.status === 400) return { kind: "refused", error: `400 ${text}` };
    return { kind: "retry", error: `${response.status} ${text}` };
  } catch (err) {
    return { kind: "retry", error: err instanceof Error ? err.message : String(err) };
  }
}

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

function describe(event: LeadRequestedEvent): string {
  const what = event.performed.outcome === "ran" ? `ran campaign=${event.performed.campaignId}` : `skipped reason=${event.performed.reason}`;
  return `org=${event.orgId} brand=${event.brandId} outreach=${event.requestedByCampaignId} run=${event.callerRunId} ${what}`;
}

async function keepInOutbox(event: LeadRequestedEvent, result: Exclude<DeliveryResult, { kind: "delivered" }>): Promise<void> {
  const now = new Date();
  await db
    .insert(triggerEventOutbox)
    .values({
      idempotencyKey: leadRequestedIdempotencyKey(event.callerRunId),
      orgId: event.orgId,
      event,
      attempts: 1,
      lastError: result.error,
      nextAttemptAt: new Date(now.getTime() + backoffMs(1)),
      refusedAt: result.kind === "refused" ? now : null,
    })
    .onConflictDoNothing();
}

/**
 * Record one serve's `lead_requested` event. Called WITHOUT await from the serve route; never throws,
 * never rejects. A failed delivery lands in the outbox; a failed outbox write is logged loud.
 */
export function recordLeadRequested(event: LeadRequestedEvent): void {
  void (async () => {
    const result = await deliverLeadRequested(event);
    if (result.kind === "delivered") return;
    console.error(
      `[lead-service] lead_requested event NOT recorded (${result.kind}), kept in trigger_event_outbox: ${describe(event)}: ${result.error}`,
    );
    await keepInOutbox(event, result);
  })().catch((err) => {
    console.error(`[lead-service] lead_requested event LOST (outbox write failed): ${describe(event)}:`, err);
  });
}

let draining = false;

/** Redeliver every due outbox row once. Returns what it did (tests, logs). */
export async function drainTriggerEventOutbox(): Promise<{ delivered: number; retried: number; refused: number }> {
  const counts = { delivered: 0, retried: 0, refused: 0 };
  if (draining) return counts;
  draining = true;
  try {
    const due = await db
      .select()
      .from(triggerEventOutbox)
      .where(and(isNull(triggerEventOutbox.refusedAt), lte(triggerEventOutbox.nextAttemptAt, sql`now()`)))
      .orderBy(asc(triggerEventOutbox.nextAttemptAt))
      .limit(OUTBOX_BATCH_SIZE);
    for (const row of due) {
      const event = row.event as LeadRequestedEvent;
      const result = await deliverLeadRequested(event);
      if (result.kind === "delivered") {
        await db.delete(triggerEventOutbox).where(eq(triggerEventOutbox.idempotencyKey, row.idempotencyKey));
        counts.delivered++;
        continue;
      }
      const attempts = row.attempts + 1;
      const now = new Date();
      await db
        .update(triggerEventOutbox)
        .set({
          attempts,
          lastError: result.error,
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
          refusedAt: result.kind === "refused" ? now : null,
        })
        .where(eq(triggerEventOutbox.idempotencyKey, row.idempotencyKey));
      if (result.kind === "refused") counts.refused++;
      else counts.retried++;
      console.error(
        `[lead-service] lead_requested redelivery ${result.kind} (attempt ${attempts}): ${describe(event)}: ${result.error}`,
      );
    }
    if (due.length > 0) {
      console.log(
        `[lead-service] trigger_event_outbox drained: delivered=${counts.delivered} retried=${counts.retried} refused=${counts.refused}`,
      );
    }
    return counts;
  } finally {
    draining = false;
  }
}

/** Background thread: redeliver unrecorded asks, first pass a minute after boot. */
export function startTriggerEventOutboxWorker(): void {
  const tick = () => {
    drainTriggerEventOutbox().catch((err) => console.error("[lead-service] trigger_event_outbox drain failed:", err));
  };
  setTimeout(tick, OUTBOX_FIRST_DRAIN_DELAY_MS).unref();
  setInterval(tick, OUTBOX_DRAIN_INTERVAL_MS).unref();
}
