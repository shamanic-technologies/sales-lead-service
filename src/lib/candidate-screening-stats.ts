import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { YES_THRESHOLD } from "./qualification.js";

/**
 * HOW THE SCREEN BEFORE THE PAID REVEAL DECIDED, FLEET-WIDE, BY MONTH (LIVE-RESEARCH-1018, owner 2026-10-18).
 * `GET /internal/candidate-screenings/stats`: features-service serves the staff Research page live off it (it used to
 * be counted straight in this database by a nightly script).
 *
 * Population = every `candidate_screenings` row (one Jev verdict per audience x person x target text x prompt version,
 * src/lib/candidate-serve.ts), since lead-service took the screen over (2026-10-07; human-service's earlier screen is
 * human-service's to state). Month = UTC calendar month of the verdict. Two views of the same people, each a PARTITION
 * of `screened`: by verdict (pass / decline) and by P(yes) bucket (the pass bar is P(yes) > 0.5, the edge of the
 * 0.2-0.5 and 0.5-0.8 buckets; a row with no P(yes) is `unscored`). Distinct orgs/audiences/brands over the whole
 * period. One aggregate over a table of tens of thousands of rows: no paging, no cache. A verdict outside
 * pass/reject THROWS (never folded into a side).
 */

export const SCREEN_RECORDED_SINCE = "2026-10-07T00:00:00.000Z";

export const PROBABILITY_BUCKETS = ["below_0_2", "from_0_2_to_0_5", "above_0_5_below_0_8", "from_0_8", "unscored"] as const;
export type ProbabilityBucket = (typeof PROBABILITY_BUCKETS)[number];

export interface ScreeningCell {
  month: string;
  bucket: ProbabilityBucket;
  verdict: string;
  people: number;
}

export interface ScreeningCounts {
  screened: number;
  passed: number;
  declined: number;
  byProbability: Record<ProbabilityBucket, { screened: number; passed: number; declined: number }>;
}

export interface CandidateScreeningStats {
  recordedSince: string;
  passThreshold: number;
  firstScreenedAt: string | null;
  lastScreenedAt: string | null;
  distinct: { orgs: number; brands: number; audiences: number };
  totals: ScreeningCounts;
  months: Array<ScreeningCounts & { month: string }>;
}

/** Test-only narrowing: the integration suite shares one database with every other suite. */
export interface ScreeningStatsScope {
  orgIds: string[];
}

function emptyCounts(): ScreeningCounts {
  const byProbability = Object.fromEntries(PROBABILITY_BUCKETS.map((b) => [b, { screened: 0, passed: 0, declined: 0 }])) as ScreeningCounts["byProbability"];
  return { screened: 0, passed: 0, declined: 0, byProbability };
}

function add(counts: ScreeningCounts, cell: ScreeningCell): void {
  const side = cell.verdict === "pass" ? "passed" : cell.verdict === "reject" ? "declined" : null;
  if (!side) throw new Error(`candidate_screenings verdict "${cell.verdict}" is neither pass nor reject`);
  counts.screened += cell.people;
  counts[side] += cell.people;
  const bucket = counts.byProbability[cell.bucket];
  if (!bucket) throw new Error(`unknown P(yes) bucket "${cell.bucket}"`);
  bucket.screened += cell.people;
  bucket[side] += cell.people;
}

/** Pure fold of the per (month, bucket, verdict) cells: months oldest first. */
export function foldScreeningCells(cells: ScreeningCell[]): { totals: ScreeningCounts; months: CandidateScreeningStats["months"] } {
  const totals = emptyCounts();
  const byMonth = new Map<string, ScreeningCounts>();
  for (const cell of cells) {
    add(totals, cell);
    let m = byMonth.get(cell.month);
    if (!m) byMonth.set(cell.month, (m = emptyCounts()));
    add(m, cell);
  }
  const months = [...byMonth.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([month, c]) => ({ month, ...c }));
  return { totals, months };
}

type Row = Record<string, unknown>;
const toInt = (v: unknown): number => Number(v);

export async function readCandidateScreeningStats(scope?: ScreeningStatsScope): Promise<CandidateScreeningStats> {
  const where = scope ? sql`WHERE org_id = ANY(${sql.param(scope.orgIds)}::text[])` : sql``;
  const cellsResult = await db.execute(sql`
    SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
           CASE WHEN yes_probability IS NULL THEN 'unscored'
                WHEN yes_probability < 0.2 THEN 'below_0_2'
                WHEN yes_probability <= 0.5 THEN 'from_0_2_to_0_5'
                WHEN yes_probability < 0.8 THEN 'above_0_5_below_0_8'
                ELSE 'from_0_8' END AS bucket,
           verdict,
           count(*)::int AS people
    FROM candidate_screenings ${where}
    GROUP BY 1, 2, 3`);
  const reachResult = await db.execute(sql`
    SELECT count(DISTINCT org_id)::int AS orgs, count(DISTINCT brand_id)::int AS brands,
           count(DISTINCT audience_id)::int AS audiences, min(created_at) AS first_at, max(created_at) AS last_at
    FROM candidate_screenings ${where}`);
  const cells = (cellsResult as unknown as Row[]).map((r) => ({
    month: String(r.month),
    bucket: String(r.bucket) as ProbabilityBucket,
    verdict: String(r.verdict),
    people: toInt(r.people),
  }));
  const reach = (reachResult as unknown as Row[])[0] ?? {};
  return {
    recordedSince: SCREEN_RECORDED_SINCE,
    passThreshold: YES_THRESHOLD,
    firstScreenedAt: toIsoTimestamp(reach.first_at as Date | string | null),
    lastScreenedAt: toIsoTimestamp(reach.last_at as Date | string | null),
    distinct: { orgs: toInt(reach.orgs ?? 0), brands: toInt(reach.brands ?? 0), audiences: toInt(reach.audiences ?? 0) },
    ...foldScreeningCells(cells),
  };
}
