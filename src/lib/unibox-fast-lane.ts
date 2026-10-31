/**
 * The Unibox FAST LANE (UNIBOX-REPLY-LAG-1031, background thread every `FAST_LANE_INTERVAL_MS`).
 *
 * Why: the relationship sweep (relationship-sweep.ts) rebuilds every brand one after the other; one round over the
 * fleet now takes over an hour (Doc Dinners alone ~21k relations), so a prospect who answered our email positively
 * showed in the Unibox as "not asked / no reply yet" for ~1-1.5 h (Richard Jones, Doc Dinners, 2026-10-30 21:57 UTC).
 *
 * What: every pass reads what ARRIVED since the last one, on our own copies, by their `seq` (never a time guess):
 *   - outreach replies (`outreach_facts` type `reply`): labelled on the timeline now (timeline-facts.ts `syncRepliesNow`);
 *   - crm facts of THEIRS (`INBOUND_FACT_TYPES`: a message, a signup, a form, a meeting, a payment);
 * finds the people they belong to (the relations whose contact points / addresses carry them), and for those people
 * only runs the sweep's own steps, by the same code: their subjects (`refreshSubjects` with `humans`), their tags and
 * wants-business judgments (Jev, the sweep's `judgeSubjects`, bounded per pass), their Unibox rows (`refreshUniboxRows`
 * with `humans`). Nothing here decides anything the sweep would not: it decides it sooner.
 *
 * A sweep round that read the brand before the fast lane wrote would write the old state back: the humans refreshed
 * meanwhile are refreshed again once that round ends (unibox-fast-lane-state.ts).
 *
 * Measured (`measureUniboxReplyLag`, every `LAG_CHECK_INTERVAL_MS`): the oldest arrival of the last hours not yet on its
 * Unibox row, posted to features-service's box checks (`unibox-reply-lag`), red on the Monitoring hub past
 * `LAG_RED_AFTER_MINUTES`. Never an email.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { FEATURES_SERVICE_API_KEY, FEATURES_SERVICE_URL } from "../config.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { errorMessage } from "./db-error.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { INBOUND_FACT_TYPES } from "./relationship-intent.js";
import { intentSubjectsToJudge } from "./relationship-intent-judge.js";
import { subjectsToJudge } from "./relationship-judge.js";
import { canonicalHumans, refreshSubjects, type Scope } from "./relationship-subjects.js";
import { judgeSubjects } from "./relationship-sweep.js";
import { outreachRow, syncRepliesNow } from "./timeline-facts.js";
import { WORD_LABELS, type TimelineItemLabel } from "./timeline-labels.js";
import { refreshUniboxRows } from "./unibox-model.js";
import { lastSweepRound, noteFastLaneRefreshed, takeRechecks } from "./unibox-fast-lane-state.js";

export const FAST_LANE_INTERVAL_MS = 30_000;
const FIRST_DELAY_MS = 60_000;
/** At boot the fast lane re-reads what arrived in the last half hour (the background thread was down while deploying). */
const BOOT_LOOKBACK_MS = 30 * 60_000;
/** Rows read per statement; a pass keeps reading until it reached the copy's end (or `MAX_STEPS_PER_PASS`). */
const ROWS_PER_STEP = 5_000;
const MAX_STEPS_PER_PASS = 10;
/** Jev questions per brand per pass (the sweep asks the rest on its round). */
export const FAST_JUDGE_PER_SCOPE = 10;
export const FAST_INTENT_PER_SCOPE = 10;

/**
 * The red line. Lead response research agrees the first minutes decide a reply: the MIT / InsideSales Lead Response
 * Management study (Oldroyd, 2007) measured the odds of reaching a lead fall ~100x between 5 and 30 min, and
 * HBR's "The Short Life of Online Sales Leads" (Oldroyd, McElheran, Elkington, 2011) the odds of qualifying ~7x past the
 * first hour; the industry's "5-minute rule" follows. A reply the client cannot SEE within 5 min already costs that
 * window, so the check is red past 5 min (target: one pass, 30 s, plus the copy's own pull).
 */
export const LAG_RED_AFTER_MINUTES = 5;
export const LAG_CHECK_INTERVAL_MS = 5 * 60_000;
/** Arrivals of the last N hours are checked (older ones are the sweep's history, never a live lag). */
const LAG_WINDOW_MS = 6 * 60 * 60_000;
export const LAG_CHECK_NAME = "unibox-reply-lag";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopeKey = (s: Scope) => `${s.orgId}|${s.brandId}`;

/** The seq of the newest row received before `cutoff`: a backward walk of the seq index over the few rows newer. */
async function seqBefore(table: "crm_facts" | "outreach_facts", cutoff: Date): Promise<bigint> {
  const rows = (await db.execute(sql`
    SELECT seq::text AS seq FROM ${sql.raw(table)} WHERE received_at < ${cutoff.toISOString()}::timestamptz ORDER BY seq DESC LIMIT 1
  `)) as unknown as Array<{ seq: string }>;
  return rows[0] ? BigInt(rows[0].seq) : 0n;
}

interface CrmArrival {
  seq: string;
  org_id: string;
  brand_id: string;
  human: string | null;
  contact_point: string | null;
}

/** Tests only: a pass (or a measure) that reads one org's arrivals, so parallel suites on one database never meet. */
export interface FastLaneTestScope {
  onlyOrgId?: string;
}
const orgFilter = (t: FastLaneTestScope, column: string) =>
  t.onlyOrgId === undefined ? sql`` : sql`AND ${sql.raw(column)} = ${t.onlyOrgId}`;

/** The next rows after `after`, by seq (any type, so the cursor moves past what is not theirs); arrivals = theirs. */
async function crmArrivals(after: bigint, t: FastLaneTestScope): Promise<{ last: bigint | null; arrivals: CrmArrival[] }> {
  const rows = (await db.execute(sql`
    SELECT f.seq::text AS seq, f.type, f.org_id, f.brand_id, f.raw->>'humanId' AS human, f.contact_point
    FROM crm_facts f
    WHERE f.seq > ${after.toString()}::bigint ${orgFilter(t, "f.org_id")}
    ORDER BY f.seq LIMIT ${ROWS_PER_STEP}
  `)) as unknown as Array<CrmArrival & { type: string }>;
  const inbound = new Set<string>(INBOUND_FACT_TYPES);
  return { last: rows.length ? BigInt(rows[rows.length - 1].seq) : null, arrivals: rows.filter((r) => inbound.has(r.type)) };
}

async function outreachReplyKeys(after: bigint, t: FastLaneTestScope): Promise<{ last: bigint | null; keys: string[] }> {
  const rows = (await db.execute(sql`
    SELECT seq::text AS seq, type, subject_key FROM outreach_facts
    WHERE seq > ${after.toString()}::bigint ${orgFilter(t, "org_id")}
    ORDER BY seq LIMIT ${ROWS_PER_STEP}
  `)) as unknown as Array<{ seq: string; type: string; subject_key: string }>;
  return {
    last: rows.length ? BigInt(rows[rows.length - 1].seq) : null,
    keys: [...new Set(rows.filter((r) => r.type === "reply").map((r) => r.subject_key))],
  };
}

/** The humans whose relations carry these contact points or addresses at the brand. */
async function subjectHumans(scope: Scope, points: readonly string[], emails: readonly string[]): Promise<string[]> {
  if (points.length === 0 && emails.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT DISTINCT human_id::text AS human FROM relationship_subjects
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}
      AND (contact_points && ${sql.param([...points])}::text[] OR emails && ${sql.param([...emails])}::text[])
  `)) as unknown as Array<{ human: string }>;
  return rows.map((r) => r.human);
}

export interface FastLaneScopeResult {
  scope: Scope;
  humans: number;
  subjects: number;
  judged: number;
  intentJudged: number;
  uniboxRows: number;
  error: string | null;
}

/**
 * Refresh these people of one brand by the sweep's own steps. A judgment failure (Jev down, org out of credit) never
 * stops the rest: the Unibox still shows their message and "waiting on us"; the verdict follows on a later pass.
 */
export async function refreshPeopleNow(scope: Scope, humans: readonly string[]): Promise<FastLaneScopeResult> {
  const result: FastLaneScopeResult = { scope, humans: 0, subjects: 0, judged: 0, intentJudged: 0, uniboxRows: 0, error: null };
  const atomic = humans.filter((h) => UUID_RE.test(h));
  if (atomic.length === 0) return result;
  const canonOf = await canonicalHumans(scope.orgId, atomic);
  const canon = [...new Set(atomic.map((h) => canonOf.get(h) ?? h))].sort();
  result.humans = canon.length;
  result.subjects = (await refreshSubjects(scope, { humans: canon })).subjects;
  try {
    const pass = await judgeSubjects(scope, {
      tags: (cardHash) => subjectsToJudge(scope, FAST_JUDGE_PER_SCOPE, cardHash, canon),
      intent: () => intentSubjectsToJudge(scope, FAST_INTENT_PER_SCOPE, canon),
    });
    result.judged = pass.judged;
    result.intentJudged = pass.intentJudged;
  } catch (err) {
    result.error = errorMessage(err);
    console.error(`[lead-service] unibox fast lane: judgments failed for org ${scope.orgId} brand ${scope.brandId} (their rows still refresh):`, err);
  }
  result.uniboxRows = (await refreshUniboxRows(scope, { humans: canon })).rows;
  noteFastLaneRefreshed(scope, canon);
  return result;
}

const cursors: { crm: bigint | null; outreach: bigint | null } = { crm: null, outreach: null };
/** People a failed pass could not refresh, asked again next pass. */
const retry = new Map<string, Set<string>>();

/** Tests only. */
export function resetFastLaneCursors(at?: { crm: bigint; outreach: bigint }): void {
  cursors.crm = at?.crm ?? null;
  cursors.outreach = at?.outreach ?? null;
  retry.clear();
}

/** One pass: read what arrived, refresh those people. Returns one result per brand touched. */
export async function fastLanePass(now = new Date(), t: FastLaneTestScope = {}): Promise<FastLaneScopeResult[]> {
  const boot = new Date(now.getTime() - BOOT_LOOKBACK_MS);
  if (cursors.crm === null) cursors.crm = await seqBefore("crm_facts", boot);
  if (cursors.outreach === null) cursors.outreach = await seqBefore("outreach_facts", boot);
  const cur = cursors as { crm: bigint; outreach: bigint };

  const perScope = new Map<string, { scope: Scope; humans: Set<string>; points: Set<string>; emails: Set<string> }>();
  const at = (orgId: string, brandId: string) => {
    const k = `${orgId}|${brandId}`;
    let e = perScope.get(k);
    if (!e) perScope.set(k, (e = { scope: { orgId, brandId }, humans: new Set(), points: new Set(), emails: new Set() }));
    return e;
  };

  for (let i = 0; i < MAX_STEPS_PER_PASS; i++) {
    const { last, arrivals } = await crmArrivals(cur.crm, t);
    if (last === null) break;
    for (const f of arrivals) {
      const e = at(f.org_id, f.brand_id);
      if (f.human && UUID_RE.test(f.human)) e.humans.add(f.human);
      if (f.contact_point) e.points.add(f.contact_point);
    }
    cur.crm = last;
  }
  for (let i = 0; i < MAX_STEPS_PER_PASS; i++) {
    const { last, keys } = await outreachReplyKeys(cur.outreach, t);
    if (last === null) break;
    try {
      for (const r of await syncRepliesNow(keys)) at(r.orgId, r.brandId).emails.add(r.email);
    } catch (err) {
      console.error(`[lead-service] unibox fast lane: outreach replies after seq ${cur.outreach} not labelled yet (retried next pass):`, err);
      break;
    }
    cur.outreach = last;
  }
  for (const { orgId, brandId, humans } of takeRechecks()) {
    if (t.onlyOrgId !== undefined && orgId !== t.onlyOrgId) continue;
    for (const h of humans) at(orgId, brandId).humans.add(h);
  }
  for (const [k, hs] of retry) {
    const [orgId, brandId] = k.split("|");
    for (const h of hs) at(orgId, brandId).humans.add(h);
  }
  retry.clear();

  const out: FastLaneScopeResult[] = [];
  for (const e of perScope.values()) {
    const humans = new Set(e.humans);
    try {
      for (const h of await subjectHumans(e.scope, [...e.points], [...e.emails])) humans.add(h);
      if (humans.size === 0) continue;
      out.push(await refreshPeopleNow(e.scope, [...humans]));
    } catch (err) {
      retry.set(scopeKey(e.scope), humans);
      console.error(`[lead-service] unibox fast lane failed for org ${e.scope.orgId} brand ${e.scope.brandId} (${humans.size} people, retried next pass):`, err);
    }
  }
  return out;
}

export interface UniboxReplyLag {
  /** Minutes the oldest arrival not yet on its Unibox row has waited (0 = none waiting). */
  lagMinutes: number;
  /** Arrivals of the window not yet on their row. */
  waiting: number;
  /** Arrivals of the window checked (on a relation that has a Unibox row). */
  checked: number;
  oldest: { orgId: string; brandId: string; receivedAt: string; kind: "crm" | "reply" } | null;
}

interface Arrival {
  orgId: string;
  brandId: string;
  point: string | null;
  email: string | null;
  occurredAt: string;
  receivedAt: string;
  kind: "crm" | "reply";
}

/**
 * The lag as the client sees it: every arrival of the last `LAG_WINDOW_MS` (a crm fact of theirs, an outreach reply
 * whose label is a word of theirs) on a relation that has a Unibox row, and whether that row's last word from them
 * already covers it. The oldest one still not covered is the lag. Read off the stores, independent of the fast lane.
 */
export async function measureUniboxReplyLag(now = new Date(), t: FastLaneTestScope = {}): Promise<UniboxReplyLag> {
  const since = new Date(now.getTime() - LAG_WINDOW_MS);
  const [crmFrom, outFrom] = await Promise.all([seqBefore("crm_facts", since), seqBefore("outreach_facts", since)]);
  const crm = (await db.execute(sql`
    SELECT f.org_id, f.brand_id, f.contact_point, f.occurred_at, f.received_at
    FROM crm_facts f
    WHERE f.seq > ${crmFrom.toString()}::bigint AND f.type = ANY(${sql.param([...INBOUND_FACT_TYPES])}::text[])
      AND f.occurred_at IS NOT NULL AND f.contact_point IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id) ${orgFilter(t, "f.org_id")}
  `)) as unknown as Array<{ org_id: string; brand_id: string; contact_point: string; occurred_at: Date | string; received_at: Date | string }>;
  const replies = (await db.execute(sql`
    SELECT DISTINCT ON (o.subject_key) o.seq::text AS seq, o.subject_key, o.type, o.occurred_at, o.lead_email, o.campaign_id, o.raw,
      o.org_id, o.brand_ids, o.received_at
    FROM outreach_facts o
    WHERE o.subject_key IN (SELECT subject_key FROM outreach_facts WHERE seq > ${outFrom.toString()}::bigint AND type = 'reply' ${orgFilter(t, "org_id")})
    ORDER BY o.subject_key, o.seq DESC
  `)) as unknown as Array<{
    seq: string; subject_key: string; type: string; occurred_at: Date | string | null; lead_email: string; campaign_id: string | null;
    raw: Record<string, unknown>; org_id: string; brand_ids: string[]; received_at: Date | string;
  }>;
  const arrivals: Arrival[] = crm.map((f) => ({
    orgId: f.org_id, brandId: f.brand_id, point: f.contact_point, email: null,
    occurredAt: toIsoTimestamp(f.occurred_at)!, receivedAt: toIsoTimestamp(f.received_at)!, kind: "crm" as const,
  }));
  // Only a reply that is a word of THEIRS reaches the Unibox (the rule `outreachRow` applies), and only one on an
  // address a lead holds (else no timeline row can carry it).
  const registered = new Set(
    ((await db.execute(sql`
      SELECT DISTINCT lower(value) AS email FROM lead_contact_methods
      WHERE channel = 'email' AND lower(value) = ANY(${sql.param([...new Set(replies.map((r) => r.lead_email.toLowerCase()))])}::text[])
    `)) as unknown as Array<{ email: string }>).map((r) => r.email),
  );
  for (const r of replies) {
    if (r.type !== "reply" || r.occurred_at === null || !registered.has(r.lead_email.toLowerCase())) continue;
    for (const brandId of r.brand_ids) {
      const row = await outreachRow(r.org_id, brandId, r, "00000000-0000-4000-8000-000000000000", new Map(), async () => []);
      if (row === "unjudged" || row === "unplaced" || !WORD_LABELS.has(row.label as TimelineItemLabel)) continue;
      arrivals.push({
        orgId: r.org_id, brandId, point: null, email: r.lead_email.toLowerCase(),
        occurredAt: toIsoTimestamp(r.occurred_at)!, receivedAt: toIsoTimestamp(r.received_at)!, kind: "reply",
      });
    }
  }
  const byScope = new Map<string, Arrival[]>();
  for (const a of arrivals) byScope.set(`${a.orgId}|${a.brandId}`, [...(byScope.get(`${a.orgId}|${a.brandId}`) ?? []), a]);

  const lag: UniboxReplyLag = { lagMinutes: 0, waiting: 0, checked: 0, oldest: null };
  for (const list of byScope.values()) {
    const { orgId, brandId } = list[0];
    const points = [...new Set(list.map((a) => a.point).filter((p): p is string => p !== null))];
    const emails = [...new Set(list.map((a) => a.email).filter((e): e is string => e !== null))];
    // The relation's row, as the client reads it (a relation with no row, e.g. the org's own team, is not checked).
    const rows = (await db.execute(sql`
      SELECT s.contact_points, s.emails, u.last_theirs_at
      FROM relationship_subjects s
      JOIN unibox_rows u ON u.org_id = s.org_id AND u.brand_id = s.brand_id AND u.human_id = s.human_id AND u.company_key = s.company_key
      WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId}
        AND (s.contact_points && ${sql.param(points)}::text[] OR s.emails && ${sql.param(emails)}::text[])
    `)) as unknown as Array<{ contact_points: string[]; emails: string[]; last_theirs_at: Date | string | null }>;
    for (const a of list) {
      const mine = rows.filter((r) => (a.point !== null && r.contact_points.includes(a.point)) || (a.email !== null && r.emails.includes(a.email)));
      if (mine.length === 0) continue;
      lag.checked++;
      const covered = mine.some((r) => {
        const t = toIsoTimestamp(r.last_theirs_at);
        return t !== null && Date.parse(t) >= Date.parse(a.occurredAt);
      });
      if (covered) continue;
      lag.waiting++;
      const waited = Math.max(0, (now.getTime() - Date.parse(a.receivedAt)) / 60_000);
      if (lag.oldest === null || waited > lag.lagMinutes) {
        lag.lagMinutes = waited;
        lag.oldest = { orgId, brandId, receivedAt: a.receivedAt, kind: a.kind };
      }
    }
  }
  lag.lagMinutes = Math.round(lag.lagMinutes * 10) / 10;
  return lag;
}

/** PURE: the box check run for a measured lag (red only past the line: a reply waiting a few seconds is normal). */
export function lagCheckRun(lag: UniboxReplyLag, now: Date): Record<string, unknown> {
  const ok = lag.lagMinutes <= LAG_RED_AFTER_MINUTES;
  const round = lastSweepRound();
  return {
    check: LAG_CHECK_NAME,
    ranAt: now.toISOString(),
    ok,
    reason: ok
      ? lag.waiting === 0
        ? `Every reply of the last ${LAG_WINDOW_MS / 3_600_000} h shows in the Unibox (${lag.checked} checked).`
        : `${lag.waiting} replies are on their way to the Unibox, the oldest for ${lag.lagMinutes} min.`
      : `A reply has waited ${lag.lagMinutes} min to show in the Unibox (over ${LAG_RED_AFTER_MINUTES} min); ${lag.waiting} waiting.`,
    cadenceMinutes: LAG_CHECK_INTERVAL_MS / 60_000,
    label: "Unibox: replies shown",
    value: lag.lagMinutes,
    unit: "minutes",
    details: {
      waiting: lag.waiting,
      checked: lag.checked,
      oldest: lag.oldest,
      redAfterMinutes: LAG_RED_AFTER_MINUTES,
      fullSweepRoundMinutes: round ? Math.round((round.endedAt - round.startedAt) / 6_000) / 10 : null,
      fullSweepRoundEndedAt: round ? new Date(round.endedAt).toISOString() : null,
    },
  };
}

async function postLagCheck(run: Record<string, unknown>): Promise<void> {
  const res = await fetchWithRetry(`${FEATURES_SERVICE_URL}/internal/box-checks/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": FEATURES_SERVICE_API_KEY },
    body: JSON.stringify({ runs: [run] }),
  });
  if (!res.ok) throw new Error(`features-service box-checks answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export function startUniboxFastLaneWorker(): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await fastLanePass();
      for (const r of results) {
        if (r.uniboxRows || r.judged || r.intentJudged) {
          console.log(`[lead-service] unibox fast lane ${r.scope.brandId}: ${r.humans} people, ${r.uniboxRows} rows, judged ${r.judged}, intent ${r.intentJudged}`);
        }
      }
    } catch (err) {
      console.error("[lead-service] unibox fast lane pass failed (retried next pass):", err);
    } finally {
      running = false;
    }
  };
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const now = new Date();
      const run = lagCheckRun(await measureUniboxReplyLag(now), now);
      await postLagCheck(run);
      if (!run.ok) console.error(`[lead-service] unibox reply lag: ${String(run.reason)}`);
    } catch (err) {
      console.error("[lead-service] unibox reply lag check failed:", err);
    } finally {
      checking = false;
    }
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), FAST_LANE_INTERVAL_MS).unref();
  setTimeout(() => void check(), FIRST_DELAY_MS * 2).unref();
  setInterval(() => void check(), LAG_CHECK_INTERVAL_MS).unref();
}
