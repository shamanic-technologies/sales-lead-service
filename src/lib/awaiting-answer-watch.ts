/**
 * A PERSON WAITING ON OUR ANSWER FOR MORE THAN AN HOUR TURNS MONITORING RED (REPLY-NO-BALANCE-1118).
 *
 * Owner 2026-11-18: a prospect who answers one of our cold emails always gets an answer within minutes
 * (« C'EST NON PROFESSIONNEL. ÇA COÛTE 3 CENTS DE RÉPONDRE »). Doc Dinners' doctors waited 8 days while the org's
 * balance sat at $0 and nothing turned red.
 *
 * Every WATCH_INTERVAL_MS this sweep reads "who is waiting on us" (awaiting-reply-read.ts, the same rule as the
 * dashboard's "Needs your call", frozen Gmail verdicts only: no judgment billed) for every brand a person wrote to in
 * the last WATCH_BRAND_WINDOW_DAYS, and keeps the people whose wait began more than RED_AFTER_MS ago and less than
 * RECENT_WAIT_DAYS ago (an older wait is a past defect, still shown by "Needs your call", never a fresh red forever).
 * It stores one row per (UTC day, org, brand): the latest sample, the day's worst, and who. Red = the latest sweep
 * found anyone, or the sweep itself has not finished for STALE_AFTER_MS (a silent monitor is a broken one).
 */
import { sql } from "../db/index.js";
import { readAwaitingReplyWithReport } from "./awaiting-reply-read.js";

export const RED_AFTER_MS = 60 * 60_000;
export const RECENT_WAIT_DAYS = 30;
export const WATCH_BRAND_WINDOW_DAYS = 30;
export const WATCH_INTERVAL_MS = 15 * 60_000;
export const STALE_AFTER_MS = 2 * 60 * 60_000;
const FIRST_SWEEP_DELAY_MS = 90_000;

export interface WaitingPerson {
  leadId: string;
  email: string;
  name: string | null;
  waitingSince: string;
  lastMessageAt: string;
  lastMessageKind: string;
}

/** The people of one brand's awaiting list who count for the watch at `now`. Pure. */
export function overdue(
  people: ReadonlyArray<{ leadId: string; email: string; name: string | null; waitingSince: string; lastMessage: { at: string; kind: string } }>,
  now: number,
): WaitingPerson[] {
  return people
    .filter((p) => {
      const since = Date.parse(p.waitingSince);
      return !Number.isNaN(since) && now - since > RED_AFTER_MS && now - since <= RECENT_WAIT_DAYS * 86_400_000;
    })
    .map((p) => ({ leadId: p.leadId, email: p.email, name: p.name, waitingSince: p.waitingSince, lastMessageAt: p.lastMessage.at, lastMessageKind: p.lastMessage.kind }));
}

export async function runAwaitingAnswerWatch(now: Date = new Date()): Promise<{ brands: number; failed: number; waiting: number }> {
  const scopes = (await sql`
    SELECT DISTINCT org_id, b AS brand_id
    FROM outreach_facts, unnest(brand_ids) AS b
    WHERE type = 'reply' AND org_id IS NOT NULL
      AND occurred_at > ${new Date(now.getTime() - WATCH_BRAND_WINDOW_DAYS * 86_400_000).toISOString()}::timestamptz
  `) as unknown as Array<{ org_id: string; brand_id: string }>;
  const day = now.toISOString().slice(0, 10);
  let failed = 0;
  let waiting = 0;
  for (const s of scopes) {
    try {
      const { people } = await readAwaitingReplyWithReport({ orgId: s.org_id, brandId: s.brand_id });
      const late = overdue(people, now.getTime());
      waiting += late.length;
      await sql`
        INSERT INTO awaiting_answer_watch_days (day, org_id, brand_id, waiting_over_hour, max_waiting_over_hour, people, sampled_at)
        VALUES (${day}::date, ${s.org_id}, ${s.brand_id}, ${late.length}, ${late.length}, ${JSON.stringify(late)}::jsonb, ${now.toISOString()}::timestamptz)
        ON CONFLICT (day, org_id, brand_id) DO UPDATE SET
          waiting_over_hour = EXCLUDED.waiting_over_hour,
          max_waiting_over_hour = GREATEST(awaiting_answer_watch_days.max_waiting_over_hour, EXCLUDED.waiting_over_hour),
          people = EXCLUDED.people,
          sampled_at = EXCLUDED.sampled_at
      `;
    } catch (error) {
      failed += 1;
      console.error(`[lead-service] awaiting-answer watch: brand ${s.brand_id} (org ${s.org_id}) unreadable:`, error);
    }
  }
  await sql`INSERT INTO awaiting_answer_watch_sweeps (finished_at, brands, failed_brands) VALUES (${now.toISOString()}::timestamptz, ${scopes.length}, ${failed})`;
  return { brands: scopes.length, failed, waiting };
}

let sweeping = false;
export function startAwaitingAnswerWatchWorker(): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await runAwaitingAnswerWatch();
      if (r.waiting > 0 || r.failed > 0) console.log(`[lead-service] awaiting-answer watch: brands=${r.brands} failed=${r.failed} waitingOverHour=${r.waiting}`);
    } catch (error) {
      console.error("[lead-service] awaiting-answer watch sweep failed:", error);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS).unref();
  setInterval(() => void tick(), WATCH_INTERVAL_MS).unref();
}

export interface AwaitingAnswerWatch {
  generatedAt: string;
  days: number;
  status: "ok" | "red";
  redAfterMinutes: number;
  lastSweepAt: string | null;
  sweepStale: boolean;
  lastSweepFailedBrands: number;
  waiting: Array<WaitingPerson & { orgId: string; brandId: string }>;
  byDay: Array<{ day: string; waitingOverHour: number; maxWaitingOverHour: number }>;
}

/** The Monitoring read: the latest sample per brand (today's row) and the daily series. */
export async function readAwaitingAnswerWatch(days: number, now: Date = new Date()): Promise<AwaitingAnswerWatch> {
  const [sweep] = (await sql`SELECT finished_at, failed_brands FROM awaiting_answer_watch_sweeps ORDER BY finished_at DESC LIMIT 1`) as unknown as Array<{ finished_at: Date; failed_brands: number }>;
  const lastSweepAt = sweep ? new Date(sweep.finished_at) : null;
  const sweepStale = !lastSweepAt || now.getTime() - lastSweepAt.getTime() > STALE_AFTER_MS;
  const latest = lastSweepAt
    ? ((await sql`
        SELECT org_id, brand_id, people FROM awaiting_answer_watch_days
        WHERE sampled_at = ${lastSweepAt.toISOString()}::timestamptz AND waiting_over_hour > 0
      `) as unknown as Array<{ org_id: string; brand_id: string; people: WaitingPerson[] | string }>)
    : [];
  const waiting = latest
    .flatMap((r) => (typeof r.people === "string" ? (JSON.parse(r.people) as WaitingPerson[]) : r.people).map((p) => ({ ...p, orgId: r.org_id, brandId: r.brand_id })))
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = (await sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day_text, SUM(waiting_over_hour)::int AS w, SUM(max_waiting_over_hour)::int AS m
    FROM awaiting_answer_watch_days WHERE day >= ${since}::date GROUP BY day ORDER BY 1
  `) as unknown as Array<{ day_text: string; w: number; m: number }>;
  return {
    generatedAt: now.toISOString(),
    days,
    status: waiting.length > 0 || sweepStale ? "red" : "ok",
    redAfterMinutes: RED_AFTER_MS / 60_000,
    lastSweepAt: lastSweepAt?.toISOString() ?? null,
    sweepStale,
    lastSweepFailedBrands: sweep?.failed_brands ?? 0,
    waiting,
    byDay: rows.map((r) => ({ day: r.day_text, waitingOverHour: Number(r.w), maxWaitingOverHour: Number(r.m) })),
  };
}
