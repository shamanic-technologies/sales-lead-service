/**
 * trigger_event_outbox against a REAL database (src/lib/lead-requested-events.ts): a lead_requested
 * event campaign-service could not record is kept once per ask, redelivered when due, deleted once
 * recorded; a refusal stays, never redelivered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { triggerEventOutbox } = await import("../../src/db/schema.js");
const { recordLeadRequested, drainTriggerEventOutbox, leadRequestedIdempotencyKey } = await import(
  "../../src/lib/lead-requested-events.js"
);

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

function event(runId: string) {
  return {
    orgId: randomUUID(),
    brandId: randomUUID(),
    offerId: randomUUID(),
    requestedByCampaignId: randomUUID(),
    callerRunId: runId,
    leadId: null,
    occurredAt: new Date().toISOString(),
    performed: { outcome: "skipped" as const, reason: "audience_exhausted" },
  };
}

async function rowFor(runId: string) {
  const [row] = await db
    .select()
    .from(triggerEventOutbox)
    .where(eq(triggerEventOutbox.idempotencyKey, leadRequestedIdempotencyKey(runId)));
  return row;
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

describe.skipIf(!hasRealDatabase)("trigger_event_outbox against a real database", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an undelivered event once, redelivers it when due, deletes it once recorded", async () => {
    const runId = randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    recordLeadRequested(event(runId));
    recordLeadRequested(event(runId)); // the same ask twice: one row
    const kept = await until(() => rowFor(runId));
    expect(kept).toMatchObject({ attempts: 1, refusedAt: null });
    await new Promise((r) => setTimeout(r, 50));
    const all = await db.select().from(triggerEventOutbox).where(eq(triggerEventOutbox.idempotencyKey, leadRequestedIdempotencyKey(runId)));
    expect(all).toHaveLength(1);

    await db.update(triggerEventOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(triggerEventOutbox.idempotencyKey, leadRequestedIdempotencyKey(runId)));
    const fetchOk = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchOk);
    const counts = await drainTriggerEventOutbox();
    expect(counts.delivered).toBeGreaterThanOrEqual(1);
    expect(await rowFor(runId)).toBeUndefined();
  });

  it("a refused event stays with refused_at and is never redelivered", async () => {
    const runId = randomUUID();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reason: "unknown_trigger" }), { status: 400 })));
    recordLeadRequested(event(runId));
    const kept = await until(() => rowFor(runId));
    expect(kept?.refusedAt).toBeInstanceOf(Date);

    await db.update(triggerEventOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(triggerEventOutbox.idempotencyKey, leadRequestedIdempotencyKey(runId)));
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    await drainTriggerEventOutbox();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rowFor(runId)).toBeDefined();
  });
});
