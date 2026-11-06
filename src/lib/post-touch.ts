/**
 * A VISIT THAT CAME FROM A CLICK ON ONE OF OUR LINKS IS CREDITED TO THE EXACT UNIT THE LINK CAME FROM, WHATEVER THAT
 * UNIT'S OUTCOME (FACTORY-P2-CONTENT-OUTCOMES 2026-10-28; OUTCOME-FINEST-1106: one outcome per network and step).
 *
 * A producer stamps every link to our sites with the Unit it belongs to, so a visit through it and every later state of
 * the same person are tied to that Unit's run on the ledger (features-service ranks posts and newsletter releases by
 * visits and signups like cold email). Two markers, read the same way:
 *   - `dy_unit=<outcomeKey>:<subjectService>:<subjectId>` (generic: the Unit names its own outcome; transactional-email
 *     stamps `newsletter_email_sent:transactional-email-service:<recipient id>`). THE contract for any new producer.
 *   - `dy_post=<subjectService>:<subjectId>` (legacy, meta-service's posts): the outcome is not on the link, so it is
 *     READ OFF THE LEDGER (runs-service `GET /internal/outcome-occurrences`, the subject's produced occurrence: old
 *     Threads posts `post_published`, newer ones `threads_post_published`), never assumed. Not on the ledger yet = the
 *     claim waits and is asked again next pass; several outcomes on one subject = not credited, loud, asked again.
 * The colons may arrive as `%3A`. Several different values, a malformed marker, or two markers naming different subjects
 * = no touch. No marker = organic (no time-window guess, owner 2026-11-06). GENERIC: never a per-outcome/platform rule.
 *
 * A POST TOUCH (a "unit touch"; the names predate newsletters) = a live bronze `crm_facts` `website_visit` (crm-service's
 * mirror of the brand's PostHog sessions; `payload.firstUrl` = the session's ENTRY URL with its query string) whose entry
 * URL carries a valid marker (`parsePostTouch`, pure), resolved to the brand's lead by one of the visit's emails exactly as brand-signups.ts
 * resolves a signup (case-folded address on `lead_contact_methods` of a lead of that org + brand). Several leads =
 * ambiguous: skipped, the why kept in `post_touch_skips`, asked again every pass (an identity repair settles it).
 * No lead yet = nothing (a signup files them later; the next pass resolves the same visit).
 *
 * THE DECLARATION mirrors instantly-service's measured click: ONCE per (org, brand, lead, Unit subject) ever
 * (`post_touch_declarations`, the claim, migration 0132; `unit_outcome_key` = the Unit's outcome, 0140), on a spend-free
 * run of its own (`post-touch-visit`, closed `completed` at once, no cost, no child), produced `website_visit` (subject
 * the lead), consumed the Unit (its outcome + subject, verbatim), `occurredAt` = the earliest visit of that lead from that post (runs-service
 * takes a past instant only on a spend-free run declared by its own service). One run = one produced key.
 * runs-service then ties the visit, and every later state consuming it (a signup: outcome-fact-declarations.ts), to the
 * publishing run.
 *
 * Our first touch (first-touch.ts) and a signup's evidence read the DECLARED touches (`delivered` or `queued`, never a
 * `refused` one, never a claim not taken yet): a state is ours, and consumes the visit, only once the visit is on the
 * ledger. A runs-service refusal stays loud (logged, `refused` + its error on the row, the outbox row kept), never
 * fabricated nor retried; a transient failure leaves the claim `claimed` and the next pass asks again (same run).
 *
 * Background sweep: first pass ~60 s after boot, every 5 min, in-function mutex. Reads only the visits carrying a
 * marker through a partial index built after boot (read-model-search-index.ts `idx_crm_facts_unit_visits`); the
 * unscoped pass waits for that index rather than walk the ~420 MB table.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { errorMessage } from "./db-error.js";
import { createRun, producedOutcomeKeysOf, updateRun } from "./runs-client.js";
import { declarationKey, declareRunOutcomesNow, OUTCOME_SUBJECT_SERVICE, type RunOutcomeDeclaration } from "./run-outcomes.js";

/** Legacy marker: `dy_post=<subjectService>:<subjectId>` (the outcome is read off the ledger). */
export const POST_TOUCH_PARAM = "dy_post";
/** Generic marker: `dy_unit=<outcomeKey>:<subjectService>:<subjectId>`. */
export const UNIT_TOUCH_PARAM = "dy_unit";
export const POST_TOUCH_TASK = "post-touch-visit";
export const POST_TOUCH_INDEX = "idx_crm_facts_unit_visits";
export const POST_TOUCH_SWEEP_INTERVAL_MS = 5 * 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;
const SERVICE_NAME = "lead-service";
/** A declared touch: on the ledger now, or waiting in the outbox. */
export const DECLARED_POST_TOUCH_STATUSES = ["delivered", "queued"] as const;

const SUBJECT_SERVICE_RE = /^[a-z][a-z0-9-]*$/;
/** runs-service's own outcome key shape (schemas.ts OUTCOME_KEY_RE). */
const OUTCOME_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_SUBJECT_SERVICE = 64;
const MAX_SUBJECT_ID = 256;

/** The Unit a link names: its subject, and its outcome when the link states it (`dy_unit`); null = read off the ledger. */
export interface PostSubject {
  subjectService: string;
  subjectId: string;
  outcomeKey: string | null;
}

/** `<subjectService>:<subjectId>`, or null. PURE. */
function parseSubject(value: string): { subjectService: string; subjectId: string } | null {
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const subjectService = value.slice(0, colon);
  const subjectId = value.slice(colon + 1);
  if (subjectService.length > MAX_SUBJECT_SERVICE || !SUBJECT_SERVICE_RE.test(subjectService)) return null;
  if (subjectId.length === 0 || subjectId.length > MAX_SUBJECT_ID || subjectId.trim() !== subjectId) return null;
  return { subjectService, subjectId };
}

/** One marker's values: absent, ONE valid value, or invalid (malformed / several different values). PURE. */
function readMarker<T>(params: URLSearchParams, name: string, parse: (v: string) => T | null): { present: false } | { present: true; value: T | null } {
  const values = [...new Set(params.getAll(name))];
  if (values.length === 0) return { present: false };
  if (values.length > 1) return { present: true, value: null };
  return { present: true, value: parse(values[0]) };
}

/**
 * The Unit a visit's entry URL names, or null (no marker, malformed, several different values, two markers naming
 * different subjects). PURE. `dy_unit=<outcomeKey>:<subjectService>:<subjectId>` (outcomeKey `^[a-z][a-z0-9_]{1,63}$`)
 * or legacy `dy_post=<subjectService>:<subjectId>` (outcomeKey null); colons possibly URL-encoded; subjectService
 * `^[a-z][a-z0-9-]*$`, subjectId non-empty, at most 256 characters (everything after the subject service's colon,
 * verbatim), no surrounding whitespace.
 */
export function parsePostTouch(url: string | null | undefined): PostSubject | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const unit = readMarker(params, UNIT_TOUCH_PARAM, (v) => {
    const colon = v.indexOf(":");
    if (colon <= 0) return null;
    const outcomeKey = v.slice(0, colon);
    if (!OUTCOME_KEY_RE.test(outcomeKey)) return null;
    const subject = parseSubject(v.slice(colon + 1));
    return subject ? { ...subject, outcomeKey } : null;
  });
  const post = readMarker(params, POST_TOUCH_PARAM, parseSubject);
  if (unit.present && unit.value === null) return null;
  if (post.present && post.value === null) return null;
  if (unit.present && unit.value) {
    if (post.present && post.value && (post.value.subjectService !== unit.value.subjectService || post.value.subjectId !== unit.value.subjectId)) {
      return null;
    }
    return unit.value;
  }
  if (post.present && post.value) return { ...post.value, outcomeKey: null };
  return null;
}

export type UnitOutcomeResolution = { kind: "resolved"; outcomeKey: string } | { kind: "not_on_ledger" } | { kind: "ambiguous"; outcomeKeys: string[] };

/** The Unit's outcome from the outcomes its subject PRODUCED on the ledger. PURE. */
export function unitOutcomeFrom(producedKeys: readonly string[]): UnitOutcomeResolution {
  const keys = [...new Set(producedKeys)].sort();
  if (keys.length === 0) return { kind: "not_on_ledger" };
  if (keys.length > 1) return { kind: "ambiguous", outcomeKeys: keys };
  return { kind: "resolved", outcomeKey: keys[0] };
}

/** The declaration of one post touch. PURE. */
export function postTouchDeclaration(input: {
  orgId: string;
  runId: string;
  leadId: string;
  /** The Unit consumed: its subject and its RESOLVED outcome. */
  unit: { outcomeKey: string; subjectService: string; subjectId: string };
  occurredAt: string | null;
}): RunOutcomeDeclaration {
  return {
    orgId: input.orgId,
    runId: input.runId,
    // LEAD-GENERIC-1106: the visit was seen by the brand's website tracker (the Unit's own run states the Unit).
    produced: [{ outcomeKey: "website_visit", subjectService: OUTCOME_SUBJECT_SERVICE, subjectId: input.leadId, performer: { kind: "tracker" } }],
    consumed: [{ outcomeKey: input.unit.outcomeKey, subjectService: input.unit.subjectService, subjectId: input.unit.subjectId }],
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

export interface PostVisitRow {
  factId: string;
  orgId: string;
  brandId: string;
  firstUrl: string | null;
  /** ISO instant of the session start, capped at now (runs-service refuses a future instant); null = undated. */
  occurredAt: string | null;
  /** Distinct leads of (org, brand) holding one of the visit's emails, case-folded. */
  leadIds: string[];
}

export interface PostTouch {
  orgId: string;
  brandId: string;
  leadId: string;
  post: PostSubject;
  visitFactId: string;
  occurredAt: string | null;
}

export type PostVisitVerdict =
  | { kind: "touch"; touch: PostTouch }
  | { kind: "not_a_post_touch" }
  | { kind: "no_lead" }
  | { kind: "ambiguous_lead"; leadIds: string[] };

/** What one visit is. PURE. */
export function postVisitVerdict(row: PostVisitRow): PostVisitVerdict {
  const post = parsePostTouch(row.firstUrl);
  if (!post) return { kind: "not_a_post_touch" };
  const leads = [...new Set(row.leadIds)].sort();
  if (leads.length === 0) return { kind: "no_lead" };
  if (leads.length > 1) return { kind: "ambiguous_lead", leadIds: leads };
  return {
    kind: "touch",
    touch: { orgId: row.orgId, brandId: row.brandId, leadId: leads[0], post, visitFactId: row.factId, occurredAt: row.occurredAt },
  };
}

const touchKey = (t: Pick<PostTouch, "orgId" | "brandId" | "leadId" | "post">) =>
  `${t.orgId}|${t.brandId}|${t.leadId}|${t.post.subjectService}|${t.post.subjectId}`;

/** The earliest visit per (org, brand, lead, Unit subject); an undated visit only when none is dated. PURE. */
export function earliestTouches(touches: readonly PostTouch[]): PostTouch[] {
  const out = new Map<string, PostTouch>();
  for (const t of touches) {
    const key = touchKey(t);
    const cur = out.get(key);
    if (!cur) {
      out.set(key, t);
      continue;
    }
    // A link that STATES the Unit's outcome (dy_unit) settles it for every visit of the same Unit.
    const outcomeKey = cur.post.outcomeKey ?? t.post.outcomeKey;
    const earlier = t.occurredAt !== null && (cur.occurredAt === null || Date.parse(t.occurredAt) < Date.parse(cur.occurredAt));
    const kept = earlier ? t : cur;
    out.set(key, kept.post.outcomeKey === outcomeKey ? kept : { ...kept, post: { ...kept.post, outcomeKey } });
  }
  return [...out.values()];
}

/**
 * Every live website visit whose entry URL carries the param, with the leads of its brand holding one of its emails.
 * The predicate is the partial index's, verbatim, so the read never walks the table.
 */
export async function loadPostVisits(scope?: { orgId: string }): Promise<PostVisitRow[]> {
  const rows = (await db.execute(sql`
    WITH visits AS (
      SELECT f.fact_id, f.org_id, f.brand_id, f.emails, f.payload->>'firstUrl' AS first_url,
             to_char(LEAST(f.occurred_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
      FROM crm_facts f
      WHERE f.type = 'website_visit' AND (f.payload->>'firstUrl' LIKE '%dy_post=%' OR f.payload->>'firstUrl' LIKE '%dy_unit=%')
        ${scope ? sql`AND f.org_id = ${scope.orgId}` : sql.empty()}
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
    ),
    addresses AS (
      SELECT DISTINCT v.fact_id, lower(trim(e)) AS email FROM visits v, unnest(v.emails) AS e WHERE trim(e) <> ''
    ),
    owners AS (
      SELECT a.fact_id, array_agg(DISTINCT cm.lead_id::text) AS lead_ids
      FROM addresses a
      JOIN visits v ON v.fact_id = a.fact_id
      JOIN lead_contact_methods cm ON cm.channel = 'email' AND lower(cm.value) = a.email
      WHERE EXISTS (SELECT 1 FROM leads_campaigns lc WHERE lc.lead_id = cm.lead_id AND lc.org_id = v.org_id AND v.brand_id = ANY(lc.brand_ids))
      GROUP BY a.fact_id
    )
    SELECT v.fact_id, v.org_id, v.brand_id, v.first_url, v.occurred_at, COALESCE(o.lead_ids, '{}') AS lead_ids
    FROM visits v LEFT JOIN owners o ON o.fact_id = v.fact_id
    ORDER BY v.occurred_at ASC NULLS LAST, v.fact_id
  `)) as unknown as Array<{ fact_id: string; org_id: string; brand_id: string; first_url: string | null; occurred_at: string | null; lead_ids: string[] }>;
  return rows.map((r) => ({
    factId: r.fact_id,
    orgId: r.org_id,
    brandId: r.brand_id,
    firstUrl: r.first_url,
    occurredAt: r.occurred_at,
    leadIds: r.lead_ids ?? [],
  }));
}

interface ClaimRow {
  run_id: string | null;
  status: string;
  unit_outcome_key: string | null;
  error: string | null;
}

async function readClaim(t: PostTouch): Promise<ClaimRow | null> {
  const rows = (await db.execute(sql`
    SELECT run_id::text AS run_id, status, unit_outcome_key, error FROM post_touch_declarations
    WHERE org_id = ${t.orgId} AND brand_id = ${t.brandId} AND lead_id = ${t.leadId}::uuid
      AND post_subject_service = ${t.post.subjectService} AND post_subject_id = ${t.post.subjectId}
  `)) as unknown as ClaimRow[];
  return rows[0] ?? null;
}

const claimWhere = (t: PostTouch) => sql`
  org_id = ${t.orgId} AND brand_id = ${t.brandId} AND lead_id = ${t.leadId}::uuid
  AND post_subject_service = ${t.post.subjectService} AND post_subject_id = ${t.post.subjectId}`;

export interface PostTouchSweepSummary {
  visits: number;
  touches: number;
  delivered: number;
  queued: number;
  refused: number;
  failed: number;
  ambiguous: number;
  noLead: number;
  /** Legacy-marker touches whose Unit outcome the ledger did not settle this pass (not on it yet / several). */
  unresolved: number;
}

/** Per pass: the produced outcome keys of each legacy subject, asked of runs-service once. */
type LedgerMemo = Map<string, Promise<string[]>>;

async function recordSkip(row: PostVisitRow, leadIds: string[]): Promise<void> {
  const inserted = (await db.execute(sql`
    INSERT INTO post_touch_skips (visit_fact_id, org_id, brand_id, reason, lead_ids)
    VALUES (${row.factId}, ${row.orgId}, ${row.brandId}, 'ambiguous_lead', ${sql.param(leadIds)}::text[])
    ON CONFLICT (visit_fact_id) DO UPDATE SET reason = EXCLUDED.reason, lead_ids = EXCLUDED.lead_ids, last_seen_at = now()
    RETURNING (xmax = 0) AS fresh
  `)) as unknown as Array<{ fresh: boolean }>;
  if (inserted[0]?.fresh) {
    console.warn(
      `[lead-service] post touch NOT credited: visit ${row.factId} (org ${row.orgId}, brand ${row.brandId}) names emails ` +
        `held by several leads (${leadIds.join(", ")}); asked again every pass until the identity is repaired`,
    );
  }
}

/** Declare ONE post touch (claim, run, declaration). Never throws: a failure is counted and asked again next pass. */
async function declareTouch(t: PostTouch, summary: PostTouchSweepSummary, memo: LedgerMemo): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO post_touch_declarations (org_id, brand_id, lead_id, post_subject_service, post_subject_id, visit_fact_id, visited_at, unit_outcome_key)
      VALUES (${t.orgId}, ${t.brandId}, ${t.leadId}::uuid, ${t.post.subjectService}, ${t.post.subjectId}, ${t.visitFactId}, ${t.occurredAt}::timestamptz, ${t.post.outcomeKey})
      ON CONFLICT DO NOTHING
    `);
    const claim = await readClaim(t);
    if (!claim || claim.status !== "claimed") return;
    // The Unit's outcome: stored on the claim once known (the link's own, else the ledger's), never assumed.
    let outcomeKey = claim.unit_outcome_key ?? t.post.outcomeKey;
    if (!outcomeKey) {
      const subjectKey = `${t.post.subjectService}|${t.post.subjectId}`;
      let keys = memo.get(subjectKey);
      if (!keys) {
        keys = producedOutcomeKeysOf(t.post.subjectService, t.post.subjectId);
        memo.set(subjectKey, keys);
      }
      const resolution = unitOutcomeFrom(await keys);
      if (resolution.kind !== "resolved") {
        summary.unresolved++;
        const error =
          resolution.kind === "not_on_ledger"
            ? "unit not on the ledger yet: no produced occurrence for this subject"
            : `several outcomes produced on this subject (${resolution.outcomeKeys.join(", ")}): which Unit the link names is unknown`;
        if (claim.error !== error) {
          console.warn(
            `[lead-service] unit touch WAITING (asked again next pass): org=${t.orgId} brand=${t.brandId} lead=${t.leadId} ` +
              `unit=${t.post.subjectService}:${t.post.subjectId}: ${error}`,
          );
          await db.execute(sql`UPDATE post_touch_declarations SET error = ${error}, updated_at = now() WHERE ${claimWhere(t)} AND status = 'claimed'`);
        }
        return;
      }
      outcomeKey = resolution.outcomeKey;
    }
    if (claim.unit_outcome_key !== outcomeKey) {
      await db.execute(sql`
        UPDATE post_touch_declarations SET unit_outcome_key = ${outcomeKey}, error = NULL, updated_at = now()
        WHERE ${claimWhere(t)} AND status = 'claimed' AND unit_outcome_key IS NULL
      `);
    }
    // A claim not taken yet keeps its earliest visit (a visit seen later can be earlier: the copy fills out of order).
    await db.execute(sql`
      UPDATE post_touch_declarations
      SET visit_fact_id = ${t.visitFactId}, visited_at = ${t.occurredAt}::timestamptz, updated_at = now()
      WHERE ${claimWhere(t)} AND status = 'claimed' AND run_id IS NULL
        AND ${t.occurredAt}::timestamptz IS NOT NULL AND (visited_at IS NULL OR visited_at > ${t.occurredAt}::timestamptz)
    `);
    let runId = claim.run_id;
    if (!runId) {
      const run = await createRun({ orgId: t.orgId, brandId: t.brandId, serviceName: SERVICE_NAME, taskName: POST_TOUCH_TASK });
      await updateRun(run.id, "completed", { orgId: t.orgId, brandId: t.brandId });
      runId = run.id;
      await db.execute(sql`UPDATE post_touch_declarations SET run_id = ${runId}::uuid, updated_at = now() WHERE ${claimWhere(t)}`);
    }
    const stored = (await db.execute(sql`
      SELECT to_char(visited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM post_touch_declarations WHERE ${claimWhere(t)}
    `)) as unknown as Array<{ at: string | null }>;
    const declaration = postTouchDeclaration({
      orgId: t.orgId,
      runId,
      leadId: t.leadId,
      unit: { outcomeKey, subjectService: t.post.subjectService, subjectId: t.post.subjectId },
      occurredAt: stored[0]?.at ?? t.occurredAt,
    });
    const kind = await declareRunOutcomesNow(declaration);
    if (kind === "lost") {
      summary.failed++;
      await db.execute(sql`UPDATE post_touch_declarations SET error = 'outbox write failed', updated_at = now() WHERE ${claimWhere(t)}`);
      return;
    }
    const status = kind === "delivered" ? "delivered" : kind === "retry" ? "queued" : "refused";
    const error =
      status === "refused"
        ? ((await db.execute(sql`
            SELECT last_error FROM run_outcome_outbox WHERE idempotency_key = ${declarationKey(declaration)}
          `)) as unknown as Array<{ last_error: string | null }>)[0]?.last_error ?? "refused by runs-service"
        : null;
    await db.execute(sql`UPDATE post_touch_declarations SET status = ${status}, error = ${error}, updated_at = now() WHERE ${claimWhere(t)}`);
    if (status === "delivered") summary.delivered++;
    else if (status === "queued") summary.queued++;
    else {
      summary.refused++;
      console.error(
        `[lead-service] post touch REFUSED by runs-service (kept, not re-sent): org=${t.orgId} brand=${t.brandId} lead=${t.leadId} ` +
          `unit=${outcomeKey}:${t.post.subjectService}:${t.post.subjectId} run=${runId}: ${error}`,
      );
    }
  } catch (err) {
    summary.failed++;
    console.error(
      `[lead-service] post touch NOT declared (asked again next pass): org=${t.orgId} brand=${t.brandId} lead=${t.leadId} ` +
        `post=${t.post.subjectService}:${t.post.subjectId}: ${errorMessage(err)}`,
    );
    await db
      .execute(sql`UPDATE post_touch_declarations SET error = ${errorMessage(err).slice(0, 500)}, updated_at = now() WHERE ${claimWhere(t)} AND status = 'claimed'`)
      .catch(() => undefined);
  }
}

/** Whether the partial index the unscoped read rides is built and valid. */
async function postVisitIndexReady(): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = ${POST_TOUCH_INDEX}
  `)) as unknown as Array<{ valid: boolean }>;
  return rows[0]?.valid === true;
}

let inFlight: Promise<PostTouchSweepSummary> | null = null;

/** One pass. Concurrent calls join it. `scope` is a test / staff hook (and skips the index wait). */
export function sweepPostTouches(scope?: { orgId: string }): Promise<PostTouchSweepSummary> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const summary: PostTouchSweepSummary = { visits: 0, touches: 0, delivered: 0, queued: 0, refused: 0, failed: 0, ambiguous: 0, noLead: 0, unresolved: 0 };
    const memo: LedgerMemo = new Map();
    if (!scope && !(await postVisitIndexReady())) return summary;
    const visits = await loadPostVisits(scope);
    summary.visits = visits.length;
    const touches: PostTouch[] = [];
    for (const v of visits) {
      const verdict = postVisitVerdict(v);
      if (verdict.kind === "touch") touches.push(verdict.touch);
      else if (verdict.kind === "no_lead") summary.noLead++;
      else if (verdict.kind === "ambiguous_lead") {
        summary.ambiguous++;
        await recordSkip(v, verdict.leadIds);
      }
    }
    const pending = earliestTouches(touches);
    summary.touches = pending.length;
    for (const t of pending) {
      const claim = await readClaim(t);
      if (claim && claim.status !== "claimed") continue;
      await declareTouch(t, summary, memo);
    }
    if (summary.delivered + summary.queued + summary.refused + summary.failed > 0) {
      console.log(`[lead-service] post touch declarations pass ${JSON.stringify(summary)}`);
    }
    return summary;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Background thread: first pass ~60 s after boot, then every 5 min. */
export function startPostTouchWorker(): void {
  const tick = () => {
    sweepPostTouches().catch((err) => console.error("[lead-service] post touch declarations pass failed:", err));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, POST_TOUCH_SWEEP_INTERVAL_MS).unref();
}

/** Our first DECLARED post touch of each lead at (org, brand); a lead with none is absent. */
export async function firstPostTouches(orgId: string, brandId: string, leadIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT lead_id::text AS lead_id,
           to_char(min(visited_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_at
    FROM post_touch_declarations
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ANY(${sql.param([...leadIds])}::uuid[])
      AND status IN ('delivered', 'queued') AND visited_at IS NOT NULL
    GROUP BY lead_id
  `)) as unknown as Array<{ lead_id: string; first_at: string | null }>;
  for (const r of rows) if (r.first_at) out.set(r.lead_id, r.first_at);
  return out;
}
