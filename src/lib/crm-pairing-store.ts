/**
 * The three stored halves of a CRM pairing: the frozen match, the frozen judgment, the human's
 * ruling. Reads and writes only — every decision about what they MEAN lives in crm-pairing.ts.
 *
 * Two invariants this module exists to hold:
 *
 *   - A MATCH IS WRITTEN ONCE. `freezeMatches` inserts `ON CONFLICT DO NOTHING`, so a contact
 *     already matched keeps the answer it was matched with. That is the whole reason reading the
 *     view twice returns the same pairings — it is structural, not a coincidence of the matcher
 *     being deterministic.
 *   - A RULING IS NEVER DELETED. Withdrawing marks the row; restating clears the mark through the
 *     same upsert. Every read filters `withdrawn_at IS NULL`.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import type { MatchConfidence, MatchMethod, MatchResult } from "./conversions.js";
import type {
  CrmPairingJudgment,
  CrmPairingRuling,
  CrmPairingRulingKind,
  CrmPairingSignal,
} from "./crm-pairing.js";

export interface FrozenMatch extends CrmPairingSignal {
  crmContactId: string;
  matchedAt: string | null;
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

interface MatchRow {
  crm_contact_id: string;
  matched_lead_id: string | null;
  match_method: string | null;
  match_confidence: string;
  candidate_count: number;
  matched_at: Date | string | null;
}

function toFrozenMatch(row: MatchRow): FrozenMatch {
  return {
    crmContactId: row.crm_contact_id,
    matchedLeadId: row.matched_lead_id,
    matchMethod: (row.match_method as MatchMethod) ?? null,
    matchConfidence: row.match_confidence as MatchConfidence,
    candidateCount: Number(row.candidate_count) || 0,
    matchedAt: toIsoTimestamp(row.matched_at),
  };
}

/** Whatever of these contacts has already been matched. Missing keys are simply not matched yet. */
export async function loadFrozenMatches(
  brandId: string,
  crmContactIds: string[],
): Promise<Map<string, FrozenMatch>> {
  const out = new Map<string, FrozenMatch>();
  if (crmContactIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT crm_contact_id, matched_lead_id, match_method, match_confidence,
           candidate_count, matched_at
    FROM crm_pairing_matches
    WHERE brand_id = ${brandId}
      AND crm_contact_id = ANY(${sql.param(crmContactIds)}::text[])
  `)) as unknown as MatchRow[];
  for (const row of rows) out.set(row.crm_contact_id, toFrozenMatch(row));
  return out;
}

/**
 * Write the waterfall's answer for contacts that had none.
 *
 * `ON CONFLICT DO NOTHING`, so a concurrent read that matched the same contact first wins and both
 * readers see the same pairing. The returned map is what is now stored for these contacts — read
 * back rather than assumed, so a losing insert does not leave the caller holding an answer nobody
 * else will ever see.
 */
export async function freezeMatches(
  orgId: string,
  brandId: string,
  matches: Array<{ crmContactId: string; result: MatchResult }>,
): Promise<Map<string, FrozenMatch>> {
  if (matches.length === 0) return new Map();
  const contactIds = matches.map((m) => m.crmContactId);
  const leadIds = matches.map((m) => m.result.matchedLeadId);
  const methods = matches.map((m) => m.result.matchMethod);
  const confidences = matches.map((m) => m.result.matchConfidence);
  const counts = matches.map((m) => m.result.candidateCount);

  await db.execute(sql`
    INSERT INTO crm_pairing_matches
      (org_id, brand_id, crm_contact_id, matched_lead_id, match_method, match_confidence, candidate_count)
    SELECT ${orgId}, ${brandId}, c.contact_id, c.lead_id, c.method, c.confidence, c.candidate_count
    FROM unnest(
      ${sql.param(contactIds)}::text[],
      ${sql.param(leadIds)}::uuid[],
      ${sql.param(methods)}::text[],
      ${sql.param(confidences)}::text[],
      ${sql.param(counts)}::int[]
    ) AS c(contact_id, lead_id, method, confidence, candidate_count)
    ON CONFLICT (brand_id, crm_contact_id) DO NOTHING
  `);

  return await loadFrozenMatches(brandId, contactIds);
}

// ---------------------------------------------------------------------------
// Judgments
// ---------------------------------------------------------------------------

interface JudgmentRow {
  crm_contact_id: string;
  lead_id: string;
  same_person_probability: number | string;
  judgment_model: string;
  judged_at: Date | string | null;
}

/**
 * The judgment frozen for each of these contacts, keyed by contact id.
 *
 * A contact has at most one pairing at a time, so one judgment per contact is what a read needs.
 * When several exist (a new model release added a row beside an older one), the most recently
 * judged wins — but nothing here ever CREATES that situation: a pairing already carrying a
 * judgment is never re-judged, so a release moving does not silently re-answer old pairings.
 */
export async function loadJudgments(
  brandId: string,
  crmContactIds: string[],
): Promise<Map<string, CrmPairingJudgment & { leadId: string }>> {
  const out = new Map<string, CrmPairingJudgment & { leadId: string }>();
  if (crmContactIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (crm_contact_id, lead_id)
           crm_contact_id, lead_id, same_person_probability, judgment_model, judged_at
    FROM crm_pairing_judgments
    WHERE brand_id = ${brandId}
      AND crm_contact_id = ANY(${sql.param(crmContactIds)}::text[])
    ORDER BY crm_contact_id, lead_id, judged_at DESC
  `)) as unknown as JudgmentRow[];
  for (const row of rows) {
    out.set(row.crm_contact_id, {
      leadId: row.lead_id,
      samePersonProbability: Number(row.same_person_probability),
      model: row.judgment_model,
      judgedAt: toIsoTimestamp(row.judged_at) ?? "",
    });
  }
  return out;
}

/** Freeze one judgment. `DO NOTHING` on conflict: the first answer for a release is the answer. */
export async function saveJudgment(params: {
  orgId: string;
  brandId: string;
  crmContactId: string;
  leadId: string;
  samePersonProbability: number;
  model: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO crm_pairing_judgments
      (org_id, brand_id, crm_contact_id, lead_id, same_person_probability, judgment_model)
    VALUES (${params.orgId}, ${params.brandId}, ${params.crmContactId}, ${params.leadId},
            ${params.samePersonProbability}, ${params.model})
    ON CONFLICT (brand_id, crm_contact_id, lead_id, judgment_model) DO NOTHING
  `);
}

// ---------------------------------------------------------------------------
// Rulings
// ---------------------------------------------------------------------------

interface RulingRow {
  crm_contact_id: string;
  lead_id: string;
  ruling: string;
  note: string | null;
  stated_by_user_id: string | null;
  updated_at: Date | string | null;
}

/** Live (non-withdrawn) statements for these contacts, keyed `<contactId>:<leadId>`. */
export async function loadRulings(
  brandId: string,
  crmContactIds: string[],
): Promise<Map<string, CrmPairingRuling>> {
  const out = new Map<string, CrmPairingRuling>();
  if (crmContactIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT crm_contact_id, lead_id, ruling, note, stated_by_user_id, updated_at
    FROM crm_pairing_rulings
    WHERE brand_id = ${brandId}
      AND crm_contact_id = ANY(${sql.param(crmContactIds)}::text[])
      AND withdrawn_at IS NULL
  `)) as unknown as RulingRow[];
  for (const row of rows) {
    out.set(rulingKey(row.crm_contact_id, row.lead_id), {
      ruling: row.ruling as CrmPairingRulingKind,
      note: row.note,
      statedByUserId: row.stated_by_user_id,
      statedAt: toIsoTimestamp(row.updated_at) ?? "",
    });
  }
  return out;
}

export function rulingKey(crmContactId: string, leadId: string): string {
  return `${crmContactId}:${leadId}`;
}

/**
 * Record what a person said about this pairing.
 *
 * An upsert on the pair, so restating corrects rather than accumulating — and it CLEARS any
 * withdrawal, exactly as restating a step statement does: the same person is making the same
 * statement again.
 */
export async function upsertRuling(params: {
  orgId: string;
  brandId: string;
  crmContactId: string;
  leadId: string;
  ruling: CrmPairingRulingKind;
  note: string | null;
  statedByUserId: string | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO crm_pairing_rulings
      (org_id, brand_id, crm_contact_id, lead_id, ruling, note, stated_by_user_id)
    VALUES (${params.orgId}, ${params.brandId}, ${params.crmContactId}, ${params.leadId},
            ${params.ruling}, ${params.note}, ${params.statedByUserId})
    ON CONFLICT (brand_id, crm_contact_id, lead_id) DO UPDATE SET
      ruling = EXCLUDED.ruling,
      note = EXCLUDED.note,
      stated_by_user_id = EXCLUDED.stated_by_user_id,
      withdrawn_at = NULL,
      withdrawn_by_user_id = NULL,
      updated_at = now()
  `);
}

/**
 * Take a statement back. NOTHING IS DELETED — the row survives carrying both what was stated and
 * the fact that it was withdrawn. Idempotent: withdrawing an already-withdrawn statement writes
 * nothing and reports as much.
 */
export async function withdrawRuling(params: {
  brandId: string;
  crmContactId: string;
  leadId: string;
  withdrawnByUserId: string | null;
}): Promise<{ existed: boolean; alreadyWithdrawn: boolean }> {
  const existing = (await db.execute(sql`
    SELECT withdrawn_at FROM crm_pairing_rulings
    WHERE brand_id = ${params.brandId}
      AND crm_contact_id = ${params.crmContactId}
      AND lead_id = ${params.leadId}::uuid
  `)) as unknown as Array<{ withdrawn_at: Date | string | null }>;

  if (existing.length === 0) return { existed: false, alreadyWithdrawn: false };
  if (existing[0].withdrawn_at !== null) return { existed: true, alreadyWithdrawn: true };

  await db.execute(sql`
    UPDATE crm_pairing_rulings
    SET withdrawn_at = now(), withdrawn_by_user_id = ${params.withdrawnByUserId}, updated_at = now()
    WHERE brand_id = ${params.brandId}
      AND crm_contact_id = ${params.crmContactId}
      AND lead_id = ${params.leadId}::uuid
      AND withdrawn_at IS NULL
  `);
  return { existed: true, alreadyWithdrawn: false };
}

// ---------------------------------------------------------------------------
// Our side of the summary
// ---------------------------------------------------------------------------

/**
 * How many leads we served for this brand no LIVE pairing points at — "people we emailed that
 * their CRM has never heard of".
 *
 * A COUNT, never a list: a summary must not cost the population it is the size of.
 *
 * "Live" is the same reading the view serves: a pairing a human REJECTED does not make that lead
 * known to their CRM, so it is excluded here too. Defining it any other way would let the summary
 * and the table disagree about the same pair.
 */
export async function countLeadsNoCrmContactPointsAt(brandId: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT lc.lead_id)::int AS n
    FROM leads_campaigns lc
    WHERE lc.status = 'served'
      AND ${brandId} = ANY(lc.brand_ids)
      AND NOT EXISTS (
        SELECT 1
        FROM crm_pairing_matches m
        LEFT JOIN crm_pairing_rulings r
          ON r.brand_id = m.brand_id
         AND r.crm_contact_id = m.crm_contact_id
         AND r.lead_id = m.matched_lead_id
         AND r.withdrawn_at IS NULL
        WHERE m.brand_id = ${brandId}
          AND m.matched_lead_id = lc.lead_id
          AND (r.ruling IS NULL OR r.ruling <> 'rejected')
      )
  `)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}
