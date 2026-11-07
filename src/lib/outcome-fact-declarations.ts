import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { CRM_POSITIVE_REPLY_STEP, crmFactLedgerOutcome } from "./crm-evidence.js";
import { errorMessage } from "./db-error.js";
import { createRun, updateRun } from "./runs-client.js";
import { RUNS_SERVICE_API_KEY, RUNS_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { STEP_REACHED_EVIDENCE, rowReaches } from "./step-reached.js";
import {
  declareRunOutcomesNow,
  FACT_OUTCOME_KEYS,
  factOutcomeDeclaration,
  OUTCOME_SUBJECT_SERVICE,
  type FactOutcomeKey,
  type OutcomePerformer,
} from "./run-outcomes.js";

/**
 * EVERY FACT OUR OUTREACH CAUSED IS AN OUTCOME OCCURRENCE ON THE LEDGER (COST-ACCOUNTING-1023-P1, second pass, owner
 * 2026-10-23; widened to every fact this service records by LEDGER-HISTORY-1024, owner 2026-10-24: « Passe tout d'un
 * coup au même régime: website visits etc »).
 *
 * lead-service records the facts past a conversation (a booked or attended meeting, a sale: stated by a person,
 * evidenced by the brand's CRM, reported by the website tag) in `conversion_events`, and decides WHOSE WIN each was
 * (`caused_by_outreach`, outcome-cause.ts: a person's answer, else the date rule). Each fact that is OURS
 * (`caused_by_outreach = true`, live, attributed to a lead) produces its outcome on runs-service's ledger:
 *
 *   website_visit (stated by hand)               -> website_visit
 *   signup                                       -> signup
 *   form_submission                              -> form_submitted
 *   sale / purchase the website tag reported     -> purchase (Direct purchase) AND paid_client
 *   meeting_booked / meeting_attended            -> meeting_booked / meeting_attended
 *   sale / purchase                              -> paid_client
 *
 * A hand-stated visit of a lead whose click OUR tracker measured (a live `website_visit` timeline fact from the
 * outreach copy) is the same visit: the measuring service's occurrence, never declared here (the rule every visit
 * count applies: `website_visit` here = visits known only by hand). Same for a lead whose visit through one of our
 * posts' links was declared by the post-touch run (post-touch.ts), and a later signup / form / purchase CONSUMES that
 * visit (`websiteVisit` evidence): the link to the publishing run.
 *
 * subject = the lead (`subjectService: "lead-service"`), as on every run of the fleet. Each CONSUMES the outcome it
 * came from (`consumedOutcomeFor`, pure): a website visit the `message_sent` our outreach reached them with (a fact is
 * ours only after our first touch: outcome-cause.ts); a signup, a form or a direct purchase the person's
 * `website_visit` before it, else their `conversation`, else the `message_sent`; a booked meeting the person's
 * `conversation` (a positive reply before it), else their `website_visit`, else their `form_submitted`; attended
 * consumes the `meeting_booked` we declared, else the entry outcome; paid client the direct purchase we declared, else the last of attended / booked, else
 * the same entry outcome. No entry evidence at all = `conversation`
 * with basis `no_evidence`: runs-service then counts it as unknown provenance (never $0, never charged), which is the
 * truth (outreach caused it, the step it went through is not seen here).
 *
 * EVERY UNIT, WHOEVER MADE IT (LEDGER-DECLARE-1107, owner 2026-11-07: « ON VEUT LE TOTAL ET LES STATS PAR OUTCOME …
 * INDEPENDAMMENT DES SOURCES »; every figure is read off the ledger). A lead outcome is a STATE reached once per (org,
 * brand, lead), dated at its FIRST reach, whoever caused it. Its cause is the first reach's (`caused_by_outreach` of the
 * earliest live ledger row). A Unit our outreach did NOT cause (false or null: a "theirs", an undated or never-touched
 * person, a reply-read "already a customer") is declared too, CONSUMING NOTHING (none of our cost, the doctrine: another
 * factory made it) and naming its attester as performer (`crm` + the tool, `tracker`, a person = `client_team`), never
 * one of our scripts. A reach the brand's CRM states that no ledger row holds yet (the contact is not paired: crm-evidence
 * only writes paired contacts) is read off the CRM fact copy: a fact type counts as the outcome the CRM sync records it
 * as on a paired contact (a signup, a meeting, a sale or a payment that stands; a form is a positive reply there, a
 * session is no ledger row: neither reaches anything here), for the lead holding the fact's address at the brand, and
 * declared the same way (its cause is unknown here: consumes nothing). A Unit declared as theirs that the cause rule later calls
 * OURS (the earliest ledger row turns `caused_by_outreach = true`) takes its consumption and our performer on the SAME
 * occurrence (`upgradeToOurs`, runs-service batch `correctPerformer`); never the other way (the ledger is immutable).
 *
 * DATED ON THE DAY IT HAPPENED (MEETING-DATED-OCCURRENCES-1024, owner 2026-10-24: the cost of a meeting OVER TIME is
 * read on the ledger "as of day D"): each occurrence is declared with `occurredAt` = the fact's own instant
 * (`conversion_events.received_at`, never after now), on the recording run of the FACT's UTC day. runs-service accepts a
 * past instant on a run with no cost and no child run, declared by its own service (`x-service-name`); a recording run
 * is exactly that. An undated fact is declared on time, on today's run. Declarations made before this rule (all on
 * 2026-10-23 runs) are moved to their instant ONCE by `redateUndatedDeclarations` (runs-service's batch door,
 * `redate: true`: the SAME occurrence moves earlier, no second one), tracked by `outcome_fact_declarations.dated`.
 *
 * The run: one `outcome-recording` run per (org, brand, fact's UTC day, OUTCOME KEY), created and closed `completed` at once,
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
  website_visit: ["website_visit"],
  signup: ["signup"],
  form_submitted: ["form_submission"],
  purchase: ["sale", "purchase"],
  meeting_booked: ["meeting_booked"],
  meeting_attended: ["meeting_attended"],
  paid_client: ["sale", "purchase"],
};

/** An outcome read off ONE source only (absent = any source): a direct purchase is a sale the website tag reported. */
export const FACT_SOURCES_OF_OUTCOME: Readonly<Partial<Record<FactOutcomeKey, readonly string[]>>> = {
  purchase: ["tracker"],
};

/** What we know the person reached BEFORE the fact (entry evidence) and what we already declared for them. */
export interface ConsumptionEvidence {
  positiveReply: boolean;
  websiteVisit: boolean;
  formSubmitted: boolean;
  declaredMeetingBooked: boolean;
  declaredMeetingAttended: boolean;
  declaredPurchase: boolean;
}

export type ConsumedBasis =
  | "positive_reply"
  | "website_visit"
  | "form_submitted"
  | "meeting_booked"
  | "meeting_attended"
  | "purchase"
  | "message_sent"
  | "no_evidence";

/** The one outcome a fact consumed. Pure. */
export function consumedOutcomeFor(outcome: FactOutcomeKey, e: ConsumptionEvidence): { outcomeKey: string; basis: ConsumedBasis } {
  const entry = (): { outcomeKey: string; basis: ConsumedBasis } => {
    if (e.positiveReply) return { outcomeKey: "conversation", basis: "positive_reply" };
    if (e.websiteVisit) return { outcomeKey: "website_visit", basis: "website_visit" };
    if (e.formSubmitted) return { outcomeKey: "form_submitted", basis: "form_submitted" };
    return { outcomeKey: "conversation", basis: "no_evidence" };
  };
  const sent = (): { outcomeKey: string; basis: ConsumedBasis } => ({ outcomeKey: "message_sent", basis: "message_sent" });
  if (outcome === "website_visit") return sent();
  if (outcome === "signup" || outcome === "form_submitted" || outcome === "purchase") {
    if (e.websiteVisit) return { outcomeKey: "website_visit", basis: "website_visit" };
    if (e.positiveReply) return { outcomeKey: "conversation", basis: "positive_reply" };
    return sent();
  }
  if (outcome === "meeting_booked") return entry();
  // A meeting attended consumes the booking only when we declared one (a CRM can state attended with no booking
  // fact: consuming an undeclared booking named a subject nobody produced, LEDGER-HISTORY-1024); else the entry.
  if (outcome === "meeting_attended") return e.declaredMeetingBooked ? { outcomeKey: "meeting_booked", basis: "meeting_booked" } : entry();
  if (e.declaredPurchase) return { outcomeKey: "purchase", basis: "purchase" };
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

/** A spend-free recording run holding ONE Unit (a Unit another factory made), created and closed at once. Throws. */
async function ownRecordingRun(f: { orgId: string; brandId: string }): Promise<string> {
  const run = await createRun({ orgId: f.orgId, brandId: f.brandId, serviceName: SERVICE_NAME, taskName: OUTCOME_RECORDING_TASK });
  await updateRun(run.id, "completed", { orgId: f.orgId, brandId: f.brandId });
  return run.id;
}

interface PendingFact {
  orgId: string;
  brandId: string;
  leadId: string;
  outcomeKey: FactOutcomeKey;
  /** The ledger row of the first reach; null = a reach only the CRM fact copy holds (`crmFactId`). */
  conversionEventId: string | null;
  crmFactId: string | null;
  /** Our outreach caused the first reach: the Unit consumes what it came from; else it consumes nothing. */
  ours: boolean;
  /** Who recorded the fact on the ledger: `manual` (a person), `crm`, `tracker`, ... */
  source: string;
  /** The CRM tool that stated it (`posthog`, `clerk`, `stripe`...), for a reach read off the CRM copy. */
  toolName: string | null;
  /** A CRM reach: every lead row of the same person (any of them already holding the Unit = no second one). */
  personLeadIds?: string[];
  /** The fact's instant as Postgres prints it (SQL comparisons), and as ISO (runs-service), never after now. */
  at: string | null;
  occurredAt: string | null;
}

/** ISO instant of a timestamptz column, capped at now (runs-service refuses a future `occurredAt`). */
const isoAt = (col: ReturnType<typeof sql.raw>) =>
  sql`to_char(LEAST(${col}, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * (outcome, event, source|null, rank): one ledger event can produce two outcomes (a tracker sale = Direct purchase AND
 * Paid client). Rank = FACT_OUTCOME_KEYS order, so an outcome is declared before the ones that consume it. Constants only.
 */
const OUTCOME_MAP = sql.raw(
  `(VALUES ${FACT_OUTCOME_KEYS.flatMap((outcome, i) =>
    FACT_EVENTS_OF_OUTCOME[outcome].flatMap((event) =>
      (FACT_SOURCES_OF_OUTCOME[outcome] ?? [null]).map((source) => `('${outcome}', '${event}', ${source ? `'${source}'` : "NULL::text"}, ${i + 1})`),
    ),
  ).join(", ")}) AS m(outcome_key, event, source, rank)`,
);
const FACT_EVENTS = [...new Set(Object.values(FACT_EVENTS_OF_OUTCOME).flat())];

/** Facts not declared yet: the earliest live one per (org, brand, lead, outcome), booked before attended before paid; its cause is that first reach's. */
export async function loadPendingFacts(scope?: { orgId: string }, limit = SWEEP_BATCH): Promise<PendingFact[]> {
  const rows = (await db.execute(sql`
    WITH facts AS (
      SELECT DISTINCT ON (ce.org_id, ce.brand_id, ce.matched_lead_id, m.outcome_key)
             ce.org_id, ce.brand_id, ce.matched_lead_id::text AS lead_id, m.outcome_key, m.rank,
             ce.id::text AS conversion_event_id, ce.source, ce.received_at, (ce.caused_by_outreach IS TRUE) AS ours
      FROM conversion_events ce
      JOIN ${OUTCOME_MAP} ON m.event = ce.event AND (m.source IS NULL OR m.source = ce.source)
      WHERE ce.event = ANY(${sql.param(FACT_EVENTS)}::text[])
        AND ce.withdrawn_at IS NULL AND ce.attribution_status = 'attributed' AND ce.matched_lead_id IS NOT NULL
        AND NOT (m.outcome_key = 'website_visit' AND EXISTS (
          SELECT 1 FROM lead_timeline_facts t
          WHERE t.org_id = ce.org_id AND t.brand_id = ce.brand_id AND t.lead_id = ce.matched_lead_id
            AND t.label = 'website_visit' AND t.source = 'outreach' AND t.withdrawn_at IS NULL))
        -- A visit through one of our posts' links is the post-touch run's occurrence (post-touch.ts), never a second one.
        AND NOT (m.outcome_key = 'website_visit' AND EXISTS (
          SELECT 1 FROM post_touch_declarations p
          WHERE p.org_id = ce.org_id AND p.brand_id = ce.brand_id AND p.lead_id = ce.matched_lead_id
            AND p.status IN ('delivered', 'queued')))
        ${scope ? sql`AND ce.org_id = ${scope.orgId}` : sql.empty()}
      -- The first reach; on a tie the row our outreach caused (one instant, one Unit: ours when any reach at it is).
      ORDER BY ce.org_id, ce.brand_id, ce.matched_lead_id, m.outcome_key, ce.received_at ASC NULLS LAST, (ce.caused_by_outreach IS TRUE) DESC, ce.id
    )
    SELECT f.org_id, f.brand_id, f.lead_id, f.outcome_key, f.conversion_event_id, f.source, f.ours, f.received_at::text AS at,
           ${isoAt(sql.raw("f.received_at"))} AS occurred_at
    FROM facts f
    WHERE NOT EXISTS (
      SELECT 1 FROM outcome_fact_declarations d
      WHERE d.org_id = f.org_id AND d.brand_id = f.brand_id AND d.lead_id = f.lead_id::uuid AND d.outcome_key = f.outcome_key)
    ORDER BY f.rank, f.received_at ASC NULLS LAST
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, string | boolean | null>>;
  return rows.map((r) => ({
    orgId: String(r.org_id),
    brandId: String(r.brand_id),
    leadId: String(r.lead_id),
    outcomeKey: r.outcome_key as FactOutcomeKey,
    conversionEventId: String(r.conversion_event_id),
    crmFactId: null,
    ours: r.ours === true,
    source: String(r.source),
    toolName: null,
    at: (r.at as string | null) ?? null,
    occurredAt: (r.occurred_at as string | null) ?? null,
  }));
}

/**
 * The outcomes a CRM fact TYPE reaches here: exactly what the CRM evidence sync records it as on a paired contact
 * (`crmFactLedgerOutcome`: signup -> signup, meetings -> meetings, sale / payment -> sale = paid client), so a reach
 * the copy alone holds is the SAME Unit the ledger path declares once the contact pairs. A type the sync records as
 * another step (a form = a positive reply, whose cause is decided there) or not at all reaches nothing here.
 */
export const CRM_REACHED_OUTCOMES: ReadonlyArray<{ outcomeKey: FactOutcomeKey; types: readonly string[] }> = FACT_OUTCOME_KEYS.map((k) => ({
  outcomeKey: k,
  types: [...new Set(Object.values(STEP_REACHED_EVIDENCE).flatMap((e) => e.crmFactTypes))].filter((t) => {
    const event = crmFactLedgerOutcome(t);
    return event !== null && FACT_EVENTS_OF_OUTCOME[k].includes(event) && !FACT_SOURCES_OF_OUTCOME[k];
  }),
})).filter((o) => o.types.length > 0);

export interface CrmReachRow {
  orgId: string;
  brandId: string;
  /** The lead the Unit names: the lowest id of `leadIds`. */
  leadId: string;
  /** Every lead row of the same person (`personOfLeadRows`: rows a fact of the brand names together). */
  leadIds: string[];
  factId: string;
  type: string;
  source: string | null;
  payload: Record<string, unknown> | null;
  at: string | null;
  occurredAt: string | null;
}

/**
 * The first reach per (org, brand, lead, outcome) among CRM fact rows. A payment reaches `paid_client` only when it
 * stands (step-reached's rule). Undated reaches come after every dated one. Pure.
 */
export function firstCrmReaches(rows: readonly CrmReachRow[]): PendingFact[] {
  const best = new Map<string, PendingFact>();
  for (const r of rows) {
    if (!rowReaches({ emails: [], name: null, phones: [], at: r.occurredAt, type: r.type, payload: r.payload })) continue;
    for (const o of CRM_REACHED_OUTCOMES) {
      if (!o.types.includes(r.type)) continue;
      const key = `${r.orgId}|${r.brandId}|${r.leadId}|${o.outcomeKey}`;
      const prev = best.get(key);
      const earlier = !prev || (r.occurredAt !== null && (prev.occurredAt === null || r.occurredAt < prev.occurredAt)) || (r.occurredAt === prev.occurredAt && r.factId < (prev.crmFactId ?? ""));
      if (!earlier) continue;
      best.set(key, {
        personLeadIds: r.leadIds,
        orgId: r.orgId,
        brandId: r.brandId,
        leadId: r.leadId,
        outcomeKey: o.outcomeKey,
        conversionEventId: null,
        crmFactId: r.factId,
        ours: false,
        source: "crm",
        toolName: r.source,
        at: r.at,
        occurredAt: r.occurredAt,
      });
    }
  }
  return [...best.values()];
}

/**
 * Lead rows that are ONE person: a fact naming several rows' addresses links them, transitively over every fact of the
 * brand (a later fact naming one address alone still lands on the same person). Returns each row's person = its linked
 * rows, sorted (the Unit names the first). Pure.
 */
export function personOfLeadRows(factLeadSets: ReadonlyArray<readonly string[]>): (leadId: string) => string[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const set of factLeadSets) {
    for (const id of set) if (!parent.has(id)) parent.set(id, id);
    for (const id of set.slice(1)) {
      const a = find(set[0]);
      const b = find(id);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const members = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    members.set(root, [...(members.get(root) ?? []), id]);
  }
  for (const list of members.values()) list.sort();
  return (leadId) => members.get(find(leadId)) ?? [leadId];
}

/** Every (org, brand) holding a CRM fact: one index probe per brand (skip scan), never a scan of the copy. */
async function listCrmFactScopes(scope?: { orgId: string }): Promise<Array<{ orgId: string; brandId: string }>> {
  if (scope) {
    const rows = (await db.execute(sql`SELECT DISTINCT brand_id FROM crm_facts WHERE org_id = ${scope.orgId}`)) as unknown as Array<{ brand_id: string }>;
    return rows.map((r) => ({ orgId: scope.orgId, brandId: r.brand_id }));
  }
  const rows = (await db.execute(sql`
    WITH RECURSIVE s AS (
      (SELECT org_id, brand_id FROM crm_facts ORDER BY org_id, brand_id LIMIT 1)
      UNION ALL
      SELECT n.org_id, n.brand_id FROM s CROSS JOIN LATERAL (
        SELECT f.org_id, f.brand_id FROM crm_facts f
        WHERE (f.org_id, f.brand_id) > (s.org_id, s.brand_id)
        ORDER BY f.org_id, f.brand_id LIMIT 1
      ) n
    )
    SELECT org_id, brand_id FROM s
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}

const CRM_REACH_TYPES = [...new Set(CRM_REACHED_OUTCOMES.flatMap((o) => o.types))];

/**
 * Reaches the brand's CRM states that no declaration holds yet, for the brand's lead holding the fact's address. One
 * fact = one person: lead rows a fact names together are ONE person (linked over every fact of the brand), the Unit
 * names the lowest lead id, and none is declared when any of that person's rows already holds it or holds a ledger row
 * of the outcome (live = the ledger path's; withdrawn = never brought back). A lead marked not a real person is left out (as every lead read).
 * Ledger rows are declared first (a paired contact's reach carries its cause there), so this path only adds what the
 * ledger does not hold.
 */
export async function loadPendingCrmReaches(scope?: { orgId: string }): Promise<PendingFact[]> {
  const pending: PendingFact[] = [];
  for (const s of await listCrmFactScopes(scope)) {
    const rows = (await db.execute(sql`
      WITH facts AS (
        SELECT f.fact_id, f.type, f.source, f.payload, f.occurred_at, lower(trim(e)) AS email
        FROM crm_facts f, unnest(f.emails) AS e
        WHERE f.org_id = ${s.orgId} AND f.brand_id = ${s.brandId}
          AND f.type = ANY(${sql.param(CRM_REACH_TYPES)}::text[])
          AND trim(e) <> ''
          AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
      ), brand_leads AS (
        SELECT DISTINCT lower(cm.value) AS email, lc.lead_id
        FROM leads_campaigns lc
        JOIN lead_contact_methods cm ON cm.lead_id = lc.lead_id AND cm.channel = 'email'
        WHERE lc.org_id = ${s.orgId} AND ${s.brandId} = ANY(lc.brand_ids)
          AND NOT EXISTS (SELECT 1 FROM not_a_person_marks npm WHERE npm.org_id = lc.org_id AND npm.lead_id = lc.lead_id AND npm.withdrawn_at IS NULL)
      ), matched AS (
        SELECT f.fact_id, f.type, f.source, f.payload, f.occurred_at, array_agg(DISTINCT bl.lead_id) AS lead_ids
        FROM facts f JOIN brand_leads bl ON bl.email = f.email
        GROUP BY f.fact_id, f.type, f.source, f.payload, f.occurred_at
      )
      SELECT m.fact_id, m.type, m.source, m.payload, m.occurred_at::text AS at, ${isoAt(sql.raw("m.occurred_at"))} AS occurred_at,
             m.lead_ids::text[] AS lead_ids
      FROM matched m
    `)) as unknown as Array<{ fact_id: string; type: string; source: string | null; payload: Record<string, unknown> | null; at: string | null; occurred_at: string | null; lead_ids: string[] }>;
    const person = personOfLeadRows(rows.map((r) => r.lead_ids));
    const reach: CrmReachRow[] = rows.map((r) => {
      const leadIds = person(r.lead_ids[0]);
      return { orgId: s.orgId, brandId: s.brandId, leadId: leadIds[0], leadIds, factId: r.fact_id, type: r.type, source: r.source, payload: r.payload, at: r.at, occurredAt: r.occurred_at };
    });
    const firsts = firstCrmReaches(reach);
    if (firsts.length === 0) continue;
    const personIds = [...new Set(firsts.flatMap((f) => f.personLeadIds ?? [f.leadId]))];
    const declared = (await db.execute(sql`
      SELECT lead_id::text AS lead_id, outcome_key FROM outcome_fact_declarations
      WHERE org_id = ${s.orgId} AND brand_id = ${s.brandId} AND lead_id = ANY(${sql.param(personIds)}::uuid[])
    `)) as unknown as Array<{ lead_id: string; outcome_key: string }>;
    // The ledger row is the record once one exists: a live one is declared by the ledger path, a WITHDRAWN one (a
    // person's word, a staff test, a pairing rejected: FAKE-OUTCOMES-1022) is never brought back from the CRM copy.
    const ledgerRows = (await db.execute(sql`
      SELECT ce.matched_lead_id::text AS lead_id, m.outcome_key
      FROM conversion_events ce
      JOIN ${OUTCOME_MAP} ON m.event = ce.event AND (m.source IS NULL OR m.source = ce.source)
      WHERE ce.org_id = ${s.orgId} AND ce.brand_id = ${s.brandId} AND ce.matched_lead_id = ANY(${sql.param(personIds)}::uuid[])
        AND (ce.withdrawn_at IS NOT NULL OR ce.attribution_status = 'attributed')
    `)) as unknown as Array<{ lead_id: string; outcome_key: string }>;
    // A person holding the Unit or a ledger row on any of their rows (or taken earlier in this pass) gets no second one.
    const held = new Set([...declared, ...ledgerRows].map((d) => `${d.lead_id}|${d.outcome_key}`));
    for (const f of firsts.sort((a, b) => (a.occurredAt ?? "~").localeCompare(b.occurredAt ?? "~"))) {
      const rowsOfPerson = f.personLeadIds ?? [f.leadId];
      if (rowsOfPerson.some((id) => held.has(`${id}|${f.outcomeKey}`))) continue;
      for (const id of rowsOfPerson) held.add(`${id}|${f.outcomeKey}`);
      pending.push(f);
    }
  }
  const rank = (k: FactOutcomeKey) => FACT_OUTCOME_KEYS.indexOf(k);
  return pending.sort((a, b) => rank(a.outcomeKey) - rank(b.outcomeKey) || (a.occurredAt ?? "~").localeCompare(b.occurredAt ?? "~"));
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
  // A visit through one of our posts' links, DECLARED (post-touch.ts): the signup consumes the `website_visit` the
  // post-touch run produced, which consumed the post (FACTORY-P2-CONTENT-OUTCOMES).
  const postTouch = sql`EXISTS (
    SELECT 1 FROM post_touch_declarations p
    WHERE p.org_id = ${f.orgId} AND p.brand_id = ${f.brandId} AND p.lead_id = ${f.leadId}::uuid
      AND p.status IN ('delivered', 'queued') ${before(sql.raw("p.visited_at"))})`;
  const declared = (outcome: FactOutcomeKey) => sql`EXISTS (
    SELECT 1 FROM outcome_fact_declarations d
    WHERE d.org_id = ${f.orgId} AND d.brand_id = ${f.brandId} AND d.lead_id = ${f.leadId}::uuid AND d.outcome_key = ${outcome})`;
  const rows = (await db.execute(sql`
    SELECT
      (${timeline(sql`t.source = 'reply' AND t.detail->>'classification' = 'positive'`)} OR ${ledger([CRM_POSITIVE_REPLY_STEP], true)}) AS positive_reply,
      (${timeline(sql`t.label = 'website_visit'`)} OR ${ledger(["website_visit"], false)} OR ${postTouch}) AS website_visit,
      (${timeline(sql`t.label = 'form_filled'`)} OR ${ledger(["form_submission"], false)}) AS form_submitted,
      ${declared("meeting_booked")} AS declared_meeting_booked,
      ${declared("meeting_attended")} AS declared_meeting_attended,
      ${declared("purchase")} AS declared_purchase
  `)) as unknown as Array<Record<string, boolean>>;
  const r = rows[0];
  return {
    positiveReply: r.positive_reply === true,
    websiteVisit: r.website_visit === true,
    formSubmitted: r.form_submitted === true,
    declaredMeetingBooked: r.declared_meeting_booked === true,
    declaredMeetingAttended: r.declared_meeting_attended === true,
    declaredPurchase: r.declared_purchase === true,
  };
}

/**
 * WHO PERFORMED a fact our outreach caused (LEAD-GENERIC-1106; runs-service stores it per occurrence). Ours by the
 * cause rule = after our first touch, so the performer is the SCRIPT whose send first touched the person at the brand
 * (the earliest email of the timeline or non-email channel send; the workflow holding the person's row of that campaign
 * when it went out: the latest re-point at or before the send, else the row's own serve workflow, the rule
 * `timeline-journeys` uses for `emailSends`). No such send readable = the fact's ATTESTER: `crm` / `tracker` (named by
 * the source), a person's statement = the client's team. Pure.
 */
export function performerOf(firstTouchWorkflowSlug: string | null, source: string, toolName: string | null = null): OutcomePerformer {
  if (firstTouchWorkflowSlug) return { kind: "script", workflowSlug: firstTouchWorkflowSlug };
  if (source === "crm") return toolName && toolName.trim() ? { kind: "crm", name: toolName.trim().slice(0, 128) } : { kind: "crm" };
  if (source === "tracker") return { kind: "tracker" };
  return { kind: "client_team", name: source };
}

/** The workflow whose send first touched the lead at the brand (null = none readable). */
export async function loadFirstTouchWorkflow(f: { orgId: string; brandId: string; leadId: string }): Promise<string | null> {
  const rows = (await db.execute(sql`
    WITH sends AS (
      SELECT t.campaign_id, t.occurred_at AS at FROM lead_timeline_facts t
      WHERE t.org_id = ${f.orgId} AND t.brand_id = ${f.brandId} AND t.lead_id = ${f.leadId}::uuid
        AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL AND t.campaign_id IS NOT NULL AND t.occurred_at IS NOT NULL
      UNION ALL
      SELECT lc.campaign_id, lc.channel_sent_at FROM leads_campaigns lc
      WHERE lc.org_id = ${f.orgId} AND ${f.brandId} = ANY(lc.brand_ids) AND lc.lead_id = ${f.leadId}::uuid AND lc.channel_sent_at IS NOT NULL
    ), first AS (SELECT campaign_id, at FROM sends ORDER BY at ASC, campaign_id LIMIT 1)
    SELECT coalesce(
      (SELECT r.workflow_slug FROM lead_campaign_run_repoints r
        WHERE r.lead_campaign_id = lc.id AND r.repointed_at <= first.at AND r.workflow_slug IS NOT NULL
        ORDER BY r.repointed_at DESC LIMIT 1),
      lc.workflow_slug) AS workflow_slug
    FROM first JOIN leads_campaigns lc ON lc.lead_id = ${f.leadId}::uuid AND lc.campaign_id = first.campaign_id AND lc.org_id = ${f.orgId}
    LIMIT 1
  `)) as unknown as Array<{ workflow_slug: string | null }>;
  const slug = rows[0]?.workflow_slug ?? null;
  return slug && slug.trim() ? slug : null;
}

export interface OutcomeFactSweepSummary {
  read: number;
  delivered: number;
  queued: number;
  refused: number;
  failed: number;
  /** Of the declared: Units another factory made (consuming nothing). */
  theirs: number;
}

async function declareOne(f: PendingFact, summary: OutcomeFactSweepSummary): Promise<void> {
  let runId: string;
  let consumed: { outcomeKey: string; basis: ConsumedBasis } | null;
  let performer: OutcomePerformer;
  try {
    // Ours on the brand's recording run of the day for the outcome; a Unit another factory made on a run of ITS OWN:
    // runs-service splits a run's consumptions over every Unit it produced, so a theirs Unit on our run would carry part
    // of our cost (and a later turn to ours adds the consumption to that Unit alone).
    runId = f.ours ? await outcomeRecordingRunFor(f.orgId, f.brandId, f.outcomeKey, f.occurredAt ? new Date(f.occurredAt) : new Date()) : await ownRecordingRun(f);
    // A Unit another factory made consumes nothing and is never one of our scripts' (LEDGER-DECLARE-1107).
    consumed = f.ours ? consumedOutcomeFor(f.outcomeKey, await loadConsumptionEvidence(f)) : null;
    performer = f.ours ? performerOf(await loadFirstTouchWorkflow(f), f.source) : performerOf(null, f.source, f.toolName);
  } catch (err) {
    summary.failed++;
    console.error(`[lead-service] outcome fact NOT declared (asked again next pass): org=${f.orgId} brand=${f.brandId} lead=${f.leadId} ${f.outcomeKey}: ${errorMessage(err)}`);
    return;
  }
  // Claim first: once per (org, brand, lead, outcome), ever.
  const claimed = (await db.execute(sql`
    INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, conversion_event_id, crm_fact_id, run_id,
      consumed_outcome_key, consumed_basis, dated, caused_by_outreach, occurred_at)
    VALUES (${f.orgId}, ${f.brandId}, ${f.leadId}::uuid, ${f.outcomeKey}, ${f.conversionEventId}::uuid, ${f.crmFactId}, ${runId}::uuid,
      ${consumed?.outcomeKey ?? null}, ${consumed?.basis ?? null}, true, ${f.ours}, ${f.occurredAt}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING 1 AS ok
  `)) as unknown as unknown[];
  if (claimed.length === 0) return;
  const kind = await declareRunOutcomesNow(
    factOutcomeDeclaration({ orgId: f.orgId, runId, leadId: f.leadId, outcomeKey: f.outcomeKey, consumedOutcomeKey: consumed?.outcomeKey ?? null, occurredAt: f.occurredAt, performer }),
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
  if (!f.ours) summary.theirs++;
}

export interface UpgradeSummary {
  read: number;
  upgraded: number;
  refused: number;
}

/**
 * A Unit declared as THEIRS whose first reach the cause rule now calls OURS (the earliest live ledger row of the lead and
 * outcome carries `caused_by_outreach = true`: outcome-cause.ts decides a new row a few minutes after it lands, a CRM
 * reach becomes a ledger row once its contact pairs): the SAME occurrence takes its consumption and our performer
 * (runs-service batch door, `correctPerformer`: the attester stated first is replaced, its history kept there). The
 * reverse never happens: the ledger is immutable. A refusal is kept (`cause_error`), never resent; 5xx stops the pass.
 */
export async function upgradeToOurs(scope?: { orgId: string }, post: RedatePost = postRedate): Promise<UpgradeSummary> {
  const rows = (await db.execute(sql`
    SELECT d.org_id, d.brand_id, d.lead_id::text AS lead_id, d.outcome_key, d.run_id::text AS run_id,
           ${isoAt(sql.raw("d.occurred_at"))} AS occurred_at, d.occurred_at::text AS at, first.source
    FROM outcome_fact_declarations d
    CROSS JOIN LATERAL (
      SELECT ce.source, (ce.caused_by_outreach IS TRUE) AS ours
      FROM conversion_events ce
      JOIN ${OUTCOME_MAP} ON m.event = ce.event AND (m.source IS NULL OR m.source = ce.source)
      WHERE ce.org_id = d.org_id AND ce.brand_id = d.brand_id AND ce.matched_lead_id = d.lead_id AND m.outcome_key = d.outcome_key
        AND ce.withdrawn_at IS NULL AND ce.attribution_status = 'attributed'
      ORDER BY ce.received_at ASC NULLS LAST, (ce.caused_by_outreach IS TRUE) DESC, ce.id
      LIMIT 1
    ) first
    WHERE d.caused_by_outreach = false AND d.cause_error IS NULL AND first.ours
      ${scope ? sql`AND d.org_id = ${scope.orgId}` : sql.empty()}
    ORDER BY d.created_at
    LIMIT ${SWEEP_BATCH}
  `)) as unknown as Array<Record<string, string | null>>;
  const summary: UpgradeSummary = { read: rows.length, upgraded: 0, refused: 0 };
  for (const r of rows) {
    const f: PendingFact = {
      orgId: String(r.org_id),
      brandId: String(r.brand_id),
      leadId: String(r.lead_id),
      outcomeKey: r.outcome_key as FactOutcomeKey,
      conversionEventId: null,
      crmFactId: null,
      ours: true,
      source: String(r.source),
      toolName: null,
      at: r.at,
      occurredAt: r.occurred_at,
    };
    const key = sql`org_id = ${f.orgId} AND brand_id = ${f.brandId} AND lead_id = ${f.leadId}::uuid AND outcome_key = ${f.outcomeKey}`;
    const consumed = consumedOutcomeFor(f.outcomeKey, await loadConsumptionEvidence(f));
    const performer = performerOf(await loadFirstTouchWorkflow(f), f.source);
    const d = factOutcomeDeclaration({ orgId: f.orgId, runId: String(r.run_id), leadId: f.leadId, outcomeKey: f.outcomeKey, consumedOutcomeKey: consumed.outcomeKey, performer });
    const res = await post({
      runs: [{ runId: d.runId, ...(f.occurredAt ? { occurredAt: f.occurredAt } : {}), correctPerformer: true, produced: d.produced, consumed: d.consumed }],
    });
    if (res.status === 200 || res.status === 201) {
      await db.execute(sql`
        UPDATE outcome_fact_declarations
        SET caused_by_outreach = true, consumed_outcome_key = ${consumed.outcomeKey}, consumed_basis = ${consumed.basis}, performer = ${JSON.stringify(performer)}::jsonb
        WHERE ${key}
      `);
      summary.upgraded++;
      continue;
    }
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw new Error(`runs-service cause upgrade ${res.status} ${res.text.slice(0, 300)}`);
    await db.execute(sql`UPDATE outcome_fact_declarations SET cause_error = ${`${res.status} ${res.text.slice(0, 500)}`} WHERE ${key}`);
    summary.refused++;
    console.error(`[lead-service] outcome Unit NOT turned ours (refused, kept, never resent): org=${f.orgId} run=${r.run_id} lead=${f.leadId} ${f.outcomeKey}: ${res.status} ${res.text.slice(0, 300)}`);
  }
  if (rows.length > 0) console.log(`[lead-service] outcome cause upgrade pass ${JSON.stringify(summary)}`);
  return summary;
}

export interface RedateSummary {
  read: number;
  redated: number;
  alreadyRecorded: number;
  undated: number;
  refused: number;
}

export type RedatePost = (body: unknown) => Promise<{ status: number; text: string }>;

const postRedate: RedatePost = async (body) => {
  const res = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/platform-runs/outcomes/batch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": RUNS_SERVICE_API_KEY, "x-service-name": OUTCOME_SUBJECT_SERVICE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, text: await res.text() };
};

/**
 * Declarations made before the dating rule sit on the day they were DECLARED: move each to the instant its fact
 * happened, once (runs-service batch door, `redate: true`, one run and one instant per call: the same occurrence moves
 * earlier, a replay writes nothing). Marked `dated` once runs-service took it; an undated fact has nothing to move.
 * A refusal is logged loud and asked again next pass. 5xx / network = the pass stops (asked again next pass).
 */
export async function redateUndatedDeclarations(scope?: { orgId: string }, post: RedatePost = postRedate): Promise<RedateSummary> {
  const rows = (await db.execute(sql`
    SELECT d.org_id, d.brand_id, d.lead_id::text AS lead_id, d.outcome_key, d.run_id::text AS run_id, d.consumed_outcome_key,
           ${isoAt(sql.raw("ce.received_at"))} AS occurred_at
    FROM outcome_fact_declarations d
    LEFT JOIN conversion_events ce ON ce.id = d.conversion_event_id
    WHERE d.dated = false ${scope ? sql`AND d.org_id = ${scope.orgId}` : sql.empty()}
    ORDER BY d.created_at
    LIMIT ${SWEEP_BATCH}
  `)) as unknown as Array<Record<string, string | null>>;
  const summary: RedateSummary = { read: rows.length, redated: 0, alreadyRecorded: 0, undated: 0, refused: 0 };
  for (const r of rows) {
    const markDated = () => db.execute(sql`
      UPDATE outcome_fact_declarations SET dated = true
      WHERE org_id = ${r.org_id} AND brand_id = ${r.brand_id} AND lead_id = ${r.lead_id}::uuid AND outcome_key = ${r.outcome_key}
    `);
    if (!r.occurred_at) {
      summary.undated++;
      await markDated();
      continue;
    }
    const d = factOutcomeDeclaration({
      orgId: String(r.org_id),
      runId: String(r.run_id),
      leadId: String(r.lead_id),
      outcomeKey: r.outcome_key as FactOutcomeKey,
      consumedOutcomeKey: r.consumed_outcome_key ?? null,
      performer: null,
    });
    const res = await post({ runs: [{ runId: d.runId, occurredAt: r.occurred_at, redate: true, produced: d.produced, consumed: d.consumed }] });
    if (res.status === 200 || res.status === 201) {
      const j = JSON.parse(res.text) as { redatedCount?: number; recordedCount?: number; alreadyRecordedCount?: number };
      if ((j.redatedCount ?? 0) + (j.recordedCount ?? 0) > 0) summary.redated++;
      else summary.alreadyRecorded++;
      await markDated();
      continue;
    }
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw new Error(`runs-service redate ${res.status} ${res.text.slice(0, 300)}`);
    summary.refused++;
    console.error(`[lead-service] outcome fact NOT re-dated (refused, asked again next pass): org=${r.org_id} run=${r.run_id} lead=${r.lead_id} ${r.outcome_key} at=${r.occurred_at}: ${res.status} ${res.text.slice(0, 300)}`);
  }
  if (rows.length > 0) console.log(`[lead-service] outcome fact re-date pass ${JSON.stringify(summary)}`);
  return summary;
}

export interface PerformerSummary {
  read: number;
  stated: number;
  refused: number;
}

/**
 * `performer` is recorded only once runs-service PROVED it took it (its answer counts `performerStatedCount`): a live
 * declaration states it too, but a runs-service that does not know the field drops it silently, so this pass (same
 * sweep, right after) is what records it, for new and old occurrences alike.
 *
 * Occurrences declared before performers existed (LEAD-GENERIC-1106) get theirs stated ONCE through runs-service's batch
 * door: the SAME occurrence (run, outcome, lead) takes the performer (`performer_stated`), a replay is
 * `already_recorded`, a different performer already stored is a 409 kept in `performer_error` (never overwritten, never
 * resent). 5xx / network = the pass stops, asked again next pass.
 */
export async function statePastPerformers(scope?: { orgId: string }, post: RedatePost = postRedate): Promise<PerformerSummary> {
  const rows = (await db.execute(sql`
    SELECT d.org_id, d.brand_id, d.lead_id::text AS lead_id, d.outcome_key, d.run_id::text AS run_id, d.consumed_outcome_key,
           CASE WHEN d.crm_fact_id IS NOT NULL THEN 'crm' ELSE coalesce(ce.source, 'manual') END AS source,
           cf.source AS tool_name, d.caused_by_outreach
    FROM outcome_fact_declarations d
    LEFT JOIN conversion_events ce ON ce.id = d.conversion_event_id
    LEFT JOIN crm_facts cf ON cf.fact_id = d.crm_fact_id
    WHERE d.performer IS NULL AND d.performer_error IS NULL ${scope ? sql`AND d.org_id = ${scope.orgId}` : sql.empty()}
    ORDER BY d.created_at
    LIMIT ${SWEEP_BATCH}
  `)) as unknown as Array<Record<string, string> & { tool_name: string | null; caused_by_outreach: boolean }>;
  const summary: PerformerSummary = { read: rows.length, stated: 0, refused: 0 };
  for (const r of rows) {
    const key = sql`org_id = ${r.org_id} AND brand_id = ${r.brand_id} AND lead_id = ${r.lead_id}::uuid AND outcome_key = ${r.outcome_key}`;
    const performer = r.caused_by_outreach
      ? performerOf(await loadFirstTouchWorkflow({ orgId: r.org_id, brandId: r.brand_id, leadId: r.lead_id }), r.source)
      : performerOf(null, r.source, r.tool_name ?? null);
    const d = factOutcomeDeclaration({
      orgId: r.org_id,
      runId: r.run_id,
      leadId: r.lead_id,
      outcomeKey: r.outcome_key as FactOutcomeKey,
      consumedOutcomeKey: r.consumed_outcome_key ?? null,
      performer,
    });
    const res = await post({ runs: [{ runId: d.runId, produced: d.produced }] });
    if (res.status === 200 || res.status === 201) {
      // A runs-service that does not know performers yet answers 200 and drops the field: its answer then carries no
      // performer count. Never record a performer it did not take (the pass stops, asked again once it is deployed).
      if (!("performerStatedCount" in (JSON.parse(res.text) as Record<string, unknown>))) {
        throw new Error(`runs-service did not take the performer (no performerStatedCount): ${res.text.slice(0, 200)}`);
      }
      await db.execute(sql`UPDATE outcome_fact_declarations SET performer = ${JSON.stringify(performer)}::jsonb WHERE ${key}`);
      summary.stated++;
      continue;
    }
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw new Error(`runs-service performer ${res.status} ${res.text.slice(0, 300)}`);
    await db.execute(sql`UPDATE outcome_fact_declarations SET performer_error = ${`${res.status} ${res.text.slice(0, 500)}`} WHERE ${key}`);
    summary.refused++;
    console.error(`[lead-service] outcome performer REFUSED (kept, never resent): org=${r.org_id} run=${r.run_id} lead=${r.lead_id} ${r.outcome_key}: ${res.status} ${res.text.slice(0, 300)}`);
  }
  if (rows.length > 0) console.log(`[lead-service] outcome performer pass ${JSON.stringify(summary)}`);
  return summary;
}

let inFlight: Promise<OutcomeFactSweepSummary> | null = null;

/** One pass. Concurrent calls join it. `scope` is a test hook (the suite's files share one database). */
export function sweepOutcomeFactDeclarations(scope?: { orgId: string }): Promise<OutcomeFactSweepSummary> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // Ledger rows first (a paired contact's reach carries its cause there), then what only the CRM copy holds.
    const facts = await loadPendingFacts(scope);
    const summary: OutcomeFactSweepSummary = { read: facts.length, delivered: 0, queued: 0, refused: 0, failed: 0, theirs: 0 };
    for (const f of facts) await declareOne(f, summary);
    const crmReaches = await loadPendingCrmReaches(scope).catch((err) => {
      console.error("[lead-service] outcome fact CRM reach read failed (asked again next pass):", err);
      return [] as PendingFact[];
    });
    summary.read += crmReaches.length;
    for (const f of crmReaches) await declareOne(f, summary);
    if (facts.length > 0) console.log(`[lead-service] outcome fact declarations pass ${JSON.stringify(summary)}`);
    await redateUndatedDeclarations(scope).catch((err) => console.error("[lead-service] outcome fact re-date pass failed:", err));
    await statePastPerformers(scope).catch((err) => console.error("[lead-service] outcome performer pass failed:", err));
    await upgradeToOurs(scope).catch((err) => console.error("[lead-service] outcome cause upgrade pass failed:", err));
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
