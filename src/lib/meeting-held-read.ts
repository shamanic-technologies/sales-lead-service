/**
 * The IO half of "a booked meeting whose time has passed was held" (rules in `meeting-held.ts`): ONE statement over
 * the CRM copy's meeting facts (post-boot partial index `idx_crm_facts_meetings`), shared by the outcome-trigger
 * sweep and the step-reached read so both see the same held meetings.
 *
 * One row per meeting (org, brand, source, source ref): the LATEST live copy of its booking, with whether a live
 * `meeting_not_held` / `meeting_attended` fact settles it. Bounded by the meeting's START (`startsFrom..startsTo`):
 * a meeting is held at its end, which is never before its start. THROWS on a database error.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { MEETING_SETTLED_TYPES, heldMeetingVerdict } from "./meeting-held.js";

export interface HeldMeetingRow {
  factId: string;
  orgId: string;
  brandId: string;
  source: string;
  sourceRef: string;
  emails: string[];
  name: string | null;
  phones: string[];
  /** When the meeting was held (its end). */
  heldAt: string;
}

interface RawRow {
  fact_id: string;
  org_id: string;
  brand_id: string;
  source: string;
  source_ref: string;
  emails: string[] | null;
  full_name: string | null;
  phones: string[] | null;
  payload: Record<string, unknown> | null;
  settled: boolean;
}

/** An ISO start string Postgres can cast (anything else is filtered before the cast, never a statement error). */
const ISO_START = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T";

export async function readHeldMeetings(input: {
  /** Extra predicate on the booking copy `f` (org/brand scope, an address). */
  where: SQL;
  startsFrom: Date;
  startsTo: Date;
  now: Date;
}): Promise<HeldMeetingRow[]> {
  // Literal (never a bound list) so the planner proves the partial index's predicate.
  const settledTypes = sql.raw(MEETING_SETTLED_TYPES.map((t) => `'${t}'`).join(", "));
  const rows = (await db.execute(sql`
    WITH booked AS (
      SELECT DISTINCT ON (f.org_id, f.brand_id, f.source, f.source_ref)
        f.fact_id, f.org_id, f.brand_id, f.source, f.source_ref, f.emails, f.full_name, f.phones, f.payload,
        CASE WHEN f.payload->>'startsAt' ~ ${ISO_START} THEN (f.payload->>'startsAt')::timestamptz END AS starts_at
      FROM crm_facts f
      WHERE f.type = 'meeting_booked'
        AND f.payload->>'startsAt' IS NOT NULL
        AND ${input.where}
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
      ORDER BY f.org_id, f.brand_id, f.source, f.source_ref, f.seq DESC
    )
    SELECT b.fact_id, b.org_id, b.brand_id, b.source, b.source_ref, b.emails, b.full_name, b.phones, b.payload,
      EXISTS (
        SELECT 1 FROM crm_facts s
        WHERE s.type IN (${settledTypes})
          AND s.source = b.source AND s.source_ref = b.source_ref AND s.org_id = b.org_id AND s.brand_id = b.brand_id
          AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = s.fact_id)
      ) AS settled
    FROM booked b
    WHERE b.starts_at >= ${input.startsFrom.toISOString()}::timestamptz
      AND b.starts_at <= ${input.startsTo.toISOString()}::timestamptz
  `)) as unknown as RawRow[];
  const held: HeldMeetingRow[] = [];
  for (const r of rows) {
    const verdict = heldMeetingVerdict({ payload: r.payload, withdrawn: false, settled: r.settled }, input.now);
    if (!verdict.held) continue;
    held.push({
      factId: r.fact_id,
      orgId: r.org_id,
      brandId: r.brand_id,
      source: r.source,
      sourceRef: r.source_ref,
      emails: r.emails ?? [],
      name: r.full_name,
      phones: r.phones ?? [],
      heldAt: verdict.at.toISOString(),
    });
  }
  return held;
}
