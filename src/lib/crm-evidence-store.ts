/**
 * Where what the customer's CRM evidences is written, and the person's whose-win overrides — reads
 * and writes only. Every decision about what the evidence MEANS lives in crm-evidence.ts.
 *
 * Two stores, both the ones every step read ALREADY reads, so no consumer learns about CRMs:
 *
 *   - an OUTCOME is a `conversion_events` row, `source = 'crm'`, keyed to the PERSON
 *     (`lead_campaign_id` NULL, exactly like a tracker event) and deduped per (brand, lead, step)
 *     by `crmOutcomeSignature`. `caused_by_outreach` holds the EFFECTIVE answer (a person's
 *     override, else the rule); `crm_evidence.rule` holds the rule's own.
 *   - a NEVER is a `lead_step_disqualifications` row, `source = 'crm'`, one per campaign row of the
 *     person, because a "never" is read per (lead, campaign) — the same key a person's takes.
 *
 * NOTHING IS DELETED. Evidence that no longer holds (the pairing was rejected, the CRM event is
 * gone, a person stated the step themselves) is marked `withdrawn_at` and stood back up by the next
 * sync if it holds again. A CRM row is never written over a person's statement: the upserts only
 * update rows that are still `source = 'crm'`.
 *
 * Arrays go through `sql.param(...)` — a bare JS array does not bind in a raw `sql` template.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import {
  crmOutcomeSignature,
  type CrmCauseRule,
  type StoredCrmEvidence,
} from "./crm-evidence.js";

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export interface CrmOutcomeWrite {
  orgId: string;
  brandId: string;
  leadId: string;
  step: string;
  occurredAt: string | null;
  valueCents: number | null;
  causedByOutreach: boolean | null;
  email: string | null;
  matchMethod: string | null;
  matchConfidence: string;
  candidateCount: number;
  evidence: StoredCrmEvidence;
}

/**
 * Write (or stand back up) one CRM-evidenced outcome. A row a person has since restated under the
 * same signature cannot exist (the signatures are disjoint), and a row that is somehow not `crm`
 * is never overwritten.
 */
export async function upsertCrmOutcome(w: CrmOutcomeWrite): Promise<void> {
  await db.execute(sql`
    INSERT INTO conversion_events (
      brand_id, org_id, event, email, dedupe_signature, value_cents, caused_by_outreach,
      matched_lead_id, match_method, match_confidence, attribution_status, candidate_count,
      received_at, source, crm_evidence
    ) VALUES (
      ${w.brandId}, ${w.orgId}, ${w.step}, ${w.email}, ${crmOutcomeSignature(w.leadId, w.step)},
      ${w.valueCents}, ${w.causedByOutreach}, ${w.leadId}, ${w.matchMethod}, ${w.matchConfidence},
      'attributed', ${w.candidateCount}, ${w.occurredAt}, 'crm', ${JSON.stringify(w.evidence)}::jsonb
    )
    ON CONFLICT (brand_id, dedupe_signature) WHERE dedupe_signature IS NOT NULL DO UPDATE SET
      value_cents = EXCLUDED.value_cents,
      caused_by_outreach = EXCLUDED.caused_by_outreach,
      email = EXCLUDED.email,
      matched_lead_id = EXCLUDED.matched_lead_id,
      match_method = EXCLUDED.match_method,
      match_confidence = EXCLUDED.match_confidence,
      candidate_count = EXCLUDED.candidate_count,
      received_at = EXCLUDED.received_at,
      crm_evidence = EXCLUDED.crm_evidence,
      withdrawn_at = NULL,
      withdrawn_by_user_id = NULL
    WHERE conversion_events.source = 'crm'
  `);
}

/**
 * Set aside every live CRM-evidenced outcome of this brand whose signature is not in `keep`.
 * Returns how many were set aside.
 */
export async function withdrawStaleCrmOutcomes(brandId: string, keep: string[]): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE conversion_events
    SET withdrawn_at = now()
    WHERE brand_id = ${brandId}
      AND source = 'crm'
      AND withdrawn_at IS NULL
      AND NOT (dedupe_signature = ANY(${sql.param(keep)}::text[]))
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length;
}

/**
 * A person (or the tracker) stated this step for this person: the CRM row for it is set aside so
 * the two never both count. Called on the statement write; the sync keeps it aside while the
 * statement stands, and stands it back up once it no longer does.
 */
export async function supersedeCrmOutcome(
  brandId: string,
  leadId: string,
  step: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE conversion_events
    SET withdrawn_at = now()
    WHERE brand_id = ${brandId}
      AND source = 'crm'
      AND matched_lead_id = ${leadId}
      AND event = ${step}
      AND withdrawn_at IS NULL
  `);
}

/** Every (lead, step) of these leads with a live outcome NOT from the CRM — what outranks it. */
export async function loadNonCrmOutcomeKeys(
  brandId: string,
  leadIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT matched_lead_id, event
    FROM conversion_events
    WHERE brand_id = ${brandId}
      AND matched_lead_id = ANY(${sql.param(leadIds)}::uuid[])
      AND source <> 'crm'
      AND attribution_status = 'attributed'
      AND withdrawn_at IS NULL
  `)) as unknown as Array<{ matched_lead_id: string; event: string }>;
  for (const r of rows) out.add(`${r.matched_lead_id}:${r.event === "purchase" ? "sale" : r.event}`);
  return out;
}

// ---------------------------------------------------------------------------
// Nevers
// ---------------------------------------------------------------------------

export interface LeadCampaignRowRef {
  id: string;
  leadId: string;
  campaignId: string;
}

/** Every campaign row of these people in this brand — a "never" is read per (lead, campaign). */
export async function loadLeadCampaignRows(
  brandId: string,
  leadIds: string[],
): Promise<Map<string, LeadCampaignRowRef[]>> {
  const out = new Map<string, LeadCampaignRowRef[]>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, lead_id, campaign_id
    FROM leads_campaigns
    WHERE lead_id = ANY(${sql.param(leadIds)}::uuid[])
      AND ${brandId} = ANY(brand_ids)
  `)) as unknown as Array<{ id: string; lead_id: string; campaign_id: string }>;
  for (const r of rows) {
    const ref = { id: r.id, leadId: r.lead_id, campaignId: r.campaign_id };
    const list = out.get(r.lead_id);
    if (list) list.push(ref);
    else out.set(r.lead_id, [ref]);
  }
  return out;
}

export interface CrmNeverWrite {
  orgId: string;
  brandId: string;
  row: LeadCampaignRowRef;
  step: string;
  occurredAt: string | null;
  evidence: StoredCrmEvidence;
}

/**
 * Write (or stand back up) a CRM-evidenced "never" on one campaign row. A person's own "never" on
 * the same (lead, campaign, step) is left exactly as they stated it. Returns the row id when this
 * row is (still) the CRM's, null when a person's statement holds the key.
 */
export async function upsertCrmNever(w: CrmNeverWrite): Promise<string | null> {
  const rows = (await db.execute(sql`
    INSERT INTO lead_step_disqualifications (
      lead_id, lead_campaign_id, campaign_id, brand_id, org_id, step, source, occurred_at,
      crm_evidence
    ) VALUES (
      ${w.row.leadId}, ${w.row.id}, ${w.row.campaignId}, ${w.brandId}, ${w.orgId}, ${w.step}, 'crm',
      ${w.occurredAt}, ${JSON.stringify(w.evidence)}::jsonb
    )
    ON CONFLICT (lead_id, campaign_id, step) DO UPDATE SET
      occurred_at = EXCLUDED.occurred_at,
      crm_evidence = EXCLUDED.crm_evidence,
      lead_campaign_id = EXCLUDED.lead_campaign_id,
      brand_id = EXCLUDED.brand_id,
      -- A CRM "never" set aside because its evidence stopped holding stands again. One an outcome
      -- RETRACTED stays retracted: that is the funnel resolving a contradiction, not the sync's call.
      withdrawn_at = NULL,
      withdrawn_by_user_id = NULL,
      updated_at = now()
    WHERE lead_step_disqualifications.source = 'crm'
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** Set aside every live CRM "never" of this brand not in `keep`. Returns how many. */
export async function withdrawStaleCrmNevers(brandId: string, keep: string[]): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE lead_step_disqualifications
    SET withdrawn_at = now(), updated_at = now()
    WHERE brand_id = ${brandId}
      AND source = 'crm'
      AND withdrawn_at IS NULL
      AND NOT (id = ANY(${sql.param(keep)}::uuid[]))
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Whose win — a person's override
// ---------------------------------------------------------------------------

export interface CauseStatement {
  causedByOutreach: boolean;
  note: string | null;
  statedByUserId: string | null;
  statedAt: string | null;
}

/** Live overrides for these people, keyed `<leadId>:<step>`. */
export async function loadCauseStatements(
  brandId: string,
  leadIds: string[],
): Promise<Map<string, CauseStatement>> {
  const out = new Map<string, CauseStatement>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT lead_id, step, caused_by_outreach, note, stated_by_user_id, updated_at
    FROM lead_step_cause_statements
    WHERE brand_id = ${brandId}
      AND lead_id = ANY(${sql.param(leadIds)}::uuid[])
      AND withdrawn_at IS NULL
  `)) as unknown as Array<{
    lead_id: string;
    step: string;
    caused_by_outreach: boolean;
    note: string | null;
    stated_by_user_id: string | null;
    updated_at: Date | string | null;
  }>;
  for (const r of rows) {
    out.set(`${r.lead_id}:${r.step}`, {
      causedByOutreach: r.caused_by_outreach,
      note: r.note,
      statedByUserId: r.stated_by_user_id,
      statedAt: toIsoTimestamp(r.updated_at),
    });
  }
  return out;
}

export async function upsertCauseStatement(w: {
  orgId: string;
  brandId: string;
  leadId: string;
  step: string;
  causedByOutreach: boolean;
  note: string | null;
  statedByUserId: string | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO lead_step_cause_statements (
      org_id, brand_id, lead_id, step, caused_by_outreach, note, stated_by_user_id
    ) VALUES (
      ${w.orgId}, ${w.brandId}, ${w.leadId}, ${w.step}, ${w.causedByOutreach}, ${w.note},
      ${w.statedByUserId}
    )
    ON CONFLICT (brand_id, lead_id, step) DO UPDATE SET
      caused_by_outreach = EXCLUDED.caused_by_outreach,
      note = EXCLUDED.note,
      stated_by_user_id = EXCLUDED.stated_by_user_id,
      withdrawn_at = NULL,
      withdrawn_by_user_id = NULL,
      updated_at = now()
  `);
}

/** Returns true when a live override was withdrawn, false when there was none (idempotent). */
export async function withdrawCauseStatement(
  brandId: string,
  leadId: string,
  step: string,
  withdrawnBy: string | null,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    UPDATE lead_step_cause_statements
    SET withdrawn_at = now(), withdrawn_by_user_id = ${withdrawnBy}, updated_at = now()
    WHERE brand_id = ${brandId}
      AND lead_id = ${leadId}
      AND step = ${step}
      AND withdrawn_at IS NULL
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/** The live CRM-evidenced outcome for one person and step, with its stored evidence. */
export interface LiveCrmOutcome {
  id: string;
  occurredAt: string | null;
  valueCents: number | null;
  causedByOutreach: boolean | null;
  evidence: StoredCrmEvidence;
}

export async function loadLiveCrmOutcomes(
  brandId: string,
  leadId: string,
): Promise<Map<string, LiveCrmOutcome>> {
  const rows = (await db.execute(sql`
    SELECT id, event, received_at, value_cents, caused_by_outreach, crm_evidence
    FROM conversion_events
    WHERE brand_id = ${brandId}
      AND matched_lead_id = ${leadId}
      AND source = 'crm'
      AND withdrawn_at IS NULL
  `)) as unknown as Array<{
    id: string;
    event: string;
    received_at: Date | string | null;
    value_cents: number | null;
    caused_by_outreach: boolean | null;
    crm_evidence: StoredCrmEvidence | string | null;
  }>;
  const out = new Map<string, LiveCrmOutcome>();
  for (const r of rows) {
    const evidence =
      typeof r.crm_evidence === "string"
        ? (JSON.parse(r.crm_evidence) as StoredCrmEvidence)
        : (r.crm_evidence as StoredCrmEvidence);
    out.set(r.event, {
      id: r.id,
      occurredAt: toIsoTimestamp(r.received_at),
      valueCents: r.value_cents,
      causedByOutreach: r.caused_by_outreach,
      evidence,
    });
  }
  return out;
}

/** Re-point one CRM outcome's effective answer (after a person states or withdraws an override). */
export async function setCrmOutcomeCause(id: string, causedByOutreach: boolean | null): Promise<void> {
  await db.execute(sql`
    UPDATE conversion_events
    SET caused_by_outreach = ${causedByOutreach}
    WHERE id = ${id} AND source = 'crm'
  `);
}

export type { CrmCauseRule };
