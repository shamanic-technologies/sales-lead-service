/**
 * WHOSE WIN an outcome was, for every outcome nobody answered — whatever wrote it.
 *
 * The owner's default rule ("after our first delivered email to that person -> ours; before -> not
 * ours; undated or never delivered -> undecided") used to apply to CRM-evidenced outcomes only
 * (crm-evidence-sync.ts). Every other outcome nobody answered — a tracker signup matched to a lead we
 * emailed, a hand-stated meeting whose author gave no cause — stayed null, so the leads panel said
 * "Ours" on a CRM step while the return on our outreach could not count the same kind of fact from
 * any other source. One rule, one place: this module applies `crmCauseRule` itself, unchanged, to
 * every non-CRM row.
 *
 * Load-bearing:
 *   - A PERSON's answer always outranks the rule. It lives in `stated_caused_by_outreach` and this
 *     module never touches a row that carries one (every write is guarded on it being NULL).
 *     Restating an outcome without a cause returns it to the rule (step-statements.ts).
 *   - The rule never answers "ours" by default: an outcome that is undated, not attributed to a lead
 *     (`not_matched`), or on a lead we never delivered to stays null, with its reason stored.
 *   - `caused_by_outreach` holds the EFFECTIVE answer, which is what every consumer already reads
 *     (`byCause` on /conversion-counts, `causedByOutreach` on /converted-leads, a closed deal on the
 *     leads list) — so their shape does not move, only previously-unanswered rows fill in.
 *   - `cause_rule` keeps the rule's answer, its reason and the inputs it was computed from, so a
 *     reader can see WHY, exactly as `crm_evidence.rule` does for a CRM row.
 *   - Nothing is fabricated when a sibling cannot answer: email-gateway failing leaves the brand's
 *     rows exactly as they were (null stays null) and is logged; the next sweep retries.
 *
 * `OUTCOME_CAUSE_INTERVAL_MS` IS the bound on how long a new unanswered outcome reads null before
 * the rule answers it. An answer that can still move — never delivered yet (we may email them
 * later), not attributed yet (a match can be resolved later) — is re-evaluated on every sweep; a
 * dated answer against a delivery is final, because a first delivery cannot move.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { crmCauseRule, type CrmCauseRuleReason } from "./crm-evidence.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";
import { flattenBrandStatus } from "./delivery-flatten.js";
import { toIsoTimestamp } from "./basic-leads.js";

export type OutcomeCauseReason = CrmCauseRuleReason | "not_matched";

/** What `cause_rule` holds: the rule's answer, why, and the inputs it was computed from. */
export interface StoredOutcomeCauseRule {
  causedByOutreach: boolean | null;
  reason: OutcomeCauseReason;
  firstDeliveredAt: string | null;
  /** The lead the outcome is ATTRIBUTED to (null when it is not attributed to anyone). */
  leadId: string | null;
  occurredAt: string | null;
}

/** Reasons whose answer can still change on a later sweep. */
const OPEN_REASONS: readonly OutcomeCauseReason[] = ["never_delivered", "not_matched"];

/**
 * The rule for one outcome. Identical to the CRM path's (`crmCauseRule`) plus one precondition the
 * CRM path never needs (its rows are paired to a lead by construction): an outcome nobody could
 * attribute to one of our leads has nobody we could have emailed, so it is undecided.
 */
export function outcomeCauseRule(
  input: { leadId: string | null; occurredAt: string | null },
  firstDeliveredAt: string | null,
): StoredOutcomeCauseRule {
  if (input.leadId === null) {
    return {
      causedByOutreach: null,
      reason: "not_matched",
      firstDeliveredAt: null,
      leadId: null,
      occurredAt: input.occurredAt,
    };
  }
  const rule = crmCauseRule(input.occurredAt, firstDeliveredAt);
  return { ...rule, leadId: input.leadId, occurredAt: input.occurredAt };
}

/** A pending row as the sweep reads it. */
export interface PendingOutcomeRow {
  id: string;
  leadId: string | null;
  occurredAt: string | null;
  causedByOutreach: boolean | null;
  causeRule: StoredOutcomeCauseRule | null;
}

/** Only an attributed, dated outcome needs our first delivery to be answered. */
export function needsFirstDelivery(row: Pick<PendingOutcomeRow, "leadId" | "occurredAt">): boolean {
  return row.leadId !== null && row.occurredAt !== null;
}

/**
 * Whether a row's stored answer still stands without asking anything: its inputs are unchanged and
 * the reason it gave cannot move.
 */
export function ruleIsSettled(row: PendingOutcomeRow): boolean {
  const r = row.causeRule;
  if (!r) return false;
  if (OPEN_REASONS.includes(r.reason)) return false;
  if (r.leadId !== row.leadId || r.occurredAt !== row.occurredAt) return false;
  return row.causedByOutreach === r.causedByOutreach;
}

function sameRule(a: StoredOutcomeCauseRule | null, b: StoredOutcomeCauseRule): boolean {
  return (
    a !== null &&
    a.causedByOutreach === b.causedByOutreach &&
    a.reason === b.reason &&
    a.firstDeliveredAt === b.firstDeliveredAt &&
    a.leadId === b.leadId &&
    a.occurredAt === b.occurredAt
  );
}

/**
 * The work list, as one SQL predicate so the brand listing and the per-brand read agree: live,
 * non-CRM outcomes no person answered whose rule answer is missing, open, stale against the row's
 * attribution, or not what the row carries.
 */
const PENDING = sql`
  source <> 'crm'
  AND withdrawn_at IS NULL
  AND stated_caused_by_outreach IS NULL
  AND (
    cause_rule IS NULL
    OR cause_rule->>'reason' IN ('never_delivered', 'not_matched')
    OR (cause_rule->>'leadId') IS DISTINCT FROM
       (CASE WHEN attribution_status = 'attributed' THEN matched_lead_id::text END)
    OR caused_by_outreach IS DISTINCT FROM (cause_rule->>'causedByOutreach')::boolean
  )
`;

export async function listPendingCauseBrands(): Promise<Array<{ orgId: string; brandId: string }>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id, brand_id FROM conversion_events WHERE ${PENDING}
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}

async function loadPendingRows(brandId: string): Promise<PendingOutcomeRow[]> {
  const rows = (await db.execute(sql`
    SELECT id,
           CASE WHEN attribution_status = 'attributed' THEN matched_lead_id::text END AS lead_id,
           received_at, caused_by_outreach, cause_rule
    FROM conversion_events
    WHERE brand_id = ${brandId} AND ${PENDING}
  `)) as unknown as Array<{
    id: string;
    lead_id: string | null;
    received_at: Date | string | null;
    caused_by_outreach: boolean | null;
    cause_rule: StoredOutcomeCauseRule | string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    occurredAt: toIsoTimestamp(r.received_at),
    causedByOutreach: r.caused_by_outreach,
    causeRule:
      typeof r.cause_rule === "string"
        ? (JSON.parse(r.cause_rule) as StoredOutcomeCauseRule)
        : r.cause_rule,
  }));
}

async function primaryEmails(leadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (lead_id) lead_id::text AS lead_id, lower(value) AS email
    FROM lead_contact_methods
    WHERE lead_id = ANY(${sql.param(leadIds)}::uuid[]) AND channel = 'email'
    ORDER BY lead_id, created_at ASC NULLS LAST, value ASC
  `)) as unknown as Array<{ lead_id: string; email: string }>;
  for (const r of rows) out.set(r.lead_id, r.email);
  return out;
}

const GATEWAY_BATCH = 100;

/** Our first delivered email to each lead at BRAND scope; null when never delivered. */
async function firstDeliveries(
  orgId: string,
  brandId: string,
  leadIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const emails = await primaryEmails(leadIds);
  const list = Array.from(new Set(emails.values()));
  const byEmail = new Map<string, string | null>();
  for (let i = 0; i < list.length; i += GATEWAY_BATCH) {
    const chunk = list.slice(i, i + GATEWAY_BATCH);
    const status = await checkDeliveryStatus(
      brandId,
      undefined,
      chunk.map((email) => ({ email })),
      { orgId, brandId },
    );
    for (const r of status.results) {
      byEmail.set(r.email.toLowerCase(), flattenBrandStatus(r).firstDeliveredAt);
    }
  }
  // A lead with no registered email is somebody we could not have delivered to.
  for (const id of leadIds) {
    const email = emails.get(id);
    out.set(id, email ? (byEmail.get(email) ?? null) : null);
  }
  return out;
}

export interface OutcomeCauseSweepResult {
  brandId: string;
  pending: number;
  updated: number;
}

/** Apply the rule to one brand's unanswered outcomes. Throws when email-gateway cannot answer. */
export async function applyOutcomeCauseRule(
  orgId: string,
  brandId: string,
): Promise<OutcomeCauseSweepResult> {
  const rows = (await loadPendingRows(brandId)).filter((r) => !ruleIsSettled(r));
  const leadIds = Array.from(
    new Set(rows.filter(needsFirstDelivery).map((r) => r.leadId as string)),
  );
  const delivered = leadIds.length > 0 ? await firstDeliveries(orgId, brandId, leadIds) : new Map();

  let updated = 0;
  for (const row of rows) {
    const rule = outcomeCauseRule(row, row.leadId ? (delivered.get(row.leadId) ?? null) : null);
    if (row.causedByOutreach === rule.causedByOutreach && sameRule(row.causeRule, rule)) continue;
    // Guarded on nobody having answered meanwhile: a person's statement always wins.
    const res = (await db.execute(sql`
      UPDATE conversion_events
      SET caused_by_outreach = ${rule.causedByOutreach},
          cause_rule = ${JSON.stringify(rule)}::jsonb
      WHERE id = ${row.id}
        AND source <> 'crm'
        AND stated_caused_by_outreach IS NULL
        AND withdrawn_at IS NULL
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    updated += res.length;
  }
  return { brandId, pending: rows.length, updated };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export const OUTCOME_CAUSE_INTERVAL_MS = 5 * 60_000;
const FIRST_SWEEP_DELAY_MS = 45_000;

let sweeping = false;

/** One pass over every brand with work. The mutex lives here, so no two passes overlap. */
export async function sweepOutcomeCauses(): Promise<OutcomeCauseSweepResult[]> {
  if (sweeping) return [];
  sweeping = true;
  const results: OutcomeCauseSweepResult[] = [];
  try {
    for (const { orgId, brandId } of await listPendingCauseBrands()) {
      try {
        const r = await applyOutcomeCauseRule(orgId, brandId);
        results.push(r);
        if (r.updated > 0) {
          console.log(`[outcome-cause] brand=${brandId} pending=${r.pending} updated=${r.updated}`);
        }
      } catch (error) {
        console.error(
          `[outcome-cause] brand=${brandId} org=${orgId} could not be evaluated, so its unanswered ` +
            `outcomes stay as they were: ${(error as Error).message}`,
        );
      }
    }
  } finally {
    sweeping = false;
  }
  return results;
}

export function startOutcomeCauseWorker(): void {
  const tick = () => {
    sweepOutcomeCauses().catch((error) => console.error("[outcome-cause] sweep failed:", error));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, OUTCOME_CAUSE_INTERVAL_MS).unref();
}
