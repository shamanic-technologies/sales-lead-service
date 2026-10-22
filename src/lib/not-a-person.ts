/**
 * "Not a real person" (FAKE-OUTCOMES-1022, migration 0120): our own staff tests must never inflate a brand's
 * figures. A lead is not a person for an org when
 *   - the org STATED it (`basis = 'stated'`: a test, a staff mailbox, a fake signup), through
 *     PUT /orgs/leads/{id}/not-a-person, withdrawable by DELETE; or
 *   - EVERY registered email of the lead is a staff identity (`basis = 'staff_identity'`, the fleet's
 *     `isStaffEmail`, recorded by `syncStaffIdentityMarks` for every org holding the lead; lifted by the same
 *     sweep once the lead carries a real address, never by a person).
 *
 * A live mark (either basis):
 *   1. takes the lead out of every lead READ of the org (`notMarkedNotAPerson` in the list relation and every
 *      outer scope filter: list, compact, counts, read model, change feed, standing counts), so no reply,
 *      visit or outcome of theirs counts anywhere a population is read;
 *   2. sets aside its conversion events (`withdrawn_reason = 'not_a_person'`), and a DB trigger writes any
 *      later one set aside whatever the writer (tracker, CRM, reply, statement), so the brand-level outcome
 *      counts never read them either. Lifting the last mark stands exactly those back up.
 * Nothing deleted; the serve path is untouched (who we may contact is not decided here).
 */
import { sql as drizzleSql } from "drizzle-orm";
import { db, sql } from "../db/index.js";
import { staffEmailSql } from "./staff-identity.js";
import { NOT_A_PERSON_WITHDRAWAL } from "./withdrawal-reasons.js";

export type NotAPersonBasis = "stated" | "staff_identity";

/**
 * The lead-read predicate (postgres.js fragment): the membership row `alias` belongs to a lead no live mark
 * of its org names. Applied inside the dedup subquery AND on every outer scope filter, so both list paths
 * (deduped and flat single-campaign) and their counts read one population.
 */
export function notMarkedNotAPerson(alias: "lc" | "lc0") {
  // Two literal templates rather than an identifier helper: every reader's statement stays a plain tagged
  // template (their unit tests compile them as such).
  return alias === "lc0"
    ? sql`NOT EXISTS (
        SELECT 1 FROM not_a_person_marks npm
        WHERE npm.org_id = lc0.org_id AND npm.lead_id = lc0.lead_id AND npm.withdrawn_at IS NULL
      )`
    : sql`NOT EXISTS (
        SELECT 1 FROM not_a_person_marks npm
        WHERE npm.org_id = lc.org_id AND npm.lead_id = lc.lead_id AND npm.withdrawn_at IS NULL
      )`;
}

export interface NotAPersonMark {
  leadId: string;
  basis: NotAPersonBasis;
  note: string | null;
  statedByUserId: string | null;
  markedAt: string;
  emails: string[];
  name: string | null;
}

/**
 * The lead a per-lead route names, inside the org: `id` = a list row id (`leads_campaigns.id`, what every
 * row of GET /orgs/leads carries) or the lead's own id. null = not a lead of this org (404).
 */
export async function resolveOrgLead(orgId: string, id: string): Promise<string | null> {
  const rows = (await sql`
    SELECT lead_id::text AS lead_id FROM leads_campaigns
    WHERE org_id = ${orgId} AND (id = ${id}::uuid OR lead_id = ${id}::uuid)
    LIMIT 1
  `) as unknown as Array<{ lead_id: string }>;
  return rows[0]?.lead_id ?? null;
}

/**
 * Make the lead's conversion events of the org agree with its marks: set aside every live one while a mark
 * stands; stand back up only the ones a mark set aside once none stands. Idempotent.
 */
export async function reconcileMarkedConversions(orgId: string, leadId: string): Promise<{ setAside: number; restored: number }> {
  const marked = (await sql`
    SELECT 1 FROM not_a_person_marks WHERE org_id = ${orgId} AND lead_id = ${leadId}::uuid AND withdrawn_at IS NULL LIMIT 1
  `) as unknown as unknown[];
  if (marked.length > 0) {
    const rows = (await sql`
      UPDATE conversion_events SET withdrawn_at = now(), withdrawn_reason = ${NOT_A_PERSON_WITHDRAWAL}
      WHERE org_id = ${orgId} AND matched_lead_id = ${leadId}::uuid AND withdrawn_at IS NULL
      RETURNING id
    `) as unknown as unknown[];
    return { setAside: rows.length, restored: 0 };
  }
  const rows = (await sql`
    UPDATE conversion_events SET withdrawn_at = NULL, withdrawn_reason = NULL
    WHERE org_id = ${orgId} AND matched_lead_id = ${leadId}::uuid AND withdrawn_reason = ${NOT_A_PERSON_WITHDRAWAL}
    RETURNING id
  `) as unknown as unknown[];
  return { setAside: 0, restored: rows.length };
}

/** State it (or restate the note). Returns whether a live stated mark already existed. */
export async function stateNotAPerson(p: {
  orgId: string;
  leadId: string;
  userId: string;
  note: string | null;
}): Promise<{ alreadyMarked: boolean; setAside: number }> {
  const rows = (await sql`
    INSERT INTO not_a_person_marks (org_id, lead_id, basis, note, stated_by_user_id)
    VALUES (${p.orgId}, ${p.leadId}::uuid, 'stated', ${p.note}, ${p.userId})
    ON CONFLICT (org_id, lead_id, basis) DO UPDATE SET
      note = EXCLUDED.note,
      stated_by_user_id = EXCLUDED.stated_by_user_id,
      updated_at = now(),
      withdrawn_at = NULL,
      withdrawn_by_user_id = NULL
    RETURNING (xmax <> 0) AS existed, created_at
  `) as unknown as Array<{ existed: boolean }>;
  const { setAside } = await reconcileMarkedConversions(p.orgId, p.leadId);
  return { alreadyMarked: rows[0]?.existed === true, setAside };
}

/**
 * Lift the org's stated mark. A staff-identity mark is not a person's to lift (it follows the addresses):
 * the answer says it still stands.
 */
export async function liftNotAPerson(p: {
  orgId: string;
  leadId: string;
  userId: string;
}): Promise<{ lifted: boolean; stillMarkedBy: NotAPersonBasis[]; restored: number }> {
  const lifted = (await sql`
    UPDATE not_a_person_marks SET withdrawn_at = now(), withdrawn_by_user_id = ${p.userId}, updated_at = now()
    WHERE org_id = ${p.orgId} AND lead_id = ${p.leadId}::uuid AND basis = 'stated' AND withdrawn_at IS NULL
    RETURNING basis
  `) as unknown as unknown[];
  const still = (await sql`
    SELECT basis FROM not_a_person_marks
    WHERE org_id = ${p.orgId} AND lead_id = ${p.leadId}::uuid AND withdrawn_at IS NULL
  `) as unknown as Array<{ basis: NotAPersonBasis }>;
  const { restored } = await reconcileMarkedConversions(p.orgId, p.leadId);
  return { lifted: lifted.length > 0, stillMarkedBy: still.map((r) => r.basis), restored };
}

/** Every live mark of the org (optionally one lead), with who the lead is. */
export async function listNotAPerson(orgId: string, leadId?: string): Promise<NotAPersonMark[]> {
  const rows = (await sql`
    SELECT m.lead_id::text AS lead_id, m.basis, m.note, m.stated_by_user_id,
           m.updated_at::text AS marked_at,
           NULLIF(trim(concat_ws(' ', l.first_name, l.last_name)), '') AS name,
           COALESCE((SELECT array_agg(cm.value ORDER BY cm.value) FROM lead_contact_methods cm
                     WHERE cm.lead_id = m.lead_id AND cm.channel = 'email'), '{}') AS emails
    FROM not_a_person_marks m
    JOIN leads l ON l.id = m.lead_id
    WHERE m.org_id = ${orgId} AND m.withdrawn_at IS NULL
      ${leadId ? sql`AND m.lead_id = ${leadId}::uuid` : sql``}
    ORDER BY m.updated_at DESC, m.lead_id, m.basis
  `) as unknown as Array<{
    lead_id: string;
    basis: NotAPersonBasis;
    note: string | null;
    stated_by_user_id: string | null;
    marked_at: string;
    name: string | null;
    emails: string[];
  }>;
  return rows.map((r) => ({
    leadId: r.lead_id,
    basis: r.basis,
    note: r.note,
    statedByUserId: r.stated_by_user_id,
    markedAt: new Date(r.marked_at).toISOString(),
    emails: r.emails,
    name: r.name,
  }));
}

/**
 * Background sweep: record a `staff_identity` mark, for every org holding the lead, on each lead whose
 * registered emails are ALL staff identities; lift the ones whose lead now carries a real address. Then
 * reconcile each touched (org, lead)'s conversion events. Returns how many marks moved.
 */
export async function syncStaffIdentityMarks(): Promise<{ marked: number; lifted: number }> {
  const staffOnly = drizzleSql`
    SELECT cm.lead_id FROM lead_contact_methods cm
    WHERE cm.channel = 'email'
      AND cm.lead_id IN (SELECT s.lead_id FROM lead_contact_methods s WHERE s.channel = 'email' AND ${staffEmailSql("s.value")})
    GROUP BY cm.lead_id
    HAVING bool_and(${staffEmailSql("cm.value")})
  `;
  const marked = (await db.execute(drizzleSql`
    INSERT INTO not_a_person_marks (org_id, lead_id, basis)
    SELECT DISTINCT lc.org_id, lc.lead_id, 'staff_identity'
    FROM leads_campaigns lc
    WHERE lc.lead_id IN (${staffOnly})
    ON CONFLICT (org_id, lead_id, basis) DO UPDATE SET withdrawn_at = NULL, withdrawn_by_user_id = NULL, updated_at = now()
      WHERE not_a_person_marks.withdrawn_at IS NOT NULL
    RETURNING org_id, lead_id::text AS lead_id
  `)) as unknown as Array<{ org_id: string; lead_id: string }>;
  const lifted = (await db.execute(drizzleSql`
    UPDATE not_a_person_marks SET withdrawn_at = now(), updated_at = now()
    WHERE basis = 'staff_identity' AND withdrawn_at IS NULL AND lead_id NOT IN (${staffOnly})
    RETURNING org_id, lead_id::text AS lead_id
  `)) as unknown as Array<{ org_id: string; lead_id: string }>;
  // A new mark also sets aside conversions written before it (the trigger only guards later writes).
  for (const r of [...marked, ...lifted]) await reconcileMarkedConversions(r.org_id, r.lead_id);
  return { marked: marked.length, lifted: lifted.length };
}

const STAFF_MARKS_INTERVAL_MS = 10 * 60_000;
const STAFF_MARKS_FIRST_DELAY_MS = 60_000;
let syncing = false;

/** Background thread: `syncStaffIdentityMarks` ~60s after boot, then every 10 min. */
export function startStaffIdentityMarksWorker(): void {
  const tick = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const r = await syncStaffIdentityMarks();
      if (r.marked || r.lifted) console.log(`[lead-service] staff-identity marks: ${r.marked} marked, ${r.lifted} lifted`);
    } catch (err) {
      console.error("[lead-service] staff-identity marks sync failed:", err);
    } finally {
      syncing = false;
    }
  };
  setTimeout(() => void tick(), STAFF_MARKS_FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), STAFF_MARKS_INTERVAL_MS).unref();
}
