/**
 * A brand's CRM funnel events, read off the bronze copy of crm-service's people fact feed
 * (`crm_facts`, crm-fact-feed.ts), in the shape the CRM evidence sync reads.
 *
 * This replaces asking crm-service's `/orgs/gohighlevel/funnel-events` (crm-service#61): a funnel
 * fact IS a funnel event (`type` = step, `payload.via` = source, `sourceRef` = sourceId, same date
 * and basis), keyed on `crmContactId`, crm-service's own contact row id, which is what every frozen
 * pairing, judgment and ruling here is keyed on. Proven 1:1 in prod before the switch (brand
 * 75d7e3e8: 1,691 events vs 1,691 facts on contact|step|date|basis|via|ref, 0 only in either).
 *
 * Two rules keep a brand's evidence from vanishing, because the sync sets aside every CRM outcome
 * it no longer sees:
 *   1. A copy still filling is never read: the feed must have reached its end at least once
 *      (`caught_up_at`), else this THROWS and the sync sets nothing aside.
 *   2. A fact counts until a `withdrawn` fact names it. crm-service re-states a fact whose contact
 *      row was re-minted (a reconnect) as withdrawn + re-emitted, so the event moves to the new id.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import type { CrmFunnelEvent } from "./crm-evidence.js";
import { PEOPLE_FACTS_FEED } from "./crm-fact-feed.js";

/** One contact's dated funnel events, as the evidence sync reads them. */
export interface CrmContactFunnelEvents {
  /** crm-service's own contact row id: the key pairings are frozen on. */
  contactId: string;
  /** The person's first email on the fact (crm-service lists the contact's own first). */
  primaryEmail: string | null;
  fullName: string | null;
  events: CrmFunnelEvent[];
}

/** The fact types that are funnel events: crm-service names them exactly as funnel-events did. */
export const CRM_FUNNEL_FACT_TYPES = [
  "form_submitted",
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "sale",
  "deal_lost",
] as const;

export class CrmFactFeedNotCaughtUpError extends Error {
  constructor() {
    super(
      "the copy of crm-service's people fact feed has never reached the end of the feed, so CRM " +
        "evidence cannot be read from it yet (nothing is set aside)",
    );
    this.name = "CrmFactFeedNotCaughtUpError";
  }
}

export interface CrmFunnelFactRow {
  crm_contact_id: string;
  emails: string[];
  full_name: string | null;
  type: string;
  occurred_at: RawTimestamp;
  date_basis: string;
  source_ref: string;
  payload: Record<string, unknown>;
}

/**
 * The funnel event a fact is. The payload is the event's `detail`, under its funnel-events names:
 * `startsAt` was `scheduledStart`, and `via` is lifted out as the event's `source`.
 */
export function funnelEventFromFact(row: CrmFunnelFactRow): CrmFunnelEvent {
  const { via, startsAt, ...rest } = row.payload;
  return {
    step: row.type,
    occurredAt: toIsoTimestamp(row.occurred_at),
    dateBasis: row.date_basis,
    source: typeof via === "string" ? via : null,
    sourceId: row.source_ref,
    detail: { ...rest, scheduledStart: startsAt ?? null },
  };
}

/** Group fact rows (already in feed order) into one entry per contact, in first-seen order. */
export function contactsFromFactRows(rows: readonly CrmFunnelFactRow[]): CrmContactFunnelEvents[] {
  const byContact = new Map<string, CrmContactFunnelEvents>();
  for (const row of rows) {
    let contact = byContact.get(row.crm_contact_id);
    if (!contact) {
      contact = {
        contactId: row.crm_contact_id,
        primaryEmail: row.emails[0] ?? null,
        fullName: row.full_name,
        events: [],
      };
      byContact.set(row.crm_contact_id, contact);
    }
    contact.events.push(funnelEventFromFact(row));
  }
  return Array.from(byContact.values());
}

/** Every live funnel fact of the brand, grouped per crm contact. Throws on a copy still filling. */
export async function loadCrmFunnelEvents(orgId: string, brandId: string): Promise<CrmContactFunnelEvents[]> {
  const cursor = (await db.execute(sql`
    SELECT caught_up_at FROM crm_feed_cursors WHERE feed = ${PEOPLE_FACTS_FEED}
  `)) as unknown as Array<{ caught_up_at: RawTimestamp }>;
  if (cursor.length === 0 || cursor[0].caught_up_at === null) throw new CrmFactFeedNotCaughtUpError();

  const rows = (await db.execute(sql`
    SELECT f.crm_contact_id, f.emails, f.full_name, f.type, f.occurred_at, f.date_basis, f.source_ref, f.payload
    FROM crm_facts f
    WHERE f.org_id = ${orgId}
      AND f.brand_id = ${brandId}
      AND f.crm_contact_id IS NOT NULL
      AND f.type = ANY(${sql.param([...CRM_FUNNEL_FACT_TYPES])}::text[])
      AND NOT EXISTS (
        SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id
      )
    ORDER BY f.seq
  `)) as unknown as CrmFunnelFactRow[];
  return contactsFromFactRows(rows);
}
