import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";
import { errorMessage } from "./db-error.js";
import { createRun, updateRun } from "./runs-client.js";
import { declareRunOutcomesNow, factOutcomeDeclaration, type FactOutcomeKey } from "./run-outcomes.js";

/**
 * EVERY MEETING AND SALE OUR OUTREACH CAUSED IS AN OUTCOME OCCURRENCE ON THE LEDGER (COST-ACCOUNTING-1023-P1, second
 * pass, owner 2026-10-23).
 *
 * lead-service records the facts past a conversation (a booked or attended meeting, a sale: stated by a person,
 * evidenced by the brand's CRM, reported by the website tag) in `conversion_events`, and decides WHOSE WIN each was
 * (`caused_by_outreach`, outcome-cause.ts: a person's answer, else the date rule). Each fact that is OURS
 * (`caused_by_outreach = true`, live, attributed to a lead) produces its outcome on runs-service's ledger:
 *
 *   meeting_booked / meeting_attended            -> meeting_booked / meeting_attended
 *   sale / purchase                              -> paid_client
 *
 * subject = the lead (`subjectService: "lead-service"`), as on every run of the fleet. Each CONSUMES the outcome it
 * came from (`consumedOutcomeFor`, pure): a booked meeting the person's `conversation` (a positive reply before it),
 * else their `website_visit`, else their `form_submitted`; attended consumes `meeting_booked`; paid client the last
 * of attended / booked we declared for them, else the same entry outcome. No entry evidence at all = `conversation`
 * with basis `no_evidence`: runs-service then counts it as unknown provenance (never $0, never charged), which is the
 * truth (outreach caused it, the step it went through is not seen here).
 *
 * A fact our outreach did NOT lead to (`caused_by_outreach` false or null: a "theirs", an undated or never-touched
 * person, a reply-read "already a customer") is no occurrence of ours: nothing declared.
 *
 * The run: one `outcome-recording` run per (org, brand, UTC day, OUTCOME KEY), created and closed `completed` at once,
 * no cost of its own (instantly-service's pattern for Positive reply). It is a production order that states what was
 * reached. A run NEVER produces two different outcome keys (COST-ACCOUNTING-1023-LEAD-FIX): runs-service attributes a
 * run's consumptions to the outcomes THAT RUN produced, split by quantity, so one run producing booked + attended +
 * paid charged the `meeting_attended` a paid client consumed partly to `meeting_attended` itself (a loop with no
 * finite cost; v0.83.180 did this on its first day, migration 0123 re-declared those facts on per-outcome runs).
 *
 * Once per (org, brand, lead, outcome), ever (`outcome_fact_declarations`): claimed BEFORE the declaration; a
 * declaration runs-service did not take waits in `run_outcome_outbox` (redelivered with backoff), one neither
 * delivered nor queued releases its claim and is asked again next pass. A replay of the same run is
 * `already_recorded` at runs-service.
 *
 * WITHDRAWN AFTER IT WAS DECLARED: the occurrence stays. runs-service's ledger is immutable (no withdrawal); the
 * withdrawal lives in `conversion_events` and every count here keeps honouring it. A fact that turns ours later (a
 * person states the cause) is declared on that day's run.
 *
 * Never on a write path: a background sweep (every 5 min, first pass ~60 s after boot), sequential (tens of facts).
 */

export const OUTCOME_RECORDING_TASK = "outcome-recording";
const SERVICE_NAME = "lead-service";
export const OUTCOME_FACT_SWEEP_INTERVAL_MS = 5 * 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;
const SWEEP_BATCH = 500;

/** The ledger events (conversion_events.event) each fact outcome is read off. */
export const FACT_EVENTS_OF_OUTCOME: Readonly<Record<FactOutcomeKey, readonly string[]>> = {
  meeting_booked: ["meeting_booked"],
  meeting_attended: ["meeting_attended"],
  paid_client: ["sale", "purchase"],
};

/** What we know the person reached BEFORE the fact (entry evidence) and what we already declared for them. */
export interface ConsumptionEvidence {
  positiveReply: boolean;
  websiteVisit: boolean;
  formSubmitted: boolean;
  declaredMeetingBooked: boolean;
  declaredMeetingAttended: boolean;
}

export type ConsumedBasis = "positive_reply" | "website_visit" | "form_submitted" | "meeting_booked" | "meeting_attended" | "no_evidence";

/** The one outcome a fact consumed. Pure. */
export function consumedOutcomeFor(outcome: FactOutcomeKey, e: ConsumptionEvidence): { outcomeKey: string; basis: ConsumedBasis } {
  const entry = (): { outcomeKey: string; basis: ConsumedBasis } => {
    if (e.positiveReply) return { outcomeKey: "conversation", basis: "positive_reply" };
    if (e.websiteVisit) return { outcomeKey: "website_visit", basis: "website_visit" };
    if (e.formSubmitted) return { outcomeKey: "form_submitted", basis: "form_submitted" };
    return { outcomeKey: "conversation", basis: "no_evidence" };
  };
  if (outcome === "meeting_booked") return entry();
  if (outcome === "meeting_attended") return { outcomeKey: "meeting_booked", basis: "meeting_booked" };
  if (e.declaredMeetingAttended) return { outcomeKey: "meeting_attended", basis: "meeting_attended" };
  if (e.declaredMeetingBooked) return { outcomeKey: "meeting_booked", basis: "meeting_booked" };
  return entry();
}

/** UTC calendar day `YYYY-MM-DD`. */
export function utcDay(asOf: Date): string {
  return asOf.toISOString().slice(0, 10);
}

const runMemo = new Map<string, string>();

/** Test hook. */
export function resetOutcomeRecordingRunMemo(): void {
  runMemo.clear();
}

/** The brand's recording run of the UTC day for ONE outcome key, created once (persisted, a concurrent creator's run wins). Throws. */
export async function outcomeRecordingRunFor(orgId: string, brandId: string, outcomeKey: FactOutcomeKey, asOf: Date = new Date()): Promise<string> {
  const day = utcDay(asOf);
  const key = `${orgId}|${brandId}|${day}|${outcomeKey}`;
  const cached = runMemo.get(key);
  if (cached) return cached;
  const read = async (): Promise<string | null> => {
    const rows = (await db.execute(sql`
      SELECT run_id::text AS run_id FROM outcome_recording_runs
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND day = ${day}::date AND outcome_key = ${outcomeKey}
    `)) as unknown as Array<{ run_id: string }>;
    return rows[0]?.run_id ?? null;
  };
  let runId = await read();
  if (!runId) {
    const run = await createRun({ orgId, brandId, serviceName: SERVICE_NAME, taskName: OUTCOME_RECORDING_TASK });
    await updateRun(run.id, "completed", { orgId, brandId });
    const inserted = (await db.execute(sql`
      INSERT INTO outcome_recording_runs (org_id, brand_id, day, outcome_key, run_id)
      VALUES (${orgId}, ${brandId}, ${day}::date, ${outcomeKey}, ${run.id}::uuid)
      ON CONFLICT (org_id, brand_id, day, outcome_key) DO NOTHING
      RETURNING run_id::text AS run_id
    `)) as unknown as Array<{ run_id: string }>;
    runId = inserted[0]?.run_id ?? (await read());
    if (!runId) throw new Error(`outcome_recording_runs row for ${key} vanished after a conflict`);
  }
  runMemo.set(key, runId);
  return runId;
}

interface PendingFact {
  orgId: string;
  brandId: string;
  leadId: string;
  outcomeKey: FactOutcomeKey;
  conversionEventId: string;
  at: string | null;
}

const OUTCOME_CASE = sql.raw(
  `CASE ${Object.entries(FACT_EVENTS_OF_OUTCOME)
    .map(([outcome, events]) => `WHEN ce.event IN (${events.map((e) => `'${e}'`).join(", ")}) THEN '${outcome}'`)
    .join(" ")} END`,
);
const FACT_EVENTS = Object.values(FACT_EVENTS_OF_OUTCOME).flat();
const OUTCOME_RANK = sql.raw(`CASE outcome_key WHEN 'meeting_booked' THEN 1 WHEN 'meeting_attended' THEN 2 ELSE 3 END`);

/** Our facts not declared yet: the earliest live one per (org, brand, lead, outcome), booked before attended before paid. */
export async function loadPendingFacts(scope?: { orgId: string }, limit = SWEEP_BATCH): Promise<PendingFact[]> {
  const rows = (await db.execute(sql`
    WITH facts AS (
      SELECT DISTINCT ON (ce.org_id, ce.brand_id, ce.matched_lead_id, ${OUTCOME_CASE})
             ce.org_id, ce.brand_id, ce.matched_lead_id::text AS lead_id, ${OUTCOME_CASE} AS outcome_key,
             ce.id::text AS conversion_event_id, ce.received_at
      FROM conversion_events ce
      WHERE ce.event = ANY(${sql.param(FACT_EVENTS)}::text[])
        AND ce.caused_by_outreach IS TRUE
        AND ce.withdrawn_at IS NULL AND ce.attribution_status = 'attributed' AND ce.matched_lead_id IS NOT NULL
        ${scope ? sql`AND ce.org_id = ${scope.orgId}` : sql.empty()}
      ORDER BY ce.org_id, ce.brand_id, ce.matched_lead_id, ${OUTCOME_CASE}, ce.received_at ASC NULLS LAST, ce.id
    )
    SELECT f.org_id, f.brand_id, f.lead_id, f.outcome_key, f.conversion_event_id, f.received_at::text AS at
    FROM facts f
    WHERE NOT EXISTS (
      SELECT 1 FROM outcome_fact_declarations d
      WHERE d.org_id = f.org_id AND d.brand_id = f.brand_id AND d.lead_id = f.lead_id::uuid AND d.outcome_key = f.outcome_key)
    ORDER BY ${OUTCOME_RANK}, f.received_at ASC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    orgId: String(r.org_id),
    brandId: String(r.brand_id),
    leadId: String(r.lead_id),
    outcomeKey: r.outcome_key as FactOutcomeKey,
    conversionEventId: String(r.conversion_event_id),
    at: r.at ?? null,
  }));
}

/** What the person reached before the fact at the brand (undated fact = ever), and what we already declared. */
export async function loadConsumptionEvidence(f: PendingFact): Promise<ConsumptionEvidence> {
  const before = (col: ReturnType<typeof sql.raw>) => (f.at ? sql`AND ${col} <= ${f.at}::timestamptz` : sql.empty());
  const timeline = (where: ReturnType<typeof sql>) => sql`EXISTS (
    SELECT 1 FROM lead_timeline_facts t
    WHERE t.org_id = ${f.orgId} AND t.brand_id = ${f.brandId} AND t.lead_id = ${f.leadId}::uuid AND t.withdrawn_at IS NULL
      AND ${where} ${before(sql.raw("t.occurred_at"))})`;
  const ledger = (events: string[], crmOnly: boolean) => sql`EXISTS (
    SELECT 1 FROM conversion_events c
    WHERE c.org_id = ${f.orgId} AND c.brand_id = ${f.brandId} AND c.matched_lead_id = ${f.leadId}::uuid
      AND c.event = ANY(${sql.param(events)}::text[]) AND c.withdrawn_at IS NULL AND c.attribution_status = 'attributed'
      ${crmOnly ? sql`AND c.source = 'crm'` : sql.empty()} ${before(sql.raw("c.received_at"))})`;
  const declared = (outcome: FactOutcomeKey) => sql`EXISTS (
    SELECT 1 FROM outcome_fact_declarations d
    WHERE d.org_id = ${f.orgId} AND d.brand_id = ${f.brandId} AND d.lead_id = ${f.leadId}::uuid AND d.outcome_key = ${outcome})`;
  const rows = (await db.execute(sql`
    SELECT
      (${timeline(sql`t.source = 'reply' AND t.detail->>'classification' = 'positive'`)} OR ${ledger([CRM_POSITIVE_REPLY_STEP], true)}) AS positive_reply,
      (${timeline(sql`t.label = 'website_visit'`)} OR ${ledger(["website_visit"], false)}) AS website_visit,
      (${timeline(sql`t.label = 'form_filled'`)} OR ${ledger(["form_submission"], false)}) AS form_submitted,
      ${declared("meeting_booked")} AS declared_meeting_booked,
      ${declared("meeting_attended")} AS declared_meeting_attended
  `)) as unknown as Array<Record<string, boolean>>;
  const r = rows[0];
  return {
    positiveReply: r.positive_reply === true,
    websiteVisit: r.website_visit === true,
    formSubmitted: r.form_submitted === true,
    declaredMeetingBooked: r.declared_meeting_booked === true,
    declaredMeetingAttended: r.declared_meeting_attended === true,
  };
}

export interface OutcomeFactSweepSummary {
  read: number;
  delivered: number;
  queued: number;
  refused: number;
  failed: number;
}

async function declareOne(f: PendingFact, summary: OutcomeFactSweepSummary): Promise<void> {
  let runId: string;
  let consumed: { outcomeKey: string; basis: ConsumedBasis };
  try {
    runId = await outcomeRecordingRunFor(f.orgId, f.brandId, f.outcomeKey);
    consumed = consumedOutcomeFor(f.outcomeKey, await loadConsumptionEvidence(f));
  } catch (err) {
    summary.failed++;
    console.error(`[lead-service] outcome fact NOT declared (asked again next pass): org=${f.orgId} brand=${f.brandId} lead=${f.leadId} ${f.outcomeKey}: ${errorMessage(err)}`);
    return;
  }
  // Claim first: once per (org, brand, lead, outcome), ever.
  const claimed = (await db.execute(sql`
    INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, conversion_event_id, run_id, consumed_outcome_key, consumed_basis)
    VALUES (${f.orgId}, ${f.brandId}, ${f.leadId}::uuid, ${f.outcomeKey}, ${f.conversionEventId}::uuid, ${runId}::uuid, ${consumed.outcomeKey}, ${consumed.basis})
    ON CONFLICT DO NOTHING
    RETURNING 1 AS ok
  `)) as unknown as unknown[];
  if (claimed.length === 0) return;
  const kind = await declareRunOutcomesNow(
    factOutcomeDeclaration({ orgId: f.orgId, runId, leadId: f.leadId, outcomeKey: f.outcomeKey, consumedOutcomeKey: consumed.outcomeKey }),
  );
  if (kind === "lost") {
    await db.execute(sql`
      DELETE FROM outcome_fact_declarations
      WHERE org_id = ${f.orgId} AND brand_id = ${f.brandId} AND lead_id = ${f.leadId}::uuid AND outcome_key = ${f.outcomeKey}
    `);
    summary.failed++;
    return;
  }
  if (kind === "delivered") summary.delivered++;
  else if (kind === "retry") summary.queued++;
  else summary.refused++;
}

let inFlight: Promise<OutcomeFactSweepSummary> | null = null;

/** One pass. Concurrent calls join it. `scope` is a test hook (the suite's files share one database). */
export function sweepOutcomeFactDeclarations(scope?: { orgId: string }): Promise<OutcomeFactSweepSummary> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const facts = await loadPendingFacts(scope);
    const summary: OutcomeFactSweepSummary = { read: facts.length, delivered: 0, queued: 0, refused: 0, failed: 0 };
    for (const f of facts) await declareOne(f, summary);
    if (facts.length > 0) console.log(`[lead-service] outcome fact declarations pass ${JSON.stringify(summary)}`);
    return summary;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Background thread: first pass ~60 s after boot, then every 5 min. */
export function startOutcomeFactDeclarationsWorker(): void {
  const tick = () => {
    sweepOutcomeFactDeclarations().catch((err) => console.error("[lead-service] outcome fact declarations pass failed:", err));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, OUTCOME_FACT_SWEEP_INTERVAL_MS).unref();
}
