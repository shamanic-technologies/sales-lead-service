/**
 * Following human-service's identity events (owner 2026-10-13, LEAD-REFONTE-1013): "same human?" is
 * human-service's answer; this service follows it. Background thread, every `HUMAN_EVENTS_INTERVAL_MS`,
 * pages of 1000 from `GET /internal/human-identities/events` under cursor feed `human_events`
 * (`crm_feed_cursors`), page + cursor in ONE transaction (a failed page moves nothing).
 *
 * Only FLEET events (orgId null) are applied: a lead row is global (orgs share it), so an org's own
 * judgment merge cannot move it.
 *   - human.fact_stated / human.fact_withdrawn: copied into `human_fact_copies` (statedAt and source
 *     read from the human's view, once per fact). The standing reads a live opt_out / do_not_contact on
 *     the lead's human as an opt-out at EVERY company (lead-standing.ts, rung 2c).
 *   - human.linked (relation same, scope fleet): the merged human's members are read from human-service
 *     (`GET /internal/human-identities/{id}`, fleet view: canonical id + members) and written to
 *     `human_aliases`; every lead holding a member id moves to the canonical id. Two leads of the
 *     human at ONE company are then recorded in `lead_identity_duplicates` (oldest survives: new
 *     serves land on it); neither lead's rows, id or email change.
 *   - human.separated / human.link_withdrawn (fleet): logged, nothing auto-split (a lead keeps the id
 *     it holds; a person can split them by hand later).
 * Every other event type (created, keys_attached) needs nothing here.
 */
import { sql as dsql } from "drizzle-orm";
import { db, sql } from "../db/index.js";
import { getHuman, listHumanEvents, type HumanEvent } from "./human-identity-client.js";

export const HUMAN_EVENTS_FEED = "human_events";
export const HUMAN_EVENTS_INTERVAL_MS = 60_000;
const PAGE = 1000;
const FIRST_PULL_DELAY_MS = 100_000;

async function cursorOf(): Promise<string> {
  const rows = (await db.execute(dsql`SELECT cursor FROM crm_feed_cursors WHERE feed = ${HUMAN_EVENTS_FEED}`)) as unknown as Array<{
    cursor: string;
  }>;
  return rows[0]?.cursor ?? "0";
}

type Tx = typeof sql;

/** The members of a merged human and its fleet id, written as aliases; leads move to the canonical id. */
async function applyMerge(tx: Tx, event: HumanEvent): Promise<number> {
  const view = await getHuman(event.humanIds[0]);
  if (!view) throw new Error(`human-service does not know human ${event.humanIds[0]} named by event ${event.id}`);
  const members = Array.from(new Set([...view.memberHumanIds, ...event.humanIds]));
  await tx`
    INSERT INTO human_aliases (atomic_human_id, human_id, event_id)
    SELECT m, ${view.humanId}::uuid, ${event.id}::bigint FROM unnest(${members}::uuid[]) AS m
    ON CONFLICT (atomic_human_id) DO UPDATE SET human_id = excluded.human_id, event_id = excluded.event_id, updated_at = now()
  `;
  const moved = await tx`
    UPDATE leads SET human_id = ${view.humanId}::uuid
    WHERE human_id = ANY(${members}::uuid[]) AND human_id <> ${view.humanId}::uuid
    RETURNING id
  `;
  await recordDuplicates(tx, view.humanId, `fleet_merge:${event.id}`);
  return moved.length;
}

/** Leads of one human at one company beyond the oldest: recorded, oldest survives. */
export async function recordDuplicates(tx: Tx, humanId: string, reason: string): Promise<number> {
  const rows = await tx`
    WITH ranked AS (
      SELECT id, company_id,
        first_value(id) OVER (PARTITION BY company_id ORDER BY created_at, id) AS survivor
      FROM leads WHERE human_id = ${humanId}::uuid AND company_id IS NOT NULL
    )
    INSERT INTO lead_identity_duplicates (lead_id, survivor_lead_id, human_id, company_id, reason)
    SELECT id, survivor, ${humanId}::uuid, company_id, ${reason} FROM ranked WHERE id <> survivor
    ON CONFLICT (lead_id) DO UPDATE SET survivor_lead_id = excluded.survivor_lead_id, human_id = excluded.human_id
    RETURNING lead_id
  `;
  if (rows.length > 0) {
    console.log(`[lead-service] human events: human ${humanId} holds ${rows.length} duplicate lead(s) at one company (${reason})`);
  }
  return rows.length;
}

async function copyFact(tx: Tx, event: HumanEvent): Promise<void> {
  const d = event.data as { factId?: string; humanId?: string; kind?: string; statedByOrgId?: string | null };
  if (!d.factId || !d.humanId || !d.kind) throw new Error(`human event ${event.id} (fact_stated) carries no fact`);
  // statedAt and source live on the human's view; a fact already withdrawn again is not there.
  const view = await getHuman(d.humanId);
  const full = view?.facts.find((f) => f.factId === d.factId) ?? null;
  await tx`
    INSERT INTO human_fact_copies (fact_id, human_id, kind, stated_by_org_id, source, stated_at, event_id)
    VALUES (${d.factId}::uuid, ${d.humanId}::uuid, ${d.kind}, ${d.statedByOrgId ?? null}, ${full?.source ?? null},
      ${full?.statedAt ?? event.createdAt}::timestamptz, ${event.id}::bigint)
    ON CONFLICT (fact_id) DO NOTHING
  `;
}

async function applyEvent(tx: Tx, event: HumanEvent): Promise<void> {
  if (event.orgId !== null) return;
  switch (event.type) {
    case "human.fact_stated":
      await copyFact(tx, event);
      return;
    case "human.fact_withdrawn": {
      const d = event.data as { factId?: string };
      if (!d.factId) throw new Error(`human event ${event.id} (fact_withdrawn) names no fact`);
      await tx`UPDATE human_fact_copies SET withdrawn_at = ${event.createdAt}::timestamptz WHERE fact_id = ${d.factId}::uuid AND withdrawn_at IS NULL`;
      return;
    }
    case "human.linked": {
      const d = event.data as { relation?: string; scope?: string };
      if (d.relation === "same" && d.scope === "fleet") await applyMerge(tx, event);
      return;
    }
    case "human.separated":
    case "human.link_withdrawn":
      console.warn(
        `[lead-service] human events: ${event.type} ${event.humanIds.join(",")} (event ${event.id}); leads keep the human they hold, nothing split`,
      );
      return;
    default:
      return;
  }
}

/** One page: events applied and the cursor moved in ONE transaction. Returns whether more is waiting. */
export async function pullHumanEventsOnce(): Promise<{ applied: number; hasMore: boolean }> {
  const after = await cursorOf();
  const page = await listHumanEvents(after, PAGE);
  await sql.begin(async (txn) => {
    const tx = txn as unknown as Tx;
    for (const e of page.events) await applyEvent(tx, e);
    await tx`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at, updated_at)
      VALUES (${HUMAN_EVENTS_FEED}, ${page.nextCursor}, ${page.hasMore ? null : new Date().toISOString()}::timestamptz, now())
      ON CONFLICT (feed) DO UPDATE SET cursor = excluded.cursor,
        caught_up_at = COALESCE(excluded.caught_up_at, crm_feed_cursors.caught_up_at), updated_at = now()
    `;
  });
  return { applied: page.events.length, hasMore: page.hasMore };
}

let pulling = false;

export function startHumanEventsWorker(): void {
  const tick = async () => {
    if (pulling) return;
    pulling = true;
    try {
      for (;;) {
        const r = await pullHumanEventsOnce();
        if (!r.hasMore) break;
      }
    } catch (err) {
      console.error("[lead-service] human events pull failed (cursor unchanged, retried next tick):", err);
    } finally {
      pulling = false;
    }
  };
  setTimeout(() => void tick(), FIRST_PULL_DELAY_MS).unref();
  setInterval(() => void tick(), HUMAN_EVENTS_INTERVAL_MS).unref();
}
