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
 *   - The rule reads the PERSON's steps, not the row alone (outcome-cause-coherence.ts,
 *     DIGEST-SALES-ATTRIB-1105): a step after one of theirs that was not ours is not ours either, an
 *     undated step is ours only when everything we know of the person came through us.
 *
 * `OUTCOME_CAUSE_INTERVAL_MS` IS the bound on how long a new unanswered outcome reads null before
 * the rule answers it, and on how long a row keeps an answer another step of the person moved. Every
 * unanswered row is re-decided each sweep (the brand's ledger is small: 507 rows fleet-wide on
 * 2026-11-05); a lead's first touch stated by a final answer is never asked again, because a first
 * delivery cannot move.
 */
import { errorMessage } from "./db-error.js";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { loadCauseStatements } from "./crm-evidence-store.js";
import {
  CROSS_STEP_REASONS,
  coherentCauseRule,
  sameCoherentRule,
  type CauseAnchorStep,
  type CoherentCauseReason,
  type PersonStep,
} from "./outcome-cause-coherence.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";
import { flattenBrandStatus } from "./delivery-flatten.js";
import { withFirstChannelSends } from "./first-touch.js";
import { toIsoTimestamp } from "./basic-leads.js";

export type OutcomeCauseReason = CoherentCauseReason | "not_matched";

/** What `cause_rule` holds: the rule's answer, why, and the inputs it was computed from. */
export interface StoredOutcomeCauseRule {
  causedByOutreach: boolean | null;
  reason: OutcomeCauseReason;
  firstDeliveredAt: string | null;
  /** The lead the outcome is ATTRIBUTED to (null when it is not attributed to anyone). */
  leadId: string | null;
  occurredAt: string | null;
  /** The person's step the answer leans on (cross-step reasons only: outcome-cause-coherence.ts). */
  afterStep?: CauseAnchorStep;
}

/**
 * The rule for one outcome. The CRM path's rule read across the person's steps (`coherentCauseRule`:
 * a step after one of theirs that was not ours is not ours either) plus one precondition the CRM path
 * never needs (its rows are paired to a lead by construction): an outcome nobody could attribute to
 * one of our leads has nobody we could have emailed, so it is undecided. With no `person` given, the
 * outcome is judged alone (the date rule).
 */
export function outcomeCauseRule(
  input: { leadId: string | null; occurredAt: string | null },
  firstDeliveredAt: string | null,
  person?: { key: string; event: string; steps: readonly PersonStep[] },
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
  const rule = coherentCauseRule(
    { key: person?.key ?? "", event: person?.event ?? "", occurredAt: input.occurredAt },
    person?.steps ?? [],
    firstDeliveredAt,
  );
  return { ...rule, leadId: input.leadId, occurredAt: input.occurredAt };
}

/** A pending row as the sweep reads it. */
export interface PendingOutcomeRow {
  id: string;
  event?: string;
  leadId: string | null;
  occurredAt: string | null;
  causedByOutreach: boolean | null;
  causeRule: StoredOutcomeCauseRule | null;
}

function sameRule(a: StoredOutcomeCauseRule | null, b: StoredOutcomeCauseRule): boolean {
  return (
    a !== null &&
    sameCoherentRule(a as Parameters<typeof sameCoherentRule>[0], b as Parameters<typeof sameCoherentRule>[1]) &&
    a.leadId === b.leadId &&
    a.occurredAt === b.occurredAt
  );
}

/** Reasons that state a FINAL first touch of the lead (a first delivery cannot move once it happened). */
const FIRST_TOUCH_KNOWN_REASONS: ReadonlySet<string> = new Set<string>([
  "after_first_delivery",
  "before_first_delivery",
  ...CROSS_STEP_REASONS,
]);

/**
 * The work list: every live, non-CRM outcome no person answered. Whose win one step was depends on the
 * person's OTHER steps (outcome-cause-coherence.ts), which any source can add or take back at any time,
 * so every such row is re-decided each sweep; an unchanged answer writes nothing, and a lead's first
 * touch already stated by a final answer is never asked again (no email-gateway call for it).
 */
const PENDING = sql`
  source <> 'crm'
  AND withdrawn_at IS NULL
  AND stated_caused_by_outreach IS NULL
`;

export async function listPendingCauseBrands(): Promise<Array<{ orgId: string; brandId: string }>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id, brand_id FROM conversion_events WHERE ${PENDING}
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}

async function loadPendingRows(orgId: string, brandId: string): Promise<PendingOutcomeRow[]> {
  const rows = (await db.execute(sql`
    SELECT id, event,
           CASE WHEN attribution_status = 'attributed' THEN matched_lead_id::text END AS lead_id,
           received_at, caused_by_outreach, cause_rule
    FROM conversion_events
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND ${PENDING}
  `)) as unknown as Array<{
    id: string;
    event: string;
    lead_id: string | null;
    received_at: Date | string | null;
    caused_by_outreach: boolean | null;
    cause_rule: StoredOutcomeCauseRule | string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    leadId: r.lead_id,
    occurredAt: toIsoTimestamp(r.received_at),
    causedByOutreach: r.caused_by_outreach,
    causeRule:
      typeof r.cause_rule === "string"
        ? (JSON.parse(r.cause_rule) as StoredOutcomeCauseRule)
        : r.cause_rule,
  }));
}

/** Every live outcome of these leads at the brand (any source), as the cross-step rule reads them. */
export interface PersonOutcomes {
  steps: Map<string, PersonStep[]>;
  /** A lead's first touch as a FINAL stored answer already states it. */
  knownFirstTouch: Map<string, string>;
  /** Leads holding at least one dated outcome (only those need a first touch). */
  dated: Set<string>;
}

export async function loadPersonOutcomes(
  orgId: string,
  brandId: string,
  leadIds: string[],
  opts: { excludeCrm?: boolean } = {},
): Promise<PersonOutcomes> {
  const out: PersonOutcomes = { steps: new Map(), knownFirstTouch: new Map(), dated: new Set() };
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT id, event, source, matched_lead_id::text AS lead_id, received_at,
           stated_caused_by_outreach,
           COALESCE(cause_rule, crm_evidence->'rule') AS rule,
           cause_rule->>'leadId' AS rule_lead_id
    FROM conversion_events
    WHERE org_id = ${orgId}
      AND brand_id = ${brandId}
      AND attribution_status = 'attributed'
      AND matched_lead_id = ANY(${sql.param(leadIds)}::uuid[])
      AND withdrawn_at IS NULL
  `)) as unknown as Array<{
    id: string;
    event: string;
    source: string;
    lead_id: string;
    received_at: Date | string | null;
    stated_caused_by_outreach: boolean | null;
    rule: { reason?: string; firstDeliveredAt?: string | null } | string | null;
    rule_lead_id: string | null;
  }>;
  const crmLeads = rows.filter((r) => r.source === "crm").map((r) => r.lead_id);
  const statements = crmLeads.length > 0 ? await loadCauseStatements(brandId, Array.from(new Set(crmLeads))) : new Map();
  for (const r of rows) {
    if (opts.excludeCrm && r.source === "crm") continue;
    const occurredAt = toIsoTimestamp(r.received_at);
    const personCause =
      r.source === "crm"
        ? (statements.get(`${r.lead_id}:${r.event}`)?.causedByOutreach ?? null)
        : r.stated_caused_by_outreach;
    const list = out.steps.get(r.lead_id) ?? [];
    list.push({ key: r.id, event: r.event, occurredAt, personCause });
    out.steps.set(r.lead_id, list);
    if (occurredAt !== null) out.dated.add(r.lead_id);
    const rule = typeof r.rule === "string" ? (JSON.parse(r.rule) as { reason?: string; firstDeliveredAt?: string | null }) : r.rule;
    if (
      rule?.reason &&
      FIRST_TOUCH_KNOWN_REASONS.has(rule.reason) &&
      rule.firstDeliveredAt &&
      (r.rule_lead_id === null || r.rule_lead_id === r.lead_id)
    ) {
      out.knownFirstTouch.set(r.lead_id, rule.firstDeliveredAt);
    }
  }
  return out;
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

/** Our first touch of each lead at BRAND scope (delivered email or a non-email pipe send); null when none. */
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
  // A lead with no registered email is somebody we could not have emailed.
  for (const id of leadIds) {
    const email = emails.get(id);
    out.set(id, email ? (byEmail.get(email) ?? null) : null);
  }
  // Our first touch on ANY channel a pipe sends on (first-touch.ts): a WhatsApp send counts like a delivered email.
  return withFirstChannelSends(orgId, brandId, leadIds, out);
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
  const rows = await loadPendingRows(orgId, brandId);
  const leadIds = Array.from(new Set(rows.filter((r) => r.leadId !== null).map((r) => r.leadId as string)));
  const person = await loadPersonOutcomes(orgId, brandId, leadIds);
  // Only a lead holding a dated outcome needs our first touch; one a final answer already states is not asked.
  const toAsk = leadIds.filter((id) => person.dated.has(id) && !person.knownFirstTouch.has(id));
  const delivered: Map<string, string | null> =
    toAsk.length > 0 ? await firstDeliveries(orgId, brandId, toAsk) : new Map();
  for (const [id, at] of person.knownFirstTouch) delivered.set(id, at);

  let updated = 0;
  for (const row of rows) {
    const rule = outcomeCauseRule(
      row,
      row.leadId ? (delivered.get(row.leadId) ?? null) : null,
      row.leadId
        ? { key: row.id, event: row.event ?? "", steps: person.steps.get(row.leadId) ?? [] }
        : undefined,
    );
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
            `outcomes stay as they were: ${errorMessage(error)}`,
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
