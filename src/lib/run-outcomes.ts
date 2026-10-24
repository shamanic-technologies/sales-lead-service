import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { RUNS_SERVICE_API_KEY, RUNS_SERVICE_URL } from "../config.js";
import { db } from "../db/index.js";
import { runOutcomeOutbox } from "../db/schema.js";
import { errorMessage } from "./db-error.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * EVERY RUN OF OURS THAT SPENDS STATES WHAT IT PRODUCED AND CONSUMED (COST-ACCOUNTING-1023-P1, owner 2026-10-23).
 *
 * runs-service is the general ledger: `POST /v1/runs/{runId}/outcomes` records the outcome occurrences a run produced
 * and consumed, and gives each produced one its exact share of the run's cost (its own rows + every descendant that
 * declares nothing). The subject of a person's occurrence is ALWAYS their lead here (`subjectService: "lead-service"`,
 * the lead id): every service on the way names the same subject, so a consumption finds its producer.
 *
 * What we declare (`leadFoundDeclaration`, the only builder; a test pins each key and subject):
 *   - a serve that FOUND a person (`recordServed` in buffer.ts: a fresh serve or a source's find, the same moment
 *     the `lead_found` trigger rings; never a retry, stock, released, named or follow-up re-hand, which bought
 *     nobody) -> produced `lead_found` on the lead-serve run. A person filed but not kept (a journalist of the
 *     brand) is a loss: nothing declared, their cost rides the kept ones.
 *   - the same serve CONSUMED the person's `email_checked` when it came with a verification verdict (apollo-service
 *     declares that occurrence on its own verify run once the lead exists: it resolves the id through
 *     `POST /internal/leads/ids/resolve`), and the `lead_identified` crm-service declared when the person came from
 *     the client's CRM registry (subject = crm's relation key: crm-lead-identified.ts, LEAD-IDENTIFIED-CONSUME-1024).
 *     Bonus checks, screening judgments and every child run that declares
 *     nothing roll into the lead-serve run's `lead_found`.
 *   - every fact past a send our outreach caused (a website visit known only by hand, a signup, a form, a direct
 *     purchase, a meeting booked / attended, a sale) -> its catalogue outcome on the brand's recording run of the fact's
 *     UTC day for that outcome, dated on the instant the fact happened (`factOutcomeDeclaration`,
 *     outcome-fact-declarations.ts; MEETING-DATED-OCCURRENCES-1024, LEDGER-HISTORY-1024).
 * Not declared, on purpose: qualification previews/samples/suggestions (sample companies that are not leads,
 * onboarding support), relationship sweeps (tags, not catalogue outcomes). No run here judges a positive reply
 * (instantly-service owns reply verdicts; a CRM form is crm-service's fact, no spend), so no `conversation`.
 *
 * Rules:
 *   1. Never blocks, slows or fails the serve: `declareRunOutcomes` is called without await and never throws.
 *   2. Idempotent at runs-service per (run, direction, outcome, subject): a replay is `already_recorded`; our own
 *      key `<runId>:<outcome>:<subjectId>` keeps one outbox row per declaration.
 *   3. Every declaration ends up recorded: one runs-service did not take (down, 5xx, 502 catalogue unreadable) waits
 *      in `run_outcome_outbox` and the background thread redelivers it with backoff; a refusal no retry fixes
 *      (400 unknown key, 404 run, 409 org mismatch / quantity conflict) is kept with `refused_at`, logged loud.
 */

export const OUTCOME_SUBJECT_SERVICE = "lead-service" as const;
/** crm-service's occurrence a find from the client's CRM consumes (crm-lead-identified.ts). */
export const LEAD_IDENTIFIED_OUTCOME = "lead_identified" as const;
export const CRM_SUBJECT_SERVICE = "crm-service" as const;

export interface OutcomeItem {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
}

export interface RunOutcomeDeclaration {
  orgId: string;
  runId: string;
  produced: OutcomeItem[];
  consumed: OutcomeItem[];
  /**
   * When the occurrence HAPPENED (ISO instant), for a fact recorded after the day it happened (a meeting booked in
   * May, declared in October: MEETING-DATED-OCCURRENCES-1024). runs-service files it on that instant; it accepts a
   * past instant only on a run with no cost and no child run (our recording runs) declared by its own service.
   * Absent = on time (the declaration's moment).
   */
  occurredAt?: string;
}

const leadSubject = (outcomeKey: string, leadId: string): OutcomeItem => ({ outcomeKey, subjectService: OUTCOME_SUBJECT_SERVICE, subjectId: leadId });

/**
 * A serve that FOUND a person: `lead_found` produced, the `email_checked` it handed out consumed when one was stated,
 * and the `lead_identified` crm-service produced when the person came from the client's CRM registry (subject = crm's
 * relation key, crm-lead-identified.ts; null = no crm relation identified them).
 */
export function leadFoundDeclaration(input: {
  orgId: string;
  runId: string;
  leadId: string;
  emailChecked: boolean;
  crmRelationKey: string | null;
}): RunOutcomeDeclaration {
  const consumed: OutcomeItem[] = [];
  if (input.emailChecked) consumed.push(leadSubject("email_checked", input.leadId));
  if (input.crmRelationKey) consumed.push({ outcomeKey: LEAD_IDENTIFIED_OUTCOME, subjectService: CRM_SUBJECT_SERVICE, subjectId: input.crmRelationKey });
  return {
    orgId: input.orgId,
    runId: input.runId,
    produced: [leadSubject("lead_found", input.leadId)],
    consumed,
  };
}

/**
 * A run that paid NEW research on these companies (a charged probe or a new verdict; qualification-*.ts `noteResearch`):
 * `company_researched` produced per company, subject = the company's normalized DOMAIN here (observations and verdicts
 * are keyed on it; content-generation-service consumes the same spelling off `leadQualification.domain`). Equal shares.
 */
export function companyResearchedDeclaration(input: { orgId: string; runId: string; domains: string[] }): RunOutcomeDeclaration {
  return {
    orgId: input.orgId,
    runId: input.runId,
    produced: [...new Set(input.domains)].sort().map((domain) => ({ outcomeKey: "company_researched", subjectService: OUTCOME_SUBJECT_SERVICE, subjectId: domain })),
    consumed: [],
  };
}

/**
 * A fact our outreach caused (outcome-fact-declarations.ts): a website visit known by hand, a signup, a form, a direct
 * purchase, a meeting booked / attended or a sale of the person, produced on the brand's recording run of the day for
 * that outcome, consuming the one outcome it came from. Subject = the lead, both ways. Keys = features-service
 * `/public/catalogue/steps` (LEDGER-HISTORY-1024).
 */
export const FACT_OUTCOME_KEYS = [
  "website_visit",
  "signup",
  "form_submitted",
  "purchase",
  "meeting_booked",
  "meeting_attended",
  "paid_client",
] as const;
export type FactOutcomeKey = (typeof FACT_OUTCOME_KEYS)[number];

export function factOutcomeDeclaration(input: {
  orgId: string;
  runId: string;
  leadId: string;
  outcomeKey: FactOutcomeKey;
  consumedOutcomeKey: string;
  /** When the fact happened (ISO); null = undated fact, declared on time. */
  occurredAt?: string | null;
}): RunOutcomeDeclaration {
  return {
    orgId: input.orgId,
    runId: input.runId,
    produced: [leadSubject(input.outcomeKey, input.leadId)],
    consumed: [leadSubject(input.consumedOutcomeKey, input.leadId)],
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

export function declarationKey(d: RunOutcomeDeclaration): string {
  const first = d.produced[0] ?? d.consumed[0];
  if (!first) throw new Error(`run ${d.runId}: an outcome declaration states nothing`);
  return `${d.runId}:${first.outcomeKey}:${first.subjectId}`;
}

const CALL_TIMEOUT_MS = 15_000;
export const OUTBOX_DRAIN_INTERVAL_MS = 60_000;
const OUTBOX_FIRST_DRAIN_DELAY_MS = 60_000;
const OUTBOX_BATCH_SIZE = 200;
const MAX_BACKOFF_MS = 60 * 60_000;

type DeliveryResult = { kind: "delivered" } | { kind: "retry"; error: string } | { kind: "refused"; error: string };

/** One attempt at runs-service. Never throws. */
export async function deliverRunOutcomes(d: RunOutcomeDeclaration): Promise<DeliveryResult> {
  try {
    const response = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/runs/${d.runId}/outcomes`, {
      method: "POST",
      // x-service-name: runs-service takes a past `occurredAt` only from the run's own service.
      headers: { "content-type": "application/json", "x-api-key": RUNS_SERVICE_API_KEY, "x-org-id": d.orgId, "x-service-name": OUTCOME_SUBJECT_SERVICE },
      body: JSON.stringify({ produced: d.produced, consumed: d.consumed, ...(d.occurredAt ? { occurredAt: d.occurredAt } : {}) }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.ok) return { kind: "delivered" };
    const text = (await response.text()).slice(0, 500);
    // 400 (shape, unknown_outcome_key), 404 (run), 409 (org mismatch, quantity conflict): the same bytes cannot
    // succeed. Anything else (401, 5xx, 502 catalogue unreadable) can.
    if (response.status === 400 || response.status === 404 || response.status === 409) return { kind: "refused", error: `${response.status} ${text}` };
    return { kind: "retry", error: `${response.status} ${text}` };
  } catch (err) {
    return { kind: "retry", error: errorMessage(err) };
  }
}

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

function describe(d: RunOutcomeDeclaration): string {
  const list = (items: OutcomeItem[]) => items.map((i) => `${i.outcomeKey}:${i.subjectId}`).join(",") || "-";
  return `org=${d.orgId} run=${d.runId} produced=${list(d.produced)} consumed=${list(d.consumed)}`;
}

/** Declare a run's outcomes. Called WITHOUT await; never throws, never rejects. A failed delivery lands in the outbox. */
export function declareRunOutcomes(d: RunOutcomeDeclaration): void {
  void declareRunOutcomesNow(d);
}

/**
 * Same, awaitable (a background sweep): resolves once runs-service took it or the outbox holds it. Never rejects.
 * Answers what happened now: `delivered`, `retry` (queued for redelivery), `refused` (kept, never resent) or `lost`
 * (neither delivered nor queued: the caller must ask again).
 */
export function declareRunOutcomesNow(d: RunOutcomeDeclaration): Promise<DeliveryResult["kind"] | "lost"> {
  return (async () => {
    const result = await deliverRunOutcomes(d);
    if (result.kind === "delivered") return result.kind;
    console.error(`[lead-service] run outcomes NOT declared (${result.kind}), kept in run_outcome_outbox: ${describe(d)}: ${result.error}`);
    const now = new Date();
    await db
      .insert(runOutcomeOutbox)
      .values({
        idempotencyKey: declarationKey(d),
        orgId: d.orgId,
        runId: d.runId,
        declaration: d,
        attempts: 1,
        lastError: result.error,
        nextAttemptAt: new Date(now.getTime() + backoffMs(1)),
        refusedAt: result.kind === "refused" ? now : null,
      })
      .onConflictDoNothing();
    return result.kind;
  })().catch((err): "lost" => {
    console.error(`[lead-service] run outcomes LOST (outbox write failed): ${describe(d)}:`, err);
    return "lost";
  });
}

let draining = false;

/** Redeliver every due outbox row once. */
export async function drainRunOutcomeOutbox(): Promise<{ delivered: number; retried: number; refused: number }> {
  const counts = { delivered: 0, retried: 0, refused: 0 };
  if (draining) return counts;
  draining = true;
  try {
    const due = await db
      .select()
      .from(runOutcomeOutbox)
      .where(and(isNull(runOutcomeOutbox.refusedAt), lte(runOutcomeOutbox.nextAttemptAt, sql`now()`)))
      .orderBy(asc(runOutcomeOutbox.nextAttemptAt))
      .limit(OUTBOX_BATCH_SIZE);
    for (const row of due) {
      const d = row.declaration as RunOutcomeDeclaration;
      const result = await deliverRunOutcomes(d);
      if (result.kind === "delivered") {
        await db.delete(runOutcomeOutbox).where(eq(runOutcomeOutbox.idempotencyKey, row.idempotencyKey));
        counts.delivered++;
        continue;
      }
      const attempts = row.attempts + 1;
      const now = new Date();
      await db
        .update(runOutcomeOutbox)
        .set({ attempts, lastError: result.error, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), refusedAt: result.kind === "refused" ? now : null })
        .where(eq(runOutcomeOutbox.idempotencyKey, row.idempotencyKey));
      if (result.kind === "refused") counts.refused++;
      else counts.retried++;
      console.error(`[lead-service] run outcomes redelivery ${result.kind} (attempt ${attempts}): ${describe(d)}: ${result.error}`);
    }
    if (due.length > 0) {
      console.log(`[lead-service] run_outcome_outbox drained: delivered=${counts.delivered} retried=${counts.retried} refused=${counts.refused}`);
    }
    return counts;
  } finally {
    draining = false;
  }
}

/** Background thread: redeliver undeclared outcomes, first pass a minute after boot. */
export function startRunOutcomeOutboxWorker(): void {
  const tick = () => {
    drainRunOutcomeOutbox().catch((err) => console.error("[lead-service] run_outcome_outbox drain failed:", err));
  };
  setTimeout(tick, OUTBOX_FIRST_DRAIN_DELAY_MS).unref();
  setInterval(tick, OUTBOX_DRAIN_INTERVAL_MS).unref();
}
