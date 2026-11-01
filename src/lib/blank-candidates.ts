/**
 * A CANDIDATE WE CANNOT SEE IS NEVER JUDGED (BLANK-CANDIDATES-1101, owner 2026-11-01).
 *
 * The pre-pay screen (candidate-serve.ts) asks Jev whether a candidate belongs to the audience the client described,
 * and a decline is final for that person. When human-service offered candidates with an EMPTY teaser (no name, title,
 * headline, company name, industry, size, place or keyword), Jev saw nothing, answered P(yes) ~0.07-0.12 and every one
 * was declined: Doc Dinners 355/355 on 2026-10-31, ~4,150 fleet-wide since 2026-10-27, each judgment paid and the person
 * thrown away (54c84f52…: an employed chiropractor, exactly the target, declined at 0.07).
 *
 * Rules:
 * - "Blank" = every field the screen reads (`screenSnapshot`) is empty but the person's name. The company DOMAIN is
 *   not a screen input, and a name says nothing about the audience. One other non-empty field and the screen judges.
 * - A blank candidate is neither passed nor declined, and no judgment is asked (nothing billed). The serve stops asking
 *   that audience for this run (`pending`: an unfinished look, never exhaustion) so the same candidate is not looped on.
 * - It is a LOUD failure of the producer: logged as an error with its candidate id, and kept in `blank_candidates`
 *   (one row per candidate, seen count) which the `blank-candidates` box check reads: red on the Monitoring hub while
 *   blank candidates arrive. Never an email.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { FEATURES_SERVICE_API_KEY, FEATURES_SERVICE_URL } from "../config.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { Candidate } from "./people-client.js";

export const BLANK_CHECK_NAME = "blank-candidates";
/** Red while a blank candidate was offered within this window: the producer is broken NOW. */
export const BLANK_RED_WINDOW_MINUTES = 60;
export const BLANK_CHECK_INTERVAL_MS = 5 * 60_000;
const FIRST_DELAY_MS = 90_000;

function filled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.some(filled);
  return true;
}

/**
 * PURE: does the candidate carry NOTHING the screen could judge? The company domain is not a screen input, and a NAME
 * alone says nothing about belonging to an audience: blank = no title, headline, seniority, place, company name,
 * industry, size or keyword.
 */
export function isBlankCandidate(c: Candidate): boolean {
  const p = c.person ?? ({} as Candidate["person"]);
  const co = c.company ?? ({} as Candidate["company"]);
  const fields: unknown[] = [
    p.title,
    p.headline,
    p.seniority,
    p.city,
    p.state,
    p.country,
    co.name,
    co.industry,
    co.employees,
    co.city,
    co.state,
    co.country,
    co.keywords,
  ];
  return !fields.some(filled);
}

/** Thrown by the screen itself if a blank candidate ever reaches it (the stored script's door included). */
export class BlankCandidateError extends Error {
  constructor(readonly candidateId: string) {
    super(`candidate ${candidateId} has an empty teaser: nothing to screen, neither passed nor declined`);
    this.name = "BlankCandidateError";
  }
}

/** Log + record one sighting. A failed write is logged (the error line above it is the loud signal), never thrown. */
export async function noteBlankCandidate(c: Candidate, ctx: { orgId: string; brandId?: string | null; runId?: string | null }): Promise<void> {
  console.error(
    `[lead-service] BLANK CANDIDATE candidate=${c.candidateId} audience=${c.audienceId} org=${ctx.orgId} brand=${ctx.brandId ?? "-"} run=${ctx.runId ?? "-"}: human-service offered an empty teaser; not screened, not passed, not declined, no judgment billed`,
  );
  try {
    await db.execute(sql`
      INSERT INTO blank_candidates (candidate_id, org_id, brand_id, audience_id, provider_person_id, run_id)
      VALUES (${c.candidateId}, ${ctx.orgId}, ${ctx.brandId ?? null}, ${c.audienceId}, ${c.providerPersonId}, ${ctx.runId ?? null})
      ON CONFLICT (candidate_id) DO UPDATE
        SET seen_count = blank_candidates.seen_count + 1, last_seen_at = now(), run_id = EXCLUDED.run_id
    `);
  } catch (error) {
    console.error(`[lead-service] blank candidate ${c.candidateId} NOT recorded:`, error);
  }
}

export interface BlankCandidatesMeasure {
  lastWindow: number;
  last24h: number;
  byAudience: Array<{ orgId: string; brandId: string | null; audienceId: string; candidates: number; lastSeenAt: string | null; exampleCandidateIds: string[] }>;
}

export async function measureBlankCandidates(): Promise<BlankCandidatesMeasure> {
  const [totals] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE last_seen_at >= now() - make_interval(mins => ${BLANK_RED_WINDOW_MINUTES}))::int AS last_window,
      count(*)::int AS last_24h
    FROM blank_candidates
    WHERE last_seen_at >= now() - interval '24 hours'
  `)) as unknown as Array<{ last_window: number; last_24h: number }>;
  const rows = (await db.execute(sql`
    SELECT org_id, brand_id, audience_id, count(*)::int AS candidates, max(last_seen_at) AS last_seen_at,
           (array_agg(candidate_id ORDER BY last_seen_at DESC))[1:3] AS examples
    FROM blank_candidates
    WHERE last_seen_at >= now() - interval '24 hours'
    GROUP BY org_id, brand_id, audience_id
    ORDER BY count(*) DESC
    LIMIT 10
  `)) as unknown as Array<{ org_id: string; brand_id: string | null; audience_id: string; candidates: number; last_seen_at: Date | string | null; examples: string[] }>;
  return {
    lastWindow: Number(totals?.last_window ?? 0),
    last24h: Number(totals?.last_24h ?? 0),
    byAudience: rows.map((r) => ({
      orgId: r.org_id,
      brandId: r.brand_id,
      audienceId: r.audience_id,
      candidates: Number(r.candidates),
      lastSeenAt: toIsoTimestamp(r.last_seen_at),
      exampleCandidateIds: r.examples ?? [],
    })),
  };
}

/** PURE: the box check run for a measure (red only while blank candidates arrive). */
export function blankCandidatesCheckRun(m: BlankCandidatesMeasure, now: Date): Record<string, unknown> {
  const ok = m.lastWindow === 0;
  return {
    check: BLANK_CHECK_NAME,
    ranAt: now.toISOString(),
    ok,
    reason: ok
      ? m.last24h === 0
        ? "Every candidate offered in the last 24 h carried a profile to judge."
        : `No empty profile in the last ${BLANK_RED_WINDOW_MINUTES} min (${m.last24h} in the last 24 h, none judged or thrown away).`
      : `${m.lastWindow} candidates arrived with an empty profile in the last ${BLANK_RED_WINDOW_MINUTES} min: nobody can be screened on those audiences, so they serve nobody.`,
    cadenceMinutes: BLANK_CHECK_INTERVAL_MS / 60_000,
    label: "Lead sourcing: candidates with an empty profile",
    value: m.last24h,
    unit: "candidates (24 h)",
    details: { lastWindow: m.lastWindow, redWindowMinutes: BLANK_RED_WINDOW_MINUTES, byAudience: m.byAudience },
  };
}

async function postCheck(run: Record<string, unknown>): Promise<void> {
  const res = await fetchWithRetry(`${FEATURES_SERVICE_URL}/internal/box-checks/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": FEATURES_SERVICE_API_KEY },
    body: JSON.stringify({ runs: [run] }),
  });
  if (!res.ok) throw new Error(`features-service box-checks answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export function startBlankCandidatesCheck(): void {
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const run = blankCandidatesCheckRun(await measureBlankCandidates(), now);
      await postCheck(run);
      if (!run.ok) console.error(`[lead-service] blank candidates: ${String(run.reason)}`);
    } catch (err) {
      console.error("[lead-service] blank candidates check failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void check(), FIRST_DELAY_MS).unref();
  setInterval(() => void check(), BLANK_CHECK_INTERVAL_MS).unref();
}
