/**
 * A lead's timezone and WHERE it came from (PUSHED-PERSON-TZ-1014, owner 2026-10-14; migration 0082).
 *
 * Every sender (cold email, AI follow-ups, AI meeting booking, WhatsApp) schedules in `lead.timezone`
 * and falls back to America/Chicago without one. Three sources, one precedence, enforced HERE by every
 * write (each UPDATE carries its guard, so a race cannot invert it):
 *
 *   stated      the client named the zone when it pushed the person: always wins, replaces anything.
 *   enrichment  upstream (human-service / apollo-service): replaces an inferred zone, never a stated one.
 *   inferred    read off what we hold (`timezone-inference.ts`): fills an EMPTY zone or refreshes an
 *               earlier inference, never touches a stated or enriched one.
 *
 * Unknown stays NULL: no signal, or a country of several clocks with nothing to settle it, is never
 * given a zone. Inference runs when a pushed person is filed (named-person.ts) and in a background
 * sweep that visits every lead with no zone once (`timezone_checked_at`), so people already queued
 * and leads from every other door (sourced without a zone, CRM signups) benefit too.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { inferTimezone, type InferredTimezone } from "./timezone-inference.js";

export type TimezoneSource = "stated" | "enrichment" | "inferred";

/** The client said so: replaces whatever was stored. The zone is validated by the caller (400). */
export async function writeStatedTimezone(leadId: string, timezone: string): Promise<void> {
  await db.execute(sql`
    UPDATE leads SET timezone = ${timezone}, timezone_source = 'stated', timezone_basis = NULL
    WHERE id = ${leadId}
  `);
}

/** Upstream's zone: replaces an inferred (or absent) zone, never a stated one. */
export async function writeEnrichedTimezone(leadId: string, timezone: string): Promise<void> {
  await db.execute(sql`
    UPDATE leads SET timezone = ${timezone}, timezone_source = 'enrichment', timezone_basis = NULL
    WHERE id = ${leadId} AND timezone_source IS DISTINCT FROM 'stated'
  `);
}

interface SignalRow {
  id: string;
  country: string | null;
  state: string | null;
  company_country: string | null;
  company_state: string | null;
  phones: string[] | null;
  emails: string[] | null;
}

/** What we hold about each lead that names where they are. One statement for the whole batch. */
async function loadSignals(leadIds: string[]): Promise<SignalRow[]> {
  if (leadIds.length === 0) return [];
  return (await db.execute(sql`
    SELECT l.id::text AS id, l.country, l.state,
           o.country AS company_country, o.state AS company_state,
           (SELECT array_agg(cm.value ORDER BY cm.created_at) FROM lead_contact_methods cm
             WHERE cm.lead_id = l.id AND cm.channel = 'phone') AS phones,
           (SELECT array_agg(cm.value ORDER BY cm.created_at) FROM lead_contact_methods cm
             WHERE cm.lead_id = l.id AND cm.channel = 'email') AS emails
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT org.country, org.state FROM organizations org
      WHERE org.id = COALESCE(l.organization_id, (
        SELECT lo.organization_id FROM leads_organizations lo
        WHERE lo.lead_id = l.id
        ORDER BY lo.current DESC, lo.start_date DESC NULLS LAST, lo.created_at DESC, lo.organization_id
        LIMIT 1
      ))
    ) o ON true
    WHERE l.id::text = ANY(${sql.param(leadIds)}::text[])
  `)) as unknown as SignalRow[];
}

function inferFromRow(row: SignalRow): InferredTimezone | null {
  return inferTimezone({
    leadCountry: row.country,
    leadState: row.state,
    companyCountry: row.company_country,
    companyState: row.company_state,
    phones: row.phones ?? [],
    emails: row.emails ?? [],
  });
}

/** Write an inference: only into an empty or inferred zone. Marks the lead checked either way. */
async function storeInference(leadId: string, inferred: InferredTimezone | null): Promise<boolean> {
  if (!inferred) {
    await db.execute(sql`UPDATE leads SET timezone_checked_at = now() WHERE id = ${leadId}`);
    return false;
  }
  const rows = (await db.execute(sql`
    UPDATE leads SET timezone = ${inferred.timezone}, timezone_source = 'inferred',
                     timezone_basis = ${inferred.basis}, timezone_checked_at = now()
    WHERE id = ${leadId} AND (timezone IS NULL OR timezone_source = 'inferred')
    RETURNING id
  `)) as unknown as unknown[];
  if (rows.length === 0) {
    await db.execute(sql`UPDATE leads SET timezone_checked_at = now() WHERE id = ${leadId}`);
  }
  return rows.length > 0;
}

/** Infer and store one lead's zone (a filing just gave us a phone / an address). */
export async function inferLeadTimezone(leadId: string): Promise<InferredTimezone | null> {
  const [row] = await loadSignals([leadId]);
  if (!row) return null;
  const inferred = inferFromRow(row);
  await storeInference(leadId, inferred);
  return inferred;
}

export const LEAD_TIMEZONE_SWEEP_BATCH = 1000;
export const LEAD_TIMEZONE_INTERVAL_MS = 60_000;
const FIRST_SWEEP_DELAY_MS = 90_000;

/** One batch of leads with no zone the inference never looked at. */
export async function inferPendingTimezones(
  batch = LEAD_TIMEZONE_SWEEP_BATCH,
): Promise<{ checked: number; inferred: number }> {
  const pending = (await db.execute(sql`
    SELECT id::text AS id FROM leads
    WHERE timezone IS NULL AND timezone_checked_at IS NULL
    ORDER BY created_at, id
    LIMIT ${batch}
  `)) as unknown as Array<{ id: string }>;
  if (pending.length === 0) return { checked: 0, inferred: 0 };
  const rows = await loadSignals(pending.map((p) => p.id));
  let inferred = 0;
  for (const row of rows) {
    if (await storeInference(row.id, inferFromRow(row))) inferred++;
  }
  return { checked: rows.length, inferred };
}

let sweeping = false;

export function startLeadTimezoneWorker(): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await inferPendingTimezones();
      if (r.checked > 0) console.log(`[lead-service] lead timezone: checked=${r.checked} inferred=${r.inferred}`);
    } catch (error) {
      console.error("[lead-service] lead timezone sweep failed:", error);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS).unref();
  setInterval(() => void tick(), LEAD_TIMEZONE_INTERVAL_MS).unref();
}
