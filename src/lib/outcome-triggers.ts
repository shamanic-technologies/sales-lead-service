/**
 * EVERY OUTCOME A PERSON REACHES FIRES ITS OUTCOME TRIGGER (EVERY-OUTCOME-FIRES-1015, owner 2026-10-15: "Every
 * outcome reached fires its trigger, no exception"). The rules are `outcome-trigger-rules.ts`; this is the IO.
 *
 * A client running a reactive campaign: "the moment one of my people reaches an outcome you already know about,
 * start my campaigns that wait on it". campaign-service owns the one door that records a trigger event and fires
 * the live campaigns on it (`POST /internal/trigger-events`); this service rings it for every outcome it is the
 * record of, ONCE per person (lead x brand x offer) and outcome.
 *
 * Where a reach is read (one place each, never a second writer):
 *   - `lead_found`: a serve that FOUND a person (`recordServed`, buffer.ts) — `noteLeadFound`, called without
 *     await: it never blocks, slows or fails the serve.
 *   - the background sweep (`sweepOutcomeTriggers`, every 30s):
 *       * crm-service's fact copy (`crm_facts`, cursor on `seq`): signup, website visit, meetings, payment that
 *         stands, sale — the same fact types step-reached.ts reads for campaign-service's delay detector;
 *       * the outcome ledger (`conversion_events`: tracker, a person's statement, a reply), never the `crm`
 *         rows (the fact copy above IS their record);
 *       * the follow-up ledger: an `acted` row of an AI Instant Call campaign = a booking call (booking-calls.ts).
 *   - EVERY OTHER ACT OF THEIRS on the fact copy (a refused payment, a product / onboarding event: a crm fact of
 *     theirs reaching no step, outcome-trigger-rules.ts `isTheirNewAct`) rings the generic `account_event` (a Lead
 *     event member), ONCE PER FACT (step `act:<type>`), a burst of one kind coalesced (LEAD-EVENT-REFUSAL-NO-REACT-1028).
 *   The sweep is ARMED once (`outcome_trigger_sweep`): what happened before it never fires (no back-fill).
 *
 * Every reach is one `outcome_trigger_fires` row per offer (migration 0094) BEFORE anything is sent:
 *   - ONCE: a person already holding a live fire (pending / delivered / refused) for (brand, offer, outcome) is
 *     recorded `already_fired`, nothing sent; the idempotency key makes campaign-service answer a replay of
 *     ours with its first event.
 *   - The trigger is read off features-service's catalogue at delivery (`outcomeKey`); an outcome another
 *     service fires (Positive reply, Form submitted) is `skipped` `fired_by_another_service`, never sent.
 *   - ONE fire per person whoever rings: an event of the trigger another caller already recorded for the person
 *     (a client pushing the same fact through the public door) is `skipped` `already_recorded`, never sent.
 *   - A delivery that fails (campaign-service down, catalogue unreadable) stays `pending` and is retried with
 *     backoff, logged loud each time; a 400 is `refused`, kept, never resent. Nothing is ever swallowed.
 */
import { errorMessage } from "./db-error.js";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  BRAND_SERVICE_API_KEY,
  BRAND_SERVICE_URL,
  CAMPAIGN_SERVICE_API_KEY,
  CAMPAIGN_SERVICE_URL,
  FEATURES_SERVICE_URL,
} from "../config.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { BOOKING_CALL_LEG_KEY } from "./booking-calls.js";
import { fetchOrgCampaignFacts } from "./campaign-leg-client.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { rowReaches } from "./step-reached.js";
import { HELD_GRACE_MS, MEETING_HELD_STEP, heldMeetingSourceRef } from "./meeting-held.js";
import { readHeldMeetings } from "./meeting-held-read.js";
import {
  BOOKING_CALL_STEP,
  CRM_FACT_REACH_TYPES,
  LEAD_FOUND_STEP,
  LEDGER_REACH_EVENTS,
  canonicalEmails,
  eventPerson,
  freshSince,
  isFreshReach,
  outcomeIdempotencyKey,
  outcomeTriggerFor,
  parseOutcomeTriggers,
  personKeyOf,
  pickOffers,
  stepOfCrmFact,
  LEDGER_ANY_SOURCE_EVENTS,
  LEDGER_SOURCE_BOUND_STEPS,
  ledgerSourceRef,
  stepsOfLedgerRow,
  RESTATED_ACTION,
  UNANSWERED_SKIPS,
  actionAlreadyAnswered,
  ACCOUNT_EVENT_TRIGGER,
  ACT_COALESCE_WINDOW_MS,
  COALESCED,
  actIdempotencyKey,
  actItem,
  actStep,
  isActStep,
  isTheirNewAct,
  type CatalogueOutcomeTrigger,
} from "./outcome-trigger-rules.js";
import { CRM_NOT_THEIR_ACT } from "./crm-act-types.js";

const CATALOGUE_TTL_MS = 5 * 60_000;
const CATALOGUE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;
export const OUTCOME_SWEEP_INTERVAL_MS = 30_000;
const FIRST_SWEEP_DELAY_MS = 60_000;
const CRM_FACT_BATCH = 1000;
const CRM_FACT_BATCHES_PER_TICK = 5;
const LEDGER_BATCH = 500;
/** Acts are read again this far behind the cursor: an act committed late is still seen (rows dedupe). */
const ACTS_OVERLAP_MS = 2 * 60_000;
const DRAIN_BATCH = 100;
/** A row the writer delivers itself is left alone by the drain this long (it would only replay it). */
const WRITER_DELIVERY_LEASE_MS = 2 * 60_000;
const DRAIN_LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const SWEEP_ID = "outcome-triggers";

// ── features-service's catalogue ─────────────────────────────────────────────────────────────

let catalogueCache: { at: number; triggers: CatalogueOutcomeTrigger[] } | null = null;

/** Test hook: forget the cached catalogue. */
export function resetOutcomeTriggerCatalogue(): void {
  catalogueCache = null;
}

/** The outcome triggers features-service serves. THROWS when the catalogue cannot be read. */
async function loadOutcomeTriggers(): Promise<CatalogueOutcomeTrigger[]> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.triggers;
  const response = await fetchWithRetry(`${FEATURES_SERVICE_URL}/public/channels`, {
    signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`features-service /public/channels failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const triggers = parseOutcomeTriggers(await response.json());
  catalogueCache = { at: Date.now(), triggers };
  return triggers;
}

// ── who and which offer ──────────────────────────────────────────────────────────────────────

/** One outcome a person reached, as the record states it. */
export interface OutcomeReach {
  orgId: string;
  brandId: string;
  /** features-service's outcome (step) key. */
  step: string;
  /** What recorded it: serve | tracker | manual | reply | crm_fact | acted. */
  source: string;
  /** The record it was read off (one row per record and offer). */
  sourceRef: string;
  /** ISO instant of the reach. */
  occurredAt: string | null;
  leadId: string | null;
  /** The record's own addresses, canonical, its own first. */
  emails: string[];
  name: string | null;
  phone: string | null;
  /** The offer the record states (the serve's campaign...), when it knows it. */
  statedOfferId: string | null;
  /** The campaign the record names (a statement's), read for its offer when none is stated. */
  statedCampaignId: string | null;
  /** An act's item for the workflow (`act:<type>` steps only). */
  item?: Record<string, unknown> | null;
}

/** Reads shared by every reach of one pass: one campaign read per org, one offer read per brand (and trigger). */
interface Lookups {
  orgCampaigns(orgId: string): Promise<Map<string, { legKey: string | null; offerId: string | null }>>;
  activeBrandOffers(orgId: string, brandId: string): Promise<string[]>;
  liveTriggerOffers(orgId: string, brandId: string, triggerId: string): Promise<string[]>;
}

function createLookups(): Lookups {
  const campaigns = new Map<string, Promise<Map<string, { legKey: string | null; offerId: string | null }>>>();
  const offers = new Map<string, Promise<string[]>>();
  const live = new Map<string, Promise<string[]>>();
  return {
    orgCampaigns(orgId) {
      let p = campaigns.get(orgId);
      if (!p) {
        p = fetchOrgCampaignFacts({ orgId });
        campaigns.set(orgId, p);
        p.catch(() => campaigns.delete(orgId));
      }
      return p;
    },
    activeBrandOffers(orgId, brandId) {
      const key = `${orgId}|${brandId}`;
      let p = offers.get(key);
      if (!p) {
        p = fetchActiveBrandOffers(orgId, brandId);
        offers.set(key, p);
        p.catch(() => offers.delete(key));
      }
      return p;
    },
    liveTriggerOffers(orgId, brandId, triggerId) {
      const key = `${orgId}|${brandId}|${triggerId}`;
      let p = live.get(key);
      if (!p) {
        p = fetchLiveTriggerOffers(orgId, brandId, triggerId);
        live.set(key, p);
        p.catch(() => live.delete(key));
      }
      return p;
    },
  };
}

/**
 * campaign-service's offers of the brand whose ONGOING campaign answers the trigger, directly or through a trigger
 * made of it (`lead_event`): `GET /internal/brands/{id}/trigger-offers` (OFFER-FROM-LIVE-CAMPAIGNS-1024). Asked only
 * for a person in no campaign. THROWS when it cannot answer (the reach is retried, never fired on a guess).
 */
export async function fetchLiveTriggerOffers(orgId: string, brandId: string, triggerId: string): Promise<string[]> {
  const url = `${CAMPAIGN_SERVICE_URL}/internal/brands/${encodeURIComponent(brandId)}/trigger-offers?triggerId=${encodeURIComponent(triggerId)}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`campaign-service trigger-offers of brand ${brandId} (${triggerId}) failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { offerIds?: unknown };
  if (!Array.isArray(body.offerIds) || body.offerIds.some((o) => typeof o !== "string")) {
    throw new Error(`campaign-service trigger-offers of brand ${brandId} answered without an offerIds array`);
  }
  return body.offerIds as string[];
}

/** brand-service's ACTIVE offers of the brand. THROWS when it cannot answer. */
export async function fetchActiveBrandOffers(orgId: string, brandId: string): Promise<string[]> {
  const response = await fetchWithRetry(`${BRAND_SERVICE_URL}/internal/brands/${encodeURIComponent(brandId)}/offers`, {
    headers: { "x-api-key": BRAND_SERVICE_API_KEY, "x-org-id": orgId },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`brand-service /internal/brands/${brandId}/offers failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { offers?: Array<{ offerId?: unknown; status?: unknown }> };
  if (!Array.isArray(body.offers)) throw new Error(`brand-service offers of brand ${brandId} answered without an offers array`);
  return body.offers
    .filter((o) => o?.status === "active" && typeof o.offerId === "string")
    .map((o) => o.offerId as string);
}

/** The lead of (org, brand) owning one of the addresses, the record's own first; null = not a lead. */
export async function leadOwningEmails(orgId: string, brandId: string, emails: string[]): Promise<string | null> {
  if (emails.length === 0) return null;
  const rows = (await db.execute(sql`
    SELECT cm.lead_id::text AS lead_id, lower(cm.value) AS email
    FROM lead_contact_methods cm
    WHERE cm.channel = 'email'
      AND lower(cm.value) = ANY(${sql.param(emails)}::text[])
      AND EXISTS (
        SELECT 1 FROM leads_campaigns lc
        WHERE lc.lead_id = cm.lead_id AND lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids)
      )
  `)) as unknown as Array<{ lead_id: string; email: string }>;
  for (const email of emails) {
    const hit = rows.find((r) => r.email === email);
    if (hit) return hit.lead_id;
  }
  return null;
}

async function registeredEmails(leadId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT lower(value) AS email FROM lead_contact_methods
    WHERE lead_id = ${leadId} AND channel = 'email'
    ORDER BY created_at, value
  `)) as unknown as Array<{ email: string }>;
  return rows.map((r) => r.email);
}

async function registeredPhone(leadId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT value FROM lead_contact_methods
    WHERE lead_id = ${leadId} AND channel = 'phone'
    ORDER BY created_at, value
    LIMIT 1
  `)) as unknown as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

async function campaignsOfLead(orgId: string, brandId: string, leadId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT campaign_id FROM leads_campaigns
    WHERE lead_id = ${leadId} AND org_id = ${orgId} AND ${brandId} = ANY(brand_ids)
  `)) as unknown as Array<{ campaign_id: string }>;
  return rows.map((r) => r.campaign_id);
}

interface ResolvedReach extends OutcomeReach {
  email: string | null;
  personKey: string;
  offers: ReturnType<typeof pickOffers>;
}

/** Who the reach is about and which offer(s). null = nobody to name (no lead, no address). THROWS on a failed read. */
async function resolveReach(reach: OutcomeReach, lookups: Lookups): Promise<ResolvedReach | null> {
  const leadId = reach.leadId ?? (await leadOwningEmails(reach.orgId, reach.brandId, reach.emails));
  const emails = canonicalEmails([...reach.emails, ...(leadId ? await registeredEmails(leadId) : [])]);
  const email = emails[0] ?? null;
  const personKey = personKeyOf(leadId, email);
  if (!personKey) return null;
  // A lead with no address is named by its phone (a WhatsApp writer): campaign-service files them by E.164.
  const phone = reach.phone ?? (!email && leadId ? await registeredPhone(leadId) : null);

  let stated = reach.statedOfferId;
  if (!stated && reach.statedCampaignId) {
    stated = (await lookups.orgCampaigns(reach.orgId)).get(reach.statedCampaignId)?.offerId ?? null;
  }
  let leadCampaignOffers: (string | null)[] = [];
  if (!stated && leadId) {
    const campaigns = await lookups.orgCampaigns(reach.orgId);
    leadCampaignOffers = (await campaignsOfLead(reach.orgId, reach.brandId, leadId)).map((id) => campaigns.get(id)?.offerId ?? null);
  }
  const needsBrand = !stated && !leadCampaignOffers.some((o) => o !== null);
  // A person in no campaign (an inbound visitor): the offers whose live campaign answers the trigger this reach fires.
  const triggerId = !needsBrand
    ? null
    : isActStep(reach.step)
      ? ACCOUNT_EVENT_TRIGGER
      : ((v) => (v.fire ? v.triggerId : null))(outcomeTriggerFor(reach.step, await loadOutcomeTriggers()));
  const liveTriggerOffers = triggerId ? await lookups.liveTriggerOffers(reach.orgId, reach.brandId, triggerId) : null;
  const activeBrandOffers = needsBrand ? await lookups.activeBrandOffers(reach.orgId, reach.brandId) : null;
  return { ...reach, leadId, email, phone, personKey, offers: pickOffers({ stated, leadCampaignOffers, liveTriggerOffers, activeBrandOffers }) };
}

// ── the ledger ───────────────────────────────────────────────────────────────────────────────

/**
 * Write one row per offer of the reach. Returns the ids of the rows written `pending` (to deliver now). A person
 * already holding a live fire is written `already_fired`; a record already seen writes nothing.
 */
async function writeReach(r: ResolvedReach): Promise<string[]> {
  const base = sql`
    ${r.sourceRef}, ${r.orgId}, ${r.brandId}`;
  const person = sql`
    ${r.step}, ${r.personKey}, ${r.leadId}::uuid, ${r.email}, ${r.name}, ${r.phone}, ${r.occurredAt}::timestamptz, ${r.source}`;
  if (r.offers.offerIds.length === 0) {
    const reason = "reason" in r.offers ? r.offers.reason : "offer_unknown";
    const detail = "detail" in r.offers ? r.offers.detail : null;
    await db.execute(sql`
      INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, email, name, phone, occurred_at, source, item, status, skip_reason, last_error)
      VALUES (${base}, '', ${person}, ${r.item ? JSON.stringify(r.item) : null}::jsonb, 'skipped', ${reason}, ${detail})
      ON CONFLICT DO NOTHING
    `);
    console.warn(`[lead-service] outcome ${r.step} NOT fired (${reason}): org=${r.orgId} brand=${r.brandId} ${r.personKey} ${r.sourceRef}: ${detail}`);
    return [];
  }
  const pending: string[] = [];
  if (isActStep(r.step)) {
    for (const offerId of r.offers.offerIds) {
      // ONCE per fact; a burst of the same act for the same person is one occurrence (outcome-trigger-rules.ts).
      const inserted = (await db.execute(sql`
        INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, email, name, phone, occurred_at, source, item, status, next_attempt_at)
        SELECT ${base}, ${offerId}, ${person}, ${r.item ? JSON.stringify(r.item) : null}::jsonb, 'pending', now() + ${`${WRITER_DELIVERY_LEASE_MS} milliseconds`}::interval
        WHERE NOT EXISTS (
          SELECT 1 FROM outcome_trigger_fires o
          WHERE o.org_id = ${r.orgId} AND o.brand_id = ${r.brandId} AND o.offer_id = ${offerId} AND o.step = ${r.step}
            AND o.person_key = ${r.personKey} AND o.status IN ('pending', 'delivered')
            AND o.occurred_at >= ${r.occurredAt}::timestamptz - ${`${ACT_COALESCE_WINDOW_MS} milliseconds`}::interval
            AND o.occurred_at <= ${r.occurredAt}::timestamptz
        )
        ON CONFLICT DO NOTHING
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      if (inserted.length > 0) {
        pending.push(inserted[0].id);
        continue;
      }
      // Either this fact was already read, or it falls inside a live occurrence of the same act: kept as seen.
      await db.execute(sql`
        INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, email, name, phone, occurred_at, source, item, status, skip_reason)
        VALUES (${base}, ${offerId}, ${person}, ${r.item ? JSON.stringify(r.item) : null}::jsonb, 'skipped', ${COALESCED})
        ON CONFLICT DO NOTHING
      `);
    }
    return pending;
  }
  for (const offerId of r.offers.offerIds) {
    const inserted = (await db.execute(sql`
      INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, email, name, phone, occurred_at, source, status, next_attempt_at)
      VALUES (${base}, ${offerId}, ${person}, 'pending', now() + ${`${WRITER_DELIVERY_LEASE_MS} milliseconds`}::interval)
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    if (inserted.length > 0) {
      pending.push(inserted[0].id);
      continue;
    }
    // Either this record was already read (nothing to add), or the person already holds a live fire: kept as seen.
    await db.execute(sql`
      INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, email, name, phone, occurred_at, source, status)
      VALUES (${base}, ${offerId}, ${person}, 'already_fired')
      ON CONFLICT DO NOTHING
    `);
  }
  return pending;
}

/** Resolve + write one reach. THROWS on a failed read or write (the caller decides how loud). */
export async function recordOutcomeReach(reach: OutcomeReach, lookups: Lookups = createLookups()): Promise<string[]> {
  const resolved = await resolveReach(reach, lookups);
  if (!resolved) {
    await db.execute(sql`
      INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, occurred_at, source, item, status, skip_reason)
      VALUES (${reach.sourceRef}, ${reach.orgId}, ${reach.brandId}, '', ${reach.step}, '', ${reach.occurredAt}::timestamptz, ${reach.source}, ${reach.item ? JSON.stringify(reach.item) : null}::jsonb, 'skipped', 'no_person')
      ON CONFLICT DO NOTHING
    `);
    return [];
  }
  return writeReach(resolved);
}

/**
 * A reach whose person or offer cannot be read (a sibling down) is retried on every pass; one that still cannot
 * be read after this long is set aside `unresolvable` with the error, loudly, so it never holds the sweep forever.
 */
const UNRESOLVABLE_AFTER_MS = 30 * 60_000;
const firstFailureAt = new Map<string, number>();

/** `recordOutcomeReach` for the sweep: THROWS while a failure is young (retried), sets the reach aside once old. */
async function recordSwept(reach: OutcomeReach, lookups: Lookups, now: Date): Promise<string[]> {
  try {
    const ids = await recordOutcomeReach(reach, lookups);
    firstFailureAt.delete(reach.sourceRef);
    return ids;
  } catch (err) {
    const first = firstFailureAt.get(reach.sourceRef) ?? now.getTime();
    firstFailureAt.set(reach.sourceRef, first);
    if (now.getTime() - first < UNRESOLVABLE_AFTER_MS) throw err;
    firstFailureAt.delete(reach.sourceRef);
    const message = (errorMessage(err)).slice(0, 500);
    console.error(
      `[lead-service] outcome ${reach.step} unresolvable for ${UNRESOLVABLE_AFTER_MS / 60_000} min, set aside (NOT fired): org=${reach.orgId} brand=${reach.brandId} ${reach.sourceRef}: ${message}`,
    );
    await db.execute(sql`
      INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, occurred_at, source, item, status, skip_reason, last_error)
      VALUES (${reach.sourceRef}, ${reach.orgId}, ${reach.brandId}, '', ${reach.step}, '', ${reach.leadId}::uuid, ${reach.occurredAt}::timestamptz, ${reach.source}, ${reach.item ? JSON.stringify(reach.item) : null}::jsonb, 'skipped', 'unresolvable', ${message})
      ON CONFLICT DO NOTHING
    `);
    return [];
  }
}

// ── delivery ─────────────────────────────────────────────────────────────────────────────────

interface FireRow {
  id: string;
  source_ref: string;
  org_id: string;
  brand_id: string;
  offer_id: string;
  step: string;
  person_key: string;
  lead_id: string | null;
  email: string | null;
  name: string | null;
  phone: string | null;
  occurred_at: RawTimestamp;
  attempts: number;
  item: Record<string, unknown> | null;
}

export type DeliveryResult = "delivered" | "skipped" | "refused" | "retry";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

function describe(row: FireRow): string {
  return `org=${row.org_id} brand=${row.brand_id} offer=${row.offer_id} step=${row.step} ${row.person_key}`;
}

async function settle(row: FireRow, set: ReturnType<typeof sql>): Promise<void> {
  await db.execute(sql`UPDATE outcome_trigger_fires SET ${set} WHERE id = ${row.id}::uuid AND status = 'pending'`);
}

async function keepForRetry(row: FireRow, error: string): Promise<DeliveryResult> {
  const attempts = row.attempts + 1;
  console.error(`[lead-service] outcome trigger NOT delivered (attempt ${attempts}), retried: ${describe(row)}: ${error}`);
  await settle(
    row,
    sql`attempts = ${attempts}, last_error = ${error.slice(0, 500)}, next_attempt_at = now() + ${`${backoffMs(attempts)} milliseconds`}::interval`,
  );
  return "retry";
}

/** A row whose person already has an event of the trigger at campaign-service, recorded by another caller. */
export const ALREADY_RECORDED = "already_recorded";

type PriorDoorEvent = { eventId: string; recordedVia: string | null; idempotencyKey: string | null } | null;

/**
 * The first event of the trigger about the person on the offer at campaign-service, any door or caller
 * (`GET /internal/offers/{offerId}/trigger-events/for-person`), or null. THROWS when it cannot answer.
 */
async function priorDoorEvent(
  row: FireRow,
  triggerId: string,
  person: { email?: string; phone?: string } | null,
): Promise<PriorDoorEvent> {
  const query = new URLSearchParams({ brandId: row.brand_id, triggerId });
  if (row.lead_id) query.set("leadId", row.lead_id);
  if (person?.email) query.set("email", person.email);
  if (person?.phone) query.set("phone", person.phone);
  if (!row.lead_id && !person?.email && !person?.phone) return null;
  const response = await fetchWithRetry(
    `${CAMPAIGN_SERVICE_URL}/internal/offers/${encodeURIComponent(row.offer_id)}/trigger-events/for-person?${query}`,
    {
      headers: { "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": row.org_id },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`campaign-service trigger-events/for-person failed: ${response.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { event?: { id?: unknown; recordedVia?: unknown } | null; idempotencyKey?: unknown };
  if (body.event === undefined) throw new Error(`campaign-service trigger-events/for-person answered without an event field: ${text.slice(0, 300)}`);
  if (body.event === null) return null;
  if (typeof body.event.id !== "string") throw new Error(`campaign-service trigger-events/for-person event without an id: ${text.slice(0, 300)}`);
  return {
    eventId: body.event.id,
    recordedVia: typeof body.event.recordedVia === "string" ? body.event.recordedVia : null,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
  };
}

/** One attempt to ring campaign-service's door for one pending row. Never throws. */
export async function deliverOutcomeFire(row: FireRow, now: Date = new Date()): Promise<DeliveryResult> {
  try {
    if (isActStep(row.step)) return await deliverAct(row, now);
    let triggers: CatalogueOutcomeTrigger[];
    try {
      triggers = await loadOutcomeTriggers();
    } catch (err) {
      return await keepForRetry(row, `catalogue unreadable: ${errorMessage(err)}`);
    }
    const verdict = outcomeTriggerFor(row.step, triggers);
    if (!verdict.fire) {
      console.log(`[lead-service] outcome ${row.step} not fired here (${verdict.reason}: ${verdict.detail}): ${describe(row)}`);
      await settle(row, sql`status = 'skipped', skip_reason = ${verdict.reason}, trigger_id = ${verdict.triggerId}, last_error = ${verdict.detail}`);
      return "skipped";
    }

    const occurredAt = toIsoTimestamp(row.occurred_at);
    const person = eventPerson(row.email, row.name, row.phone);
    const idempotencyKey = outcomeIdempotencyKey({ step: row.step, brandId: row.brand_id, offerId: row.offer_id, personKey: row.person_key, hash: sha256 });

    // ONE fire per person, whoever rings: an occurrence of this trigger another caller already recorded for the
    // person (a client pushing the same fact through the public door) is that fire. Ours (same key) is replayed.
    let prior: PriorDoorEvent;
    try {
      prior = await priorDoorEvent(row, verdict.triggerId, person);
    } catch (err) {
      return await keepForRetry(row, `prior occurrence unreadable: ${errorMessage(err)}`);
    }
    if (prior && prior.idempotencyKey !== idempotencyKey) {
      const detail = `already recorded at campaign-service (event ${prior.eventId}, ${prior.recordedVia})`;
      console.log(`[lead-service] outcome trigger ${verdict.triggerId} not fired again (${ALREADY_RECORDED}: ${detail}): ${describe(row)}`);
      await settle(
        row,
        sql`status = 'skipped', skip_reason = ${ALREADY_RECORDED}, trigger_id = ${verdict.triggerId}, campaign_event_id = ${prior.eventId}, last_error = ${detail}`,
      );
      return "skipped";
    }

    const body = {
      triggerId: verdict.triggerId,
      brandId: row.brand_id,
      offerId: row.offer_id,
      idempotencyKey,
      // A reach dated ahead of now is due now: campaign-service would otherwise hold it as a planned event.
      ...(occurredAt ? { occurredAt: new Date(Math.min(Date.parse(occurredAt), now.getTime())).toISOString() } : {}),
      ...(row.lead_id ? { leadId: row.lead_id } : {}),
      ...(person ? { person } : {}),
    };
    let response: Response;
    try {
      response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/internal/trigger-events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": row.org_id },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      return await keepForRetry(row, errorMessage(err));
    }
    const text = await response.text();
    if (response.ok) {
      let eventId: string | null = null;
      try {
        const parsed = JSON.parse(text) as { event?: { id?: unknown } };
        eventId = typeof parsed.event?.id === "string" ? parsed.event.id : null;
      } catch {
        // Recorded (2xx); the id is only kept for the reader.
      }
      await settle(
        row,
        sql`status = 'delivered', trigger_id = ${verdict.triggerId}, campaign_event_id = ${eventId}, delivered_at = now(), attempts = ${row.attempts + 1}, last_error = NULL`,
      );
      console.log(`[lead-service] outcome trigger ${verdict.triggerId} recorded at campaign-service (event ${eventId}): ${describe(row)}`);
      return "delivered";
    }
    // 400 = campaign-service read it and refused it (unknown trigger, shape): the same bytes cannot succeed.
    if (response.status === 400) {
      console.error(`[lead-service] outcome trigger ${verdict.triggerId} REFUSED by campaign-service, kept: ${describe(row)}: ${text.slice(0, 300)}`);
      await settle(
        row,
        sql`status = 'refused', trigger_id = ${verdict.triggerId}, attempts = ${row.attempts + 1}, last_error = ${`400 ${text}`.slice(0, 500)}`,
      );
      return "refused";
    }
    return await keepForRetry(row, `${response.status} ${text.slice(0, 300)}`);
  } catch (err) {
    console.error(`[lead-service] outcome trigger delivery failed (row stays pending): ${describe(row)}:`, err);
    return "retry";
  }
}

/**
 * One act of theirs (`act:<type>`) rung as `account_event`: once per FACT (its own idempotency key), so neither the
 * once-per-person nor the for-person read of an outcome applies (a second refused payment is a new act). The trigger
 * is campaign-service's to know: an unknown one is a 400, kept `refused`.
 */
async function deliverAct(row: FireRow, now: Date): Promise<DeliveryResult> {
  const occurredAt = toIsoTimestamp(row.occurred_at);
  const person = eventPerson(row.email, row.name, row.phone);
  const body = {
    triggerId: ACCOUNT_EVENT_TRIGGER,
    brandId: row.brand_id,
    offerId: row.offer_id,
    idempotencyKey: actIdempotencyKey(row.source_ref, row.offer_id),
    ...(occurredAt ? { occurredAt: new Date(Math.min(Date.parse(occurredAt), now.getTime())).toISOString() } : {}),
    ...(row.lead_id ? { leadId: row.lead_id } : {}),
    ...(person ? { person } : {}),
    ...(row.item ? { item: row.item } : {}),
  };
  let response: Response;
  try {
    response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/internal/trigger-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": row.org_id },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    return await keepForRetry(row, errorMessage(err));
  }
  const text = await response.text();
  if (response.ok) {
    let eventId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { event?: { id?: unknown } };
      eventId = typeof parsed.event?.id === "string" ? parsed.event.id : null;
    } catch {
      // Recorded (2xx); the id is only kept for the reader.
    }
    await settle(
      row,
      sql`status = 'delivered', trigger_id = ${ACCOUNT_EVENT_TRIGGER}, campaign_event_id = ${eventId}, delivered_at = now(), attempts = ${row.attempts + 1}, last_error = NULL`,
    );
    console.log(`[lead-service] act ${row.step} rung as ${ACCOUNT_EVENT_TRIGGER} at campaign-service (event ${eventId}): ${describe(row)} ${row.source_ref}`);
    return "delivered";
  }
  if (response.status === 400) {
    console.error(`[lead-service] act ${row.step} REFUSED by campaign-service, kept: ${describe(row)}: ${text.slice(0, 300)}`);
    await settle(row, sql`status = 'refused', trigger_id = ${ACCOUNT_EVENT_TRIGGER}, attempts = ${row.attempts + 1}, last_error = ${`400 ${text}`.slice(0, 500)}`);
    return "refused";
  }
  return await keepForRetry(row, `${response.status} ${text.slice(0, 300)}`);
}

async function deliverIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = (await db.execute(sql`
    SELECT id::text AS id, source_ref, org_id, brand_id, offer_id, step, person_key, lead_id::text AS lead_id, email, name, phone, occurred_at, attempts, item
    FROM outcome_trigger_fires WHERE id = ANY(${sql.param(ids)}::uuid[]) AND status = 'pending'
  `)) as unknown as FireRow[];
  for (const row of rows) await deliverOutcomeFire(row);
}

/** Redeliver every due pending row once (claimed with a lease, so two threads never take the same row). */
/**
 * Narrows a pass to some orgs. Only the integration suite states it (its files share one database and run in
 * parallel: an unscoped pass read another file's rows and moved its counts). Absent = every org, always in prod.
 */
export interface OutcomeSweepScope {
  orgIds: readonly string[];
}

function inScope(column: ReturnType<typeof sql>, scope: OutcomeSweepScope | null): ReturnType<typeof sql> {
  return scope ? sql`AND ${column} = ANY(${sql.param([...scope.orgIds])}::text[])` : sql``;
}

export async function drainOutcomeTriggerFires(scope: OutcomeSweepScope | null = null): Promise<Record<DeliveryResult, number>> {
  const counts: Record<DeliveryResult, number> = { delivered: 0, skipped: 0, refused: 0, retry: 0 };
  const due = (await db.execute(sql`
    UPDATE outcome_trigger_fires SET next_attempt_at = now() + ${`${DRAIN_LEASE_MS} milliseconds`}::interval
    WHERE id IN (
      SELECT id FROM outcome_trigger_fires
      WHERE status = 'pending' AND next_attempt_at <= now() ${inScope(sql`org_id`, scope)}
      ORDER BY next_attempt_at
      LIMIT ${DRAIN_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text AS id, source_ref, org_id, brand_id, offer_id, step, person_key, lead_id::text AS lead_id, email, name, phone, occurred_at, attempts, item
  `)) as unknown as FireRow[];
  for (const row of due) counts[await deliverOutcomeFire(row)]++;
  return counts;
}

// ── lead_found: the serve's own reach ────────────────────────────────────────────────────────

/**
 * A serve FOUND a person for (brand, offer): ring `lead_found`. Called WITHOUT await from `recordServed`; never
 * throws, never rejects. A failure before the row is written is logged loud (the find itself is recorded).
 */
export function noteLeadFound(input: {
  orgId: string;
  brandId: string;
  leadId: string;
  email: string;
  /** The serve's campaign (source unit or outreach). */
  campaignId: string;
  /** The offer that campaign sells, when the serve already read it. */
  offerId: string | null;
}): void {
  void (async () => {
    const ids = await recordOutcomeReach({
      orgId: input.orgId,
      brandId: input.brandId,
      step: LEAD_FOUND_STEP,
      source: "serve",
      sourceRef: `serve:${input.campaignId}:${input.leadId}`,
      occurredAt: new Date().toISOString(),
      leadId: input.leadId,
      emails: canonicalEmails([input.email]),
      name: null,
      phone: null,
      statedOfferId: input.offerId,
      statedCampaignId: input.campaignId,
    });
    await deliverIds(ids);
  })().catch((err) => {
    console.error(
      `[lead-service] lead_found NOT recorded for its trigger: org=${input.orgId} brand=${input.brandId} lead=${input.leadId} campaign=${input.campaignId}:`,
      err,
    );
  });
}

// ── the sweep: the CRM copy, the outcome ledger, the follow-up ledger ────────────────────────

interface SweepState {
  armedAt: Date;
  crmFactSeq: string;
  actsCreatedAt: Date;
}

async function armedState(): Promise<SweepState> {
  // Armed ONCE: everything recorded before this instant never fires (no back-fill).
  await db.execute(sql`
    INSERT INTO outcome_trigger_sweep (id, armed_at, crm_fact_seq, acts_created_at)
    VALUES (${SWEEP_ID}, now(), COALESCE((SELECT max(seq) FROM crm_facts), 0), now())
    ON CONFLICT (id) DO NOTHING
  `);
  const [row] = (await db.execute(sql`
    SELECT armed_at, crm_fact_seq::text AS crm_fact_seq, acts_created_at FROM outcome_trigger_sweep WHERE id = ${SWEEP_ID}
  `)) as unknown as Array<{ armed_at: RawTimestamp; crm_fact_seq: string; acts_created_at: RawTimestamp }>;
  return {
    armedAt: new Date(toIsoTimestamp(row.armed_at)!),
    crmFactSeq: row.crm_fact_seq,
    actsCreatedAt: new Date(toIsoTimestamp(row.acts_created_at)!),
  };
}

interface CrmFactRow {
  fact_id: string;
  seq: string;
  org_id: string;
  brand_id: string;
  emails: string[] | null;
  full_name: string | null;
  phones: string[] | null;
  type: string;
  source: string;
  occurred_at: RawTimestamp;
  payload: Record<string, unknown> | null;
  withdrawn: boolean;
}

/**
 * A CRM fact that RE-STATES an action an earlier copy already answered (crm-service re-issues a fact under a new id
 * when its person is merged, identified or re-minted: same source, source ref, type, date): kept `skipped`
 * `restated_action`, nothing sent (outcome-trigger-rules.ts RESTATED_ACTION). THROWS on a failed read.
 */
async function isRestatedAction(f: CrmFactRow, step: string, at: string | null): Promise<boolean> {
  if (!(await earlierCopyAnswered(f.fact_id, step))) return false;
  await db.execute(sql`
    INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, occurred_at, source, status, skip_reason)
    VALUES (${`crm:${f.fact_id}`}, ${f.org_id}, ${f.brand_id}, '', ${step}, '', ${at}::timestamptz, 'crm_fact', 'skipped', ${RESTATED_ACTION})
    ON CONFLICT DO NOTHING
  `);
  console.log(`[lead-service] outcome ${step} NOT fired (${RESTATED_ACTION}): org=${f.org_id} brand=${f.brand_id} crm:${f.fact_id} re-states an action already answered`);
  return true;
}

/** Whether another copy of the CRM fact's action (same source, ref, type, date) already answered its trigger. */
async function earlierCopyAnswered(factId: string, step: string): Promise<boolean> {
  const earlier = (await db.execute(sql`
    SELECT o.status, o.skip_reason
    FROM crm_facts c1
    JOIN crm_facts c2
      ON c2.org_id = c1.org_id AND c2.brand_id = c1.brand_id AND c2.type = c1.type
     AND c2.occurred_at IS NOT DISTINCT FROM c1.occurred_at
     AND c2.source = c1.source AND c2.source_ref = c1.source_ref AND c2.fact_id <> c1.fact_id
    JOIN outcome_trigger_fires o ON o.source_ref = 'crm:' || c2.fact_id AND o.step = ${step}
    WHERE c1.fact_id = ${factId}
  `)) as unknown as Array<{ status: string; skip_reason: string | null }>;
  return actionAlreadyAnswered(earlier.map((r) => ({ status: r.status, skipReason: r.skip_reason })));
}

export type ReResolveAnswer =
  | { status: 200; rows: Array<{ offerId: string; status: string; skipReason: string | null }> }
  | { status: 404 | 409; reason: "not_found" | "already_answered" | "not_fresh" | "restated_action"; detail: string };

/**
 * RE-RESOLVE ONE REACH SET ASIDE BEFORE THE DOOR (OFFER-FROM-LIVE-CAMPAIGNS-1024): a record whose person or offer could
 * not be named (`no_person`, `offer_unknown`, `unresolvable`) never fired; once the answer exists (a live campaign
 * now answers the trigger), staff re-resolves it through the SAME path a fresh reach takes (resolve, write one row per
 * offer, ring the door). Refused when any row of the record already answered (409 `already_answered`: once per action),
 * when the reach is outside the fresh window (409 `not_fresh`: no back-fill), or when another copy of the same CRM
 * action already answered (409 `restated_action`). Unknown record = 404.
 */
export async function reResolveSetAsideReach(sourceRef: string, now: Date = new Date()): Promise<ReResolveAnswer> {
  const rows = (await db.execute(sql`
    SELECT org_id, brand_id, offer_id, step, lead_id::text AS lead_id, email, name, phone, occurred_at, source, status, skip_reason, item
    FROM outcome_trigger_fires WHERE source_ref = ${sourceRef} ORDER BY created_at
  `)) as unknown as Array<{
    org_id: string; brand_id: string; offer_id: string; step: string; lead_id: string | null; email: string | null;
    name: string | null; phone: string | null; occurred_at: RawTimestamp; source: string; status: string; skip_reason: string | null;
    item: Record<string, unknown> | null;
  }>;
  if (rows.length === 0) return { status: 404, reason: "not_found", detail: `no outcome reach recorded under ${sourceRef}` };
  if (rows.some((r) => r.status !== "skipped" || !UNANSWERED_SKIPS.includes(r.skip_reason ?? ""))) {
    return { status: 409, reason: "already_answered", detail: `${sourceRef} already answered its trigger` };
  }
  const first = rows[0];
  const at = toIsoTimestamp(first.occurred_at);
  const state = await armedState();
  if (!isFreshReach(at, state.armedAt, now)) {
    return { status: 409, reason: "not_fresh", detail: `${sourceRef} happened at ${at ?? "an unknown time"}, outside the fresh window` };
  }
  if (sourceRef.startsWith("crm:") && (await earlierCopyAnswered(sourceRef.slice(4), first.step))) {
    return { status: 409, reason: "restated_action", detail: `another copy of ${sourceRef}'s action already answered` };
  }
  const pending = await recordOutcomeReach({
    orgId: first.org_id,
    brandId: first.brand_id,
    step: first.step,
    source: first.source,
    sourceRef,
    occurredAt: at,
    leadId: first.lead_id,
    emails: canonicalEmails([first.email]),
    name: first.name,
    phone: first.phone,
    statedOfferId: null,
    statedCampaignId: null,
    item: first.item,
  });
  await deliverIds(pending);
  const after = (await db.execute(sql`
    SELECT offer_id, status, skip_reason FROM outcome_trigger_fires WHERE source_ref = ${sourceRef} ORDER BY created_at
  `)) as unknown as Array<{ offer_id: string; status: string; skip_reason: string | null }>;
  console.log(`[lead-service] outcome reach ${sourceRef} re-resolved: ${after.map((r) => `${r.offer_id || "-"}=${r.status}${r.skip_reason ? `/${r.skip_reason}` : ""}`).join(", ")}`);
  return { status: 200, rows: after.map((r) => ({ offerId: r.offer_id, status: r.status, skipReason: r.skip_reason })) };
}

/** New CRM facts since the cursor, in copy order. A failure stops at that fact: the cursor never passes it. */
async function sweepCrmFacts(state: SweepState, now: Date, lookups: Lookups, pending: string[], scope: OutcomeSweepScope | null): Promise<number> {
  let reaches = 0;
  for (let batch = 0; batch < CRM_FACT_BATCHES_PER_TICK; batch++) {
    const facts = (await db.execute(sql`
      SELECT f.fact_id, f.seq::text AS seq, f.org_id, f.brand_id, f.emails, f.full_name, f.phones, f.type, f.source, f.occurred_at, f.payload,
        CASE WHEN f.type = ANY(${sql.param([...CRM_FACT_REACH_TYPES])}::text[]) OR f.type <> ALL(${sql.param([...CRM_NOT_THEIR_ACT])}::text[])
          THEN EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
          ELSE false END AS withdrawn
      FROM crm_facts f
      WHERE f.seq > ${state.crmFactSeq}::bigint
      ORDER BY f.seq
      LIMIT ${CRM_FACT_BATCH}
    `)) as unknown as CrmFactRow[];
    if (facts.length === 0) break;
    let cursor = state.crmFactSeq;
    try {
      for (const f of facts) {
        const inScope_ = !scope || scope.orgIds.includes(f.org_id);
        const outcome = inScope_ ? stepOfCrmFact(f.type) : null;
        const at = toIsoTimestamp(f.occurred_at);
        const emails = canonicalEmails(f.emails ?? []);
        const reachesOutcome =
          outcome !== null &&
          emails.length > 0 &&
          rowReaches({ emails, name: f.full_name, phones: f.phones ?? [], at, type: f.type, payload: f.payload });
        // Any other act of theirs (a refused payment, a product event) rings Lead event as itself, once per fact.
        const step = reachesOutcome ? outcome : inScope_ && isTheirNewAct(f.type, false) ? actStep(f.type) : null;
        const phone = (f.phones ?? []).map((p) => p.trim()).find(Boolean) ?? null;
        const reaches_ = step !== null && !f.withdrawn && (emails.length > 0 || (isActStep(step) && phone !== null)) && isFreshReach(at, state.armedAt, now);
        if (reaches_ && step && (await isRestatedAction(f, step, at))) {
          reaches++;
        } else if (reaches_ && step) {
          pending.push(
            ...(await recordSwept(
              {
                orgId: f.org_id,
                brandId: f.brand_id,
                step,
                source: "crm_fact",
                sourceRef: `crm:${f.fact_id}`,
                occurredAt: at,
                leadId: null,
                emails,
                name: f.full_name,
                phone,
                statedOfferId: null,
                statedCampaignId: null,
                item: isActStep(step) ? actItem({ type: f.type, source: f.source, factId: f.fact_id, occurredAt: at, payload: f.payload }) : null,
              },
              lookups,
              now,
            )),
          );
          reaches++;
        }
        cursor = f.seq;
      }
    } finally {
      if (cursor !== state.crmFactSeq) {
        await db.execute(sql`UPDATE outcome_trigger_sweep SET crm_fact_seq = ${cursor}::bigint, updated_at = now() WHERE id = ${SWEEP_ID}`);
        state.crmFactSeq = cursor;
      }
    }
    if (facts.length < CRM_FACT_BATCH) break;
  }
  return reaches;
}

interface LedgerRow {
  id: string;
  org_id: string;
  brand_id: string;
  event: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  received_at: RawTimestamp;
  source: string;
  campaign_id: string | null;
  lead_id: string | null;
}

/** Outcome-ledger rows (not the CRM's: their record is the fact copy) inside the fresh window, not yet read. */
async function sweepLedger(state: SweepState, now: Date, lookups: Lookups, pending: string[], scope: OutcomeSweepScope | null): Promise<number> {
  // A row is read once per step it reaches: `ce:<id>` for the any-source step, `ce:<id>:<step>` for a source-bound
  // one (a sale the website tag reported is ALSO a Direct purchase).
  const unread = (ref: ReturnType<typeof sql>) => sql`NOT EXISTS (SELECT 1 FROM outcome_trigger_fires o WHERE o.source_ref = ${ref})`;
  const notYetRead = sql`(
    (ce.event = ANY(${sql.param([...LEDGER_ANY_SOURCE_EVENTS])}::text[]) AND ${unread(sql`'ce:' || ce.id::text`)})
    ${sql.join(
      LEDGER_SOURCE_BOUND_STEPS.map(
        (b) => sql` OR (ce.event = ANY(${sql.param([...b.events])}::text[]) AND ce.source = ANY(${sql.param([...b.sources])}::text[])
          AND ${unread(sql`'ce:' || ce.id::text || ${`:${b.step}`}`)})`,
      ),
      sql``,
    )}
  )`;
  const rows = (await db.execute(sql`
    SELECT ce.id::text AS id, ce.org_id, ce.brand_id, ce.event, ce.email, ce.phone,
      NULLIF(trim(concat_ws(' ', ce.first_name, ce.last_name)), '') AS name,
      ce.received_at, ce.source, ce.campaign_id,
      CASE WHEN ce.attribution_status = 'attributed' THEN ce.matched_lead_id::text END AS lead_id
    FROM conversion_events ce
    WHERE ce.withdrawn_at IS NULL ${inScope(sql`ce.org_id`, scope)}
      AND ce.source <> 'crm'
      AND ce.event = ANY(${sql.param([...LEDGER_REACH_EVENTS])}::text[])
      AND ce.received_at >= ${freshSince(state.armedAt, now).toISOString()}::timestamptz
      AND ${notYetRead}
    ORDER BY ce.received_at
    LIMIT ${LEDGER_BATCH}
  `)) as unknown as LedgerRow[];
  const wanted = rows.flatMap((ce) => stepsOfLedgerRow(ce.event, ce.source).map((step) => ledgerSourceRef(ce.id, step)));
  const alreadyRead = new Set(
    wanted.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT DISTINCT source_ref FROM outcome_trigger_fires WHERE source_ref = ANY(${sql.param(wanted)}::text[])
        `)) as unknown as Array<{ source_ref: string }>).map((r) => r.source_ref),
  );
  let failed: unknown = null;
  for (const ce of rows) {
    for (const step of stepsOfLedgerRow(ce.event, ce.source)) {
      const sourceRef = ledgerSourceRef(ce.id, step);
      if (alreadyRead.has(sourceRef)) continue;
      // One reach failing never holds the others: it is read again next pass (nothing was written for it).
      try {
        pending.push(
          ...(await recordSwept(
            {
              orgId: ce.org_id,
              brandId: ce.brand_id,
              step,
              source: ce.source,
              sourceRef,
              occurredAt: toIsoTimestamp(ce.received_at),
              leadId: ce.lead_id,
              emails: canonicalEmails([ce.email]),
              name: ce.name,
              phone: ce.phone,
              statedOfferId: null,
              statedCampaignId: ce.campaign_id,
            },
            lookups,
            now,
          )),
        );
      } catch (err) {
        failed ??= err;
      }
    }
  }
  if (failed) throw failed;
  return rows.length;
}

interface ActRow {
  id: string;
  org_id: string;
  brand_ids: string[];
  lead_id: string;
  acting_campaign_id: string;
  occurred_at: RawTimestamp;
  created_at: RawTimestamp;
}

/** `acted` rows of an AI Instant Call campaign: a booking call placed with the person (booking-calls.ts). */
async function sweepBookingCalls(state: SweepState, now: Date, lookups: Lookups, pending: string[], scope: OutcomeSweepScope | null): Promise<number> {
  const from = new Date(Math.max(state.armedAt.getTime(), state.actsCreatedAt.getTime() - ACTS_OVERLAP_MS));
  const acts = (await db.execute(sql`
    SELECT fa.id::text AS id, fa.org_id, fa.brand_ids, fa.lead_id::text AS lead_id, fa.acting_campaign_id, fa.occurred_at, fa.created_at
    FROM followup_actions fa
    WHERE fa.action = 'acted' AND fa.acting_campaign_id IS NOT NULL ${inScope(sql`fa.org_id`, scope)}
      AND fa.created_at >= ${from.toISOString()}::timestamptz
    ORDER BY fa.created_at
    LIMIT ${LEDGER_BATCH}
  `)) as unknown as ActRow[];
  let reaches = 0;
  let cursor = state.actsCreatedAt;
  for (const act of acts) {
    const campaign = (await lookups.orgCampaigns(act.org_id)).get(act.acting_campaign_id);
    const at = toIsoTimestamp(act.occurred_at);
    if (campaign?.legKey === BOOKING_CALL_LEG_KEY && isFreshReach(at, state.armedAt, now)) {
      for (const brandId of [...new Set(act.brand_ids)]) {
        pending.push(
          ...(await recordSwept(
            {
              orgId: act.org_id,
              brandId,
              step: BOOKING_CALL_STEP,
              source: "acted",
              sourceRef: act.brand_ids.length > 1 ? `fa:${act.id}:${brandId}` : `fa:${act.id}`,
              occurredAt: at,
              leadId: act.lead_id,
              emails: [],
              name: null,
              phone: null,
              statedOfferId: campaign.offerId,
              statedCampaignId: null,
            },
            lookups,
            now,
          )),
        );
        reaches++;
      }
    }
    const created = new Date(toIsoTimestamp(act.created_at)!);
    if (created > cursor) cursor = created;
  }
  if (cursor > state.actsCreatedAt) {
    await db.execute(sql`UPDATE outcome_trigger_sweep SET acts_created_at = ${cursor.toISOString()}::timestamptz, updated_at = now() WHERE id = ${SWEEP_ID}`);
    state.actsCreatedAt = cursor;
  }
  return reaches;
}

/** A booked meeting is read back this long before the fresh window by its start: it is held at its end, later. */
const HELD_MEETING_START_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Booked meetings whose time has passed with no cancel / no-show (meeting-held.ts): Meeting attended, once per
 * meeting. Read whole each pass (a meeting becomes held by time passing, not by a new fact: no cursor); a meeting
 * already read is skipped by its record.
 */
async function sweepHeldMeetings(state: SweepState, now: Date, lookups: Lookups, pending: string[], scope: OutcomeSweepScope | null): Promise<number> {
  const since = freshSince(state.armedAt, now);
  const held = await readHeldMeetings({
    where: scope ? sql`f.org_id = ANY(${sql.param([...scope.orgIds])}::text[])` : sql`true`,
    startsFrom: new Date(since.getTime() - HELD_MEETING_START_LOOKBACK_MS),
    startsTo: new Date(now.getTime() - HELD_GRACE_MS),
    now,
  });
  const fresh = held
    .filter((m) => isFreshReach(m.heldAt, state.armedAt, now))
    .map((m) => ({ ...m, ref: heldMeetingSourceRef(m.brandId, m.source, m.sourceRef), emails: canonicalEmails(m.emails) }))
    .filter((m) => m.emails.length > 0);
  if (fresh.length === 0) return 0;
  const alreadyRead = new Set(
    ((await db.execute(sql`
      SELECT DISTINCT source_ref FROM outcome_trigger_fires WHERE source_ref = ANY(${sql.param(fresh.map((m) => m.ref))}::text[])
    `)) as unknown as Array<{ source_ref: string }>).map((r) => r.source_ref),
  );
  let reaches = 0;
  let failed: unknown = null;
  for (const m of fresh) {
    if (alreadyRead.has(m.ref)) continue;
    // One meeting failing never holds the others: it is read again next pass (nothing was written for it).
    try {
      pending.push(
        ...(await recordSwept(
          {
            orgId: m.orgId,
            brandId: m.brandId,
            step: MEETING_HELD_STEP,
            source: "meeting_held",
            sourceRef: m.ref,
            occurredAt: m.heldAt,
            leadId: null,
            emails: m.emails,
            name: m.name,
            phone: m.phones.map((p) => p.trim()).find(Boolean) ?? null,
            statedOfferId: null,
            statedCampaignId: null,
          },
          lookups,
          now,
        )),
      );
      reaches++;
    } catch (err) {
      failed ??= err;
    }
  }
  if (failed) throw failed;
  return reaches;
}

let sweeping = false;

/**
 * One pass: read every new reach, write it, ring the door for the new ones, then redeliver what is due.
 * Each source fails on its own (logged loud, retried next pass); a failure never moves a cursor past a reach.
 */
export async function sweepOutcomeTriggers(
  now: Date = new Date(),
  scope: OutcomeSweepScope | null = null,
): Promise<{ crmFacts: number; ledger: number; bookingCalls: number; heldMeetings: number; drained: Record<DeliveryResult, number> }> {
  const empty = { delivered: 0, skipped: 0, refused: 0, retry: 0 };
  if (sweeping) return { crmFacts: 0, ledger: 0, bookingCalls: 0, heldMeetings: 0, drained: empty };
  sweeping = true;
  try {
    const state = await armedState();
    const lookups = createLookups();
    const pending: string[] = [];
    const run = async (label: string, fn: () => Promise<number>): Promise<number> => {
      try {
        return await fn();
      } catch (err) {
        console.error(`[lead-service] outcome trigger sweep: ${label} failed, retried next pass:`, err);
        return 0;
      }
    };
    const crmFacts = await run("crm facts", () => sweepCrmFacts(state, now, lookups, pending, scope));
    const ledger = await run("outcome ledger", () => sweepLedger(state, now, lookups, pending, scope));
    const bookingCalls = await run("booking calls", () => sweepBookingCalls(state, now, lookups, pending, scope));
    const heldMeetings = await run("held meetings", () => sweepHeldMeetings(state, now, lookups, pending, scope));
    await deliverIds(pending);
    const drained = await drainOutcomeTriggerFires(scope);
    if (crmFacts + ledger + bookingCalls + heldMeetings + drained.delivered + drained.retry + drained.refused > 0) {
      console.log(
        `[lead-service] outcome trigger sweep: reaches crm=${crmFacts} ledger=${ledger} booking_calls=${bookingCalls} held_meetings=${heldMeetings}; ` +
          `redelivered=${drained.delivered} retry=${drained.retry} refused=${drained.refused}`,
      );
    }
    return { crmFacts, ledger, bookingCalls, heldMeetings, drained };
  } finally {
    sweeping = false;
  }
}

/** Background thread: the sweep every 30s, first pass a minute after boot. */
export function startOutcomeTriggerWorker(): void {
  const tick = () => {
    sweepOutcomeTriggers().catch((err) => console.error("[lead-service] outcome trigger sweep failed:", err));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, OUTCOME_SWEEP_INTERVAL_MS).unref();
}
