/**
 * A VISIT THAT CAME FROM ONE OF OUR POSTS IS CREDITED TO THAT POST'S RUN (FACTORY-P2-CONTENT-OUTCOMES, owner 2026-10-28).
 *
 * distribute.you publishes posts on its own accounts (meta-service records each main post as a `post_published`
 * occurrence on runs-service: subject `meta-service` / the publication id, on the publishing run). Each post's link
 * carries `dy_post=<subjectService>:<subjectId>`, the subject of that occurrence (the colon may arrive as `%3A`). So
 * features-service can rank content pipes by cost per signup like cold email, a visit through that link and every
 * later state of the same person must be tied to the publishing run on the ledger. GENERIC: any brand, any platform,
 * any publishing service; never a per-platform rule.
 *
 * A POST TOUCH = a live bronze `crm_facts` `website_visit` (crm-service's mirror of the brand's PostHog sessions;
 * `payload.firstUrl` = the session's ENTRY URL with its query string) whose entry URL carries a valid `dy_post`
 * (`parsePostTouch`, pure), resolved to the brand's lead by one of the visit's emails exactly as brand-signups.ts
 * resolves a signup (case-folded address on `lead_contact_methods` of a lead of that org + brand). Several leads =
 * ambiguous: skipped, the why kept in `post_touch_skips`, asked again every pass (an identity repair settles it).
 * No lead yet = nothing (a signup files them later; the next pass resolves the same visit).
 *
 * THE DECLARATION mirrors instantly-service's measured click: ONCE per (org, brand, lead, post) ever
 * (`post_touch_declarations`, the claim, migration 0132), on a spend-free run of its own (`post-touch-visit`, closed
 * `completed` at once, no cost, no child), produced `website_visit` (subject the lead), consumed `post_published`
 * (subject read off the param, verbatim), `occurredAt` = the earliest visit of that lead from that post (runs-service
 * takes a past instant only on a spend-free run declared by its own service). One run = one produced key.
 * runs-service then ties the visit, and every later state consuming it (a signup: outcome-fact-declarations.ts), to the
 * publishing run.
 *
 * Our first touch (first-touch.ts) and a signup's evidence read the DECLARED touches (`delivered` or `queued`, never a
 * `refused` one, never a claim not taken yet): a state is ours, and consumes the visit, only once the visit is on the
 * ledger. A runs-service refusal stays loud (logged, `refused` + its error on the row, the outbox row kept), never
 * fabricated nor retried; a transient failure leaves the claim `claimed` and the next pass asks again (same run).
 *
 * Background sweep: first pass ~60 s after boot, every 5 min, in-function mutex. Reads only the visits carrying the
 * param through a partial index built after boot (read-model-search-index.ts `idx_crm_facts_post_visits`); the
 * unscoped pass waits for that index rather than walk the ~420 MB table.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { errorMessage } from "./db-error.js";
import { createRun, updateRun } from "./runs-client.js";
import { declarationKey, declareRunOutcomesNow, OUTCOME_SUBJECT_SERVICE, type RunOutcomeDeclaration } from "./run-outcomes.js";

export const POST_TOUCH_PARAM = "dy_post";
export const POST_TOUCH_TASK = "post-touch-visit";
export const POST_PUBLISHED_OUTCOME = "post_published";
export const POST_TOUCH_INDEX = "idx_crm_facts_post_visits";
export const POST_TOUCH_SWEEP_INTERVAL_MS = 5 * 60_000;
const FIRST_SWEEP_DELAY_MS = 60_000;
const SERVICE_NAME = "lead-service";
/** A declared touch: on the ledger now, or waiting in the outbox. */
export const DECLARED_POST_TOUCH_STATUSES = ["delivered", "queued"] as const;

const SUBJECT_SERVICE_RE = /^[a-z][a-z0-9-]*$/;
const MAX_SUBJECT_SERVICE = 64;
const MAX_SUBJECT_ID = 256;

export interface PostSubject {
  subjectService: string;
  subjectId: string;
}

/**
 * The post a visit's entry URL names, or null (no param, malformed, several different values). PURE.
 * `dy_post=<subjectService>:<subjectId>`, the colon possibly URL-encoded; subjectService `^[a-z][a-z0-9-]*$`,
 * subjectId non-empty, at most 256 characters, no surrounding whitespace.
 */
export function parsePostTouch(url: string | null | undefined): PostSubject | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  const values = [...new Set(params.getAll(POST_TOUCH_PARAM))];
  if (values.length !== 1) return null;
  const value = values[0];
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const subjectService = value.slice(0, colon);
  const subjectId = value.slice(colon + 1);
  if (subjectService.length > MAX_SUBJECT_SERVICE || !SUBJECT_SERVICE_RE.test(subjectService)) return null;
  if (subjectId.length === 0 || subjectId.length > MAX_SUBJECT_ID || subjectId.trim() !== subjectId) return null;
  return { subjectService, subjectId };
}

/** The declaration of one post touch. PURE. */
export function postTouchDeclaration(input: {
  orgId: string;
  runId: string;
  leadId: string;
  post: PostSubject;
  occurredAt: string | null;
}): RunOutcomeDeclaration {
  return {
    orgId: input.orgId,
    runId: input.runId,
    produced: [{ outcomeKey: "website_visit", subjectService: OUTCOME_SUBJECT_SERVICE, subjectId: input.leadId }],
    consumed: [{ outcomeKey: POST_PUBLISHED_OUTCOME, subjectService: input.post.subjectService, subjectId: input.post.subjectId }],
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

/** The earliest visit per (org, brand, lead, post); an undated visit only when none is dated. PURE. */
export function earliestTouches(touches: readonly PostTouch[]): PostTouch[] {
  const out = new Map<string, PostTouch>();
  for (const t of touches) {
    const key = touchKey(t);
    const cur = out.get(key);
    if (!cur) {
      out.set(key, t);
      continue;
    }
    if (t.occurredAt === null) continue;
    if (cur.occurredAt === null || Date.parse(t.occurredAt) < Date.parse(cur.occurredAt)) out.set(key, t);
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
      WHERE f.type = 'website_visit' AND f.payload->>'firstUrl' LIKE '%dy_post=%'
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
}

async function readClaim(t: PostTouch): Promise<ClaimRow | null> {
  const rows = (await db.execute(sql`
    SELECT run_id::text AS run_id, status FROM post_touch_declarations
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
}

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
async function declareTouch(t: PostTouch, summary: PostTouchSweepSummary): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO post_touch_declarations (org_id, brand_id, lead_id, post_subject_service, post_subject_id, visit_fact_id, visited_at)
      VALUES (${t.orgId}, ${t.brandId}, ${t.leadId}::uuid, ${t.post.subjectService}, ${t.post.subjectId}, ${t.visitFactId}, ${t.occurredAt}::timestamptz)
      ON CONFLICT DO NOTHING
    `);
    const claim = await readClaim(t);
    if (!claim || claim.status !== "claimed") return;
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
    const declaration = postTouchDeclaration({ orgId: t.orgId, runId, leadId: t.leadId, post: t.post, occurredAt: stored[0]?.at ?? t.occurredAt });
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
          `post=${t.post.subjectService}:${t.post.subjectId} run=${runId}: ${error}`,
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
    const summary: PostTouchSweepSummary = { visits: 0, touches: 0, delivered: 0, queued: 0, refused: 0, failed: 0, ambiguous: 0, noLead: 0 };
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
      await declareTouch(t, summary);
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
