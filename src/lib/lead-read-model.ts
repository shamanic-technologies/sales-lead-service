/**
 * The READ MODEL of a scoped lead population: every person in scope with their engagement
 * buckets, their standing, the instant that dates them and the text they are searched by — KEPT,
 * so a count is a GROUP BY and a page is an ORDER BY ... LIMIT, not a walk of the population.
 *
 * Why it exists. The customer's Leads page makes five reads at once (tab counts, one tab's page,
 * the board's standing counts, one column's page, a search) and re-polls them every 15s per open
 * tab. Each one used to rebuild its answer from scratch over the WHOLE scope: re-dedup the brand
 * chunk by chunk, ask email-gateway about every address in it, read the outcome ledger and the
 * statements, resolve a standing per person. Measured in production on the worst brand (17,910
 * people) that was 7-9s per read on its own and 27-30s under the page's own concurrency, and a lead
 * somebody marked Won took ~30s to show. Nothing was kept between requests.
 *
 * What is kept, and how fresh it is — the three bounds this module states AND enforces:
 *
 *  1. A PERSON's statement (a funnel step, close won and its withdrawal, a "never", a CRM-evidenced
 *     step) shows on the VERY NEXT read. Every statement store carries a trigger that writes the
 *     lead it touched into `lead_read_changes` in the writer's own transaction, and every read
 *     applies what is new (`catchUp`) before it answers. "New" is exact under concurrent commits:
 *     the model remembers the oldest transaction that could still have been open when it last
 *     looked (`applied_xmin`) and re-reads everything from there, so a slow commit is re-applied,
 *     never skipped. Re-applying is harmless: a person is recomputed from the current rows.
 *  2. DELIVERY evidence another service pushes as changed (`POST /orgs/leads/evidence-changed` —
 *     an opt-out, a reply somebody classified, a click the provider observed) is asked again and
 *     shows on the next read, the same way.
 *  3. Everything else — delivery evidence nobody pushed, new serves, a campaign's funnel, a name —
 *     is at most `READ_MODEL_MAX_EVIDENCE_AGE_MS` old, ENFORCED: a model older than that is rebuilt
 *     before it is read, never served. The worker (lead-read-model-worker.ts) rebuilds every model
 *     somebody reads once it is `READ_MODEL_REFRESH_AFTER_MS` old, so a read normally never waits.
 *
 * What does NOT change. Buckets, standing and activity are computed by the SAME functions the list
 * row uses (enrichLeadIndex, the standing resolver) over the SAME relation (streamLeadIndex over
 * leadCampaignBaseRelation), so a model row and a list row cannot mean different things. A count
 * and the page it labels are read from the same model rows, in one snapshot, so a tab's count IS
 * the set the tab pages through, and standing counts sum to `total` because a row has exactly one.
 *
 * FAIL LOUD. A model that cannot be built (email-gateway unreachable, statements unreadable) is an
 * error the route answers 502 with — never an empty model, never a model past its bound.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { sql } from "../db/index.js";
import {
  DEFAULT_STATUS,
  flattenBrandStatus,
  flattenCampaignStatus,
  flattenFamilyStatus,
  type FlattenedStatus,
} from "./delivery-flatten.js";
import type { StatusResult } from "./email-gateway-client.js";
import { zeroBucketCounts, type LeadBucket, LEAD_BUCKETS } from "./lead-buckets.js";
import {
  EvidenceUnavailableError,
  readDeliveryEvidence,
  type EvidenceRequest,
} from "./lead-delivery-evidence.js";
import { enrichLeadIndex, type EngagementContext } from "./lead-engagement.js";
import { streamLeadIndex, type LeadIndexRow } from "./lead-index.js";
import {
  DEFAULT_LEAD_LIST_STATUSES,
  encodeLeadCursor,
  type LeadListPage,
  type LeadListScope,
} from "./lead-list-query.js";
import type { LeadSortOrder } from "./lead-page-plan.js";
import { leadSearchPattern } from "./lead-search.js";
import { attachLeadStandings } from "./lead-standing-index.js";
import { createLeadStandingResolver } from "./lead-standing-resolver.js";
import {
  LEAD_STANDING_STATES,
  zeroStandingCounts,
  type LeadStandingState,
} from "./lead-standing.js";

/**
 * The ENFORCED bound on how old anything a model was built from may be. A model older than this
 * is rebuilt before it is read — never served. Five minutes: long enough that the worker's
 * two-minute refresh, plus a rebuild of the largest brand, lands well inside it, so a read waits
 * only when nobody has read that scope for a while.
 */
export const READ_MODEL_MAX_EVIDENCE_AGE_MS = 5 * 60_000;
/** The worker rebuilds a model somebody reads once it is this old. */
export const READ_MODEL_REFRESH_AFTER_MS = 2 * 60_000;
/**
 * A build reuses delivery evidence asked at most this long before it started — which is what lets
 * the brand model and a campaign model of the same brand share one round of questions.
 */
const EVIDENCE_REUSE_MS = 30_000;
/** How many people one build step holds. Bounds the process's heap whatever the scope's size. */
const BUILD_CHUNK_SIZE = 1_000;
/** How many people one incremental recompute step holds. */
const RECOMPUTE_CHUNK_SIZE = 500;
/** Builds running at once, fleet of scopes included — each one fans out to email-gateway. */
const MAX_CONCURRENT_BUILDS = 2;

/** Everything that decides WHICH rows a model holds and what their evidence means. */
export interface ReadModelScope {
  orgId: string;
  /** The brand the read named: scopes the outcome ledger and the standing resolver. */
  brandId: string | null;
  /** The resolved campaign ids (identity members or an offer's campaigns), sorted; null = none. */
  campaignIds: string[] | null;
  /** Lifecycle statuses, sorted. */
  statuses: string[];
  queryOrgId: string | null;
  userId: string | null;
  workflowSlug: string | null;
  /** Whether the read named a scope at all; unscoped reads carry no delivery evidence. */
  deliveryQueried: boolean;
}

/** A model as stored. */
export interface ReadModel {
  id: string;
  scopeKey: string;
  orgId: string;
  scope: ReadModelScope;
  evidenceAt: Date;
  appliedXmin: string;
}

/** Raised when a model could not be built or brought up to date. The route answers 502. */
export class ReadModelUnavailableError extends Error {
  constructor(
    readonly source: "email-gateway" | "standing",
    message: string,
  ) {
    super(message);
    this.name = "ReadModelUnavailableError";
  }
}

/** The model scope a request's resolved list scope describes. */
export function readModelScopeFor(
  scope: LeadListScope,
  brandId: string | undefined,
  deliveryQueried: boolean,
): ReadModelScope {
  return {
    orgId: scope.orgId,
    brandId: brandId ?? null,
    campaignIds:
      scope.campaignIds && scope.campaignIds.length > 0
        ? [...scope.campaignIds].sort()
        : scope.campaignId
          ? [scope.campaignId]
          : null,
    statuses: [...(scope.statuses ?? DEFAULT_LEAD_LIST_STATUSES)].sort(),
    queryOrgId: scope.queryOrgId ?? null,
    userId: scope.userId ?? null,
    workflowSlug: scope.workflowSlug ?? null,
    deliveryQueried,
  };
}

/** One key per distinct scope. Field order is fixed here, so the key is canonical. */
export function readModelKey(scope: ReadModelScope): string {
  const canonical = JSON.stringify([
    scope.orgId,
    scope.brandId,
    scope.campaignIds,
    scope.statuses,
    scope.queryOrgId,
    scope.userId,
    scope.workflowSlug,
    scope.deliveryQueried,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function listScopeOf(scope: ReadModelScope): LeadListScope {
  return {
    orgId: scope.orgId,
    brandId: scope.brandId ?? undefined,
    campaignIds: scope.campaignIds ?? undefined,
    statuses: scope.statuses,
    queryOrgId: scope.queryOrgId ?? undefined,
    userId: scope.userId ?? undefined,
    workflowSlug: scope.workflowSlug ?? undefined,
  };
}

/** The single campaign a campaign-mode delivery question names, exactly as the list decides it. */
export function statusCampaignIdOf(scope: ReadModelScope): string | undefined {
  return scope.campaignIds?.length === 1 ? scope.campaignIds[0] : undefined;
}

/** The flatten the list applies for this scope — the same three-way choice, off the same ids. */
function flattenOf(scope: ReadModelScope): (result: StatusResult) => FlattenedStatus {
  const ids = scope.campaignIds;
  if (ids && ids.length > 1) {
    const family = new Set(ids);
    return (result) => flattenFamilyStatus(result, family);
  }
  return ids ? flattenCampaignStatus : flattenBrandStatus;
}

function engagementOf(scope: ReadModelScope): EngagementContext {
  return {
    serviceContext: { orgId: scope.orgId },
    statusCampaignId: statusCampaignIdOf(scope),
    flatten: flattenOf(scope),
    deliveryQueried: scope.deliveryQueried,
    orgId: scope.orgId,
    brandId: scope.brandId ?? undefined,
  };
}

/** What a model row holds. */
interface DerivedRow {
  id: string;
  leadId: string;
  email: string | null;
  createdAtText: string;
  activityAt: string;
  buckets: LeadBucket[];
  standing: LeadStandingState;
  searchText: string;
}

/** The delivery questions a set of index rows asks: served rows with an address, under their primary brand. */
function evidenceRequests(rows: readonly LeadIndexRow[]): EvidenceRequest[] {
  const out: EvidenceRequest[] = [];
  for (const row of rows) {
    if (row.status !== "served" || !row.email) continue;
    out.push({ brandId: row.brandIds[0] ?? "unknown", email: row.email });
  }
  return out;
}

/**
 * The delivery evidence for `requests`, from the shared evidence store when it is recent enough.
 * Also what the list uses to overlay a page it hydrated from a model, so the row and the count it
 * was counted in are read from one answer.
 */
export async function readModelDelivery(
  scope: ReadModelScope,
  requests: readonly EvidenceRequest[],
  acceptFetchedSince: Date,
  changedAt?: ReadonlyMap<string, Date>,
): Promise<Map<string, StatusResult>> {
  if (!scope.deliveryQueried || requests.length === 0) return new Map();
  try {
    return await readDeliveryEvidence(requests, {
      orgId: scope.orgId,
      campaignId: statusCampaignIdOf(scope),
      acceptFetchedSince,
      changedAt,
      context: { orgId: scope.orgId },
    });
  } catch (error) {
    if (error instanceof EvidenceUnavailableError) {
      throw new ReadModelUnavailableError("email-gateway", error.message);
    }
    throw error;
  }
}

type Resolver = ReturnType<typeof createLeadStandingResolver>;

function resolverFor(scope: ReadModelScope): Resolver {
  return createLeadStandingResolver({
    orgId: scope.orgId,
    userId: null,
    runId: null,
    brandId: scope.brandId,
    deliveryQueried: scope.deliveryQueried,
  });
}

/** Buckets, standing and activity for a chunk of index rows — the list's own derivation. */
async function deriveRows(
  scope: ReadModelScope,
  rows: readonly LeadIndexRow[],
  resolver: Resolver,
  acceptFetchedSince: Date,
  changedAt?: ReadonlyMap<string, Date>,
): Promise<DerivedRow[]> {
  if (rows.length === 0) return [];
  const delivery = await readModelDelivery(
    scope,
    evidenceRequests(rows),
    acceptFetchedSince,
    changedAt,
  );
  const enriched = await enrichLeadIndex(rows, engagementOf(scope), true, delivery);
  try {
    await attachLeadStandings(enriched, resolver);
  } catch (error) {
    throw new ReadModelUnavailableError("standing", (error as Error).message);
  }
  return enriched.map((row) => ({
    id: row.id,
    leadId: row.leadId,
    email: row.email,
    createdAtText: row.createdAtText,
    activityAt: row.activityAt,
    buckets: LEAD_BUCKETS.filter((b) => row.buckets.has(b)),
    standing: row.standing ?? "unresolved",
    searchText: row.searchText,
  }));
}

/**
 * postgres.js types a transaction handle without its call signature (`TransactionSql` is an Omit of
 * `Sql`), although it IS callable exactly like `sql`. One cast, here, rather than one per statement.
 */
function asSql(tx: postgres.TransactionSql<Record<string, never>>): typeof sql {
  return tx as unknown as typeof sql;
}

/** Write derived rows into a model (upsert: a recompute replaces a person's rows in place). */
async function writeRows(
  db: typeof sql,
  modelId: string,
  rows: readonly DerivedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db`
    INSERT INTO lead_read_model_rows
      (model_id, id, lead_id, email, created_at_text, activity_at, buckets, standing, search_text)
    SELECT ${modelId}::uuid, u.id, u.lead_id, u.email, u.created_at_text, u.activity_at,
           string_to_array(u.buckets, ','), u.standing, u.search_text
    FROM unnest(
      ${rows.map((r) => r.id)}::uuid[],
      ${rows.map((r) => r.leadId)}::uuid[],
      ${rows.map((r) => r.email)}::text[],
      ${rows.map((r) => r.createdAtText)}::text[],
      ${rows.map((r) => r.activityAt)}::timestamptz[],
      ${rows.map((r) => r.buckets.join(","))}::text[],
      ${rows.map((r) => r.standing)}::text[],
      ${rows.map((r) => r.searchText)}::text[]
    ) AS u(id, lead_id, email, created_at_text, activity_at, buckets, standing, search_text)
    ON CONFLICT (model_id, id) DO UPDATE SET
      lead_id = EXCLUDED.lead_id,
      email = EXCLUDED.email,
      created_at_text = EXCLUDED.created_at_text,
      activity_at = EXCLUDED.activity_at,
      buckets = EXCLUDED.buckets,
      standing = EXCLUDED.standing,
      search_text = EXCLUDED.search_text
  `;
}

/** The oldest transaction that could still be open right now — see `catchUp`. */
async function currentXmin(): Promise<string> {
  const rows = await sql<Array<{ xmin: string }>>`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin
  `;
  return rows[0].xmin;
}

interface RawModel {
  id: string;
  scope_key: string;
  org_id: string;
  scope: ReadModelScope;
  evidence_at: Date | string;
  applied_xmin: string;
}

function mapModel(row: RawModel): ReadModel {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    orgId: row.org_id,
    scope: row.scope,
    evidenceAt: new Date(row.evidence_at),
    appliedXmin: row.applied_xmin,
  };
}

async function loadModel(key: string): Promise<ReadModel | null> {
  const rows = await sql<RawModel[]>`
    SELECT id, scope_key, org_id, scope, evidence_at, applied_xmin::text AS applied_xmin
    FROM lead_read_models
    WHERE scope_key = ${key}
  `;
  return rows[0] ? mapModel(rows[0]) : null;
}

let buildsRunning = 0;
const buildWaiters: Array<() => void> = [];

async function withBuildSlot<T>(task: () => Promise<T>): Promise<T> {
  if (buildsRunning >= MAX_CONCURRENT_BUILDS) {
    await new Promise<void>((resolve) => buildWaiters.push(resolve));
  }
  buildsRunning += 1;
  try {
    return await task();
  } finally {
    buildsRunning -= 1;
    buildWaiters.shift()?.();
  }
}

/**
 * Build a scope's model from scratch and swap it in.
 *
 * The new model is written under its own id while the old one keeps answering, then swapped in
 * one transaction. The old one is RETIRED, not deleted: a read that picked it up a moment before
 * the swap still reads a whole model rather than an emptied one; the worker deletes it once no
 * read can still hold it.
 */
async function buildModel(scope: ReadModelScope, key: string): Promise<ReadModel> {
  return withBuildSlot(async () => {
    const startedAt = Date.now();
    // Taken BEFORE any row is read: every change from a transaction that was still open now is
    // re-applied by the next catch-up, so nothing that lands during the build is lost.
    const xmin = await currentXmin();
    const evidenceAt = new Date(startedAt - EVIDENCE_REUSE_MS);
    const created = await sql<Array<{ id: string }>>`
      INSERT INTO lead_read_models (org_id, scope, applied_xmin)
      VALUES (${scope.orgId}, ${JSON.stringify(scope)}::jsonb, ${xmin}::xid8)
      RETURNING id
    `;
    const modelId = created[0].id;
    let people = 0;
    try {
      const resolver = resolverFor(scope);
      for await (const chunk of streamLeadIndex(listScopeOf(scope), BUILD_CHUNK_SIZE)) {
        const derived = await deriveRows(scope, chunk, resolver, evidenceAt);
        await writeRows(sql, modelId, derived);
        people += derived.length;
      }
      await sql.begin(async (rawTx) => {
        const tx = asSql(rawTx);
        await tx`
          UPDATE lead_read_models n
          SET last_read_at = COALESCE(
            (SELECT o.last_read_at FROM lead_read_models o WHERE o.scope_key = ${key}),
            now()
          )
          WHERE n.id = ${modelId}
        `;
        await tx`
          UPDATE lead_read_models SET scope_key = NULL, retired_at = now()
          WHERE scope_key = ${key}
        `;
        await tx`
          UPDATE lead_read_models
          SET scope_key = ${key}, evidence_at = ${evidenceAt.toISOString()}::timestamptz, built_at = now()
          WHERE id = ${modelId}
        `;
      });
    } catch (error) {
      await sql`DELETE FROM lead_read_models WHERE id = ${modelId}`.catch((cleanup) =>
        console.error(`[lead-read-model] could not drop a failed build ${modelId}:`, cleanup),
      );
      throw error;
    }
    console.log(
      `[lead-read-model] built org=${scope.orgId} brand=${scope.brandId ?? "-"} ` +
        `campaigns=${scope.campaignIds?.length ?? 0} people=${people} in ${Date.now() - startedAt}ms`,
    );
    return {
      id: modelId,
      scopeKey: key,
      orgId: scope.orgId,
      scope,
      evidenceAt,
      appliedXmin: xmin,
    };
  });
}

/**
 * Recompute these people in a model from the CURRENT rows, statements and evidence — the same
 * derivation a build runs, over a handful of people instead of a brand.
 */
async function recomputePeople(
  model: ReadModel,
  leadIds: readonly string[],
  changedAt: ReadonlyMap<string, Date>,
): Promise<void> {
  const resolver = resolverFor(model.scope);
  for (let i = 0; i < leadIds.length; i += RECOMPUTE_CHUNK_SIZE) {
    const slice = leadIds.slice(i, i + RECOMPUTE_CHUNK_SIZE);
    const rows: LeadIndexRow[] = [];
    for await (const chunk of streamLeadIndex(
      { ...listScopeOf(model.scope), leadIds: slice },
      RECOMPUTE_CHUNK_SIZE,
    )) {
      rows.push(...chunk);
    }
    const derived = await deriveRows(model.scope, rows, resolver, model.evidenceAt, changedAt);
    await sql.begin(async (rawTx) => {
      const tx = asSql(rawTx);
      // A person who LEFT the scope is removed; one still in it is replaced by what they are now.
      await tx`
        DELETE FROM lead_read_model_rows
        WHERE model_id = ${model.id} AND lead_id = ANY(${[...slice]}::uuid[])
      `;
      await writeRows(tx, model.id, derived);
    });
  }
}

interface RawChange {
  seq: string;
  lead_id: string | null;
  email: string | null;
  kind: string;
  created_at: Date | string;
}

/**
 * Apply every change a model has not seen: the people whose statements moved, and the addresses
 * whose delivery evidence somebody pushed as changed.
 *
 * `applied_xmin` is the oldest transaction that could still have been open when the model last
 * looked. Everything written by a transaction at or after it is read again — a transaction that
 * committed late is therefore applied on the next look rather than skipped, and one applied twice
 * recomputes a person to the same answer. The xmin is taken BEFORE the changes are read, so a
 * change committed in between is covered twice rather than not at all.
 */
async function catchUp(model: ReadModel): Promise<number> {
  const xmin = await currentXmin();
  const seen = appliedChanges.get(model.id) ?? new Set<string>();
  const changes = (
    await sql<RawChange[]>`
      SELECT seq::text AS seq, lead_id::text AS lead_id, email, kind, created_at
      FROM lead_read_changes
      WHERE org_id = ${model.orgId} AND txid >= ${model.appliedXmin}::xid8
    `
  ).filter((change) => !seen.has(change.seq));
  if (changes.length > 0) {
    const leadIds = new Set<string>();
    const changedAt = new Map<string, Date>();
    for (const change of changes) {
      if (change.lead_id) leadIds.add(change.lead_id);
      if (change.kind === "evidence" && change.email) {
        const key = change.email.toLowerCase();
        const at = new Date(change.created_at);
        const prior = changedAt.get(key);
        if (!prior || prior < at) changedAt.set(key, at);
      }
    }
    if (changedAt.size > 0) {
      const affected = await sql<Array<{ lead_id: string }>>`
        SELECT DISTINCT lead_id::text AS lead_id
        FROM lead_read_model_rows
        WHERE model_id = ${model.id} AND lower(email) = ANY(${[...changedAt.keys()]}::text[])
      `;
      for (const row of affected) leadIds.add(row.lead_id);
    }
    if (leadIds.size > 0) await recomputePeople(model, [...leadIds], changedAt);
    // Remembered so the re-read window (see above) does not recompute the same people on every
    // read: `applied_xmin` can only advance as far as the oldest transaction still open anywhere
    // on the server, which another database's long transaction can hold back.
    if (seen.size > MAX_REMEMBERED_CHANGES) seen.clear();
    for (const change of changes) seen.add(change.seq);
    appliedChanges.set(model.id, seen);
  }
  await sql`
    UPDATE lead_read_models SET applied_xmin = ${xmin}::xid8
    WHERE id = ${model.id} AND applied_xmin < ${xmin}::xid8
  `;
  model.appliedXmin = xmin;
  return changes.length;
}

/** Change seqs each model has already applied, within its re-read window. In-process only. */
const appliedChanges = new Map<string, Set<string>>();
const MAX_REMEMBERED_CHANGES = 20_000;

/** Per-scope serialization: a build, a catch-up and a swap of one scope never overlap. */
const keyLocks = new Map<string, Promise<unknown>>();

function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = keyLocks.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  keyLocks.set(key, tail);
  tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return run;
}

function isWithinBound(model: ReadModel, now: number): boolean {
  return model.evidenceAt.getTime() >= now - READ_MODEL_MAX_EVIDENCE_AGE_MS;
}

/**
 * The model a read answers from: built if there is none or it is past its bound, otherwise brought
 * up to date with every change it has not seen. Never returns a model past its bound.
 */
export async function ensureReadModel(scope: ReadModelScope): Promise<ReadModel> {
  const key = readModelKey(scope);
  return withKeyLock(key, async () => {
    let model = await loadModel(key);
    if (!model || !isWithinBound(model, Date.now())) {
      model = await buildModel(scope, key);
    } else {
      await catchUp(model);
    }
    await sql`
      UPDATE lead_read_models SET last_read_at = now()
      WHERE id = ${model.id} AND last_read_at < now() - interval '30 seconds'
    `;
    return model;
  });
}

/**
 * What the worker does to a model: rebuild it once it is `READ_MODEL_REFRESH_AFTER_MS` old,
 * otherwise apply what it has not seen. Under the same per-scope lock a read takes.
 */
export async function refreshReadModel(scope: ReadModelScope): Promise<"built" | "caught-up"> {
  const key = readModelKey(scope);
  return withKeyLock(key, async () => {
    const model = await loadModel(key);
    if (!model || model.evidenceAt.getTime() < Date.now() - READ_MODEL_REFRESH_AFTER_MS) {
      await buildModel(scope, key);
      return "built" as const;
    }
    await catchUp(model);
    return "caught-up" as const;
  });
}

/** The WHERE clause every read of a model shares: the model, the search, the bucket, the standings. */
function modelFilter(
  model: ReadModel,
  tokens: readonly string[] | null,
  bucket: LeadBucket | null,
  standings: readonly LeadStandingState[] | null,
) {
  let predicate = sql`model_id = ${model.id}`;
  for (const token of tokens ?? []) {
    predicate = sql`${predicate} AND search_text ILIKE ${leadSearchPattern(token)}`;
  }
  if (bucket) predicate = sql`${predicate} AND ${bucket} = ANY(buckets)`;
  if (standings) predicate = sql`${predicate} AND standing = ANY(${[...standings]}::text[])`;
  return predicate;
}

/** Every bucket's size, and the size of the (searched) population, in one statement. */
export async function readModelBucketCounts(
  model: ReadModel,
  tokens: readonly string[] | null,
): Promise<{ total: number; counts: Record<LeadBucket, number> }> {
  const rows = await sql<Array<{ bucket: string | null; n: number }>>`
    WITH base AS (
      SELECT buckets FROM lead_read_model_rows WHERE ${modelFilter(model, tokens, null, null)}
    )
    SELECT NULL AS bucket, count(*)::int AS n FROM base
    UNION ALL
    SELECT b AS bucket, count(*)::int AS n FROM base, unnest(buckets) AS b GROUP BY b
  `;
  const counts = zeroBucketCounts();
  let total = 0;
  for (const row of rows) {
    if (row.bucket === null) total = row.n;
    else if (row.bucket in counts) counts[row.bucket as LeadBucket] = row.n;
  }
  return { total, counts };
}

/** Every standing's size. A partition: the counts sum to `total`. */
export async function readModelStandingCounts(
  model: ReadModel,
  tokens: readonly string[] | null,
): Promise<{ total: number; counts: Record<LeadStandingState, number> }> {
  const rows = await sql<Array<{ standing: string; n: number }>>`
    SELECT standing, count(*)::int AS n
    FROM lead_read_model_rows
    WHERE ${modelFilter(model, tokens, null, null)}
    GROUP BY standing
  `;
  const counts = zeroStandingCounts();
  let total = 0;
  for (const row of rows) {
    const state = (LEAD_STANDING_STATES as readonly string[]).includes(row.standing)
      ? (row.standing as LeadStandingState)
      : "unresolved";
    counts[state] += row.n;
    total += row.n;
  }
  return { total, counts };
}

/** The page a caller asked for: how many rows match, where to resume, and the ids themselves. */
export interface LeadPlanPage {
  /** How many rows match the filter in total — the number the page is a window onto. */
  total: number;
  /** Where to resume, or null when this page reached the end (or the read is unbounded). */
  nextCursor: string | null;
  /** The ids to hydrate, in the order they must be emitted, a bounded chunk at a time. */
  ids(chunkSize: number): AsyncGenerator<string[]>;
}

/**
 * How a position is spelled, per order — identical to what the cursor has always carried, so a
 * cursor issued before the model existed resumes correctly after it.
 *
 * `created` is `created_at::text` verbatim (a Date would floor its microseconds); `activity` is the
 * millisecond ISO instant every timestamp folded into it was already normalized to.
 */
function positionColumn(sort: LeadSortOrder) {
  return sort === "created"
    ? sql`created_at_text`
    : sql`to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** Both orders are TOTAL (`id` breaks every tie), so a walk visits every row exactly once. */
function orderBy(sort: LeadSortOrder) {
  return sort === "created" ? sql`created_at_text ASC, id ASC` : sql`activity_at DESC, id DESC`;
}

function after(sort: LeadSortOrder, position: { createdAt: string; id: string } | null) {
  if (!position) return sql``;
  return sort === "created"
    ? sql`AND (created_at_text, id) > (${position.createdAt}, ${position.id}::uuid)`
    : sql`AND (activity_at, id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

/** How many ids one step of an UNBOUNDED walk (an export) reads. */
const WALK_CHUNK_SIZE = 1_000;

/**
 * One page of a model — its size, its ids in order, and where to resume.
 *
 * A BOUNDED page reads its count and its ids in ONE snapshot, so the number that labels the page
 * and the rows under it cannot disagree even if a person is recomputed in between. An unbounded
 * read (an export) walks the model by keyset a chunk at a time; it never holds the population.
 */
export async function readModelPage(
  model: ReadModel,
  query: {
    tokens: readonly string[] | null;
    bucket: LeadBucket | null;
    standings: readonly LeadStandingState[] | null;
    sort: LeadSortOrder;
    page: LeadListPage;
  },
): Promise<LeadPlanPage> {
  const { tokens, bucket, standings, sort, page } = query;
  const filter = modelFilter(model, tokens, bucket, standings);
  const start = page.offset !== null && page.offset > 0 ? page.offset : 0;

  if (page.limit !== null) {
    const limit = page.limit;
    const { total, rows } = await sql.begin("isolation level repeatable read", async (rawTx) => {
      const tx = asSql(rawTx);
      const counted = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM lead_read_model_rows WHERE ${filter}
      `;
      const picked = await tx<Array<{ id: string; pos: string }>>`
        SELECT id::text AS id, ${positionColumn(sort)} AS pos
        FROM lead_read_model_rows
        WHERE ${filter} ${after(sort, page.cursor)}
        ORDER BY ${orderBy(sort)}
        OFFSET ${start}
        LIMIT ${limit + 1}
      `;
      return { total: counted[0]?.n ?? 0, rows: picked };
    });
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeLeadCursor({ createdAt: last.pos, id: last.id }) : null;
    const ids = pageRows.map((r) => r.id);
    return {
      total,
      nextCursor,
      async *ids(chunkSize: number) {
        const size = Math.max(1, chunkSize);
        for (let i = 0; i < ids.length; i += size) yield ids.slice(i, i + size);
      },
    };
  }

  const counted = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM lead_read_model_rows WHERE ${filter}
  `;
  return {
    total: counted[0]?.n ?? 0,
    nextCursor: null,
    async *ids(chunkSize: number) {
      const size = Math.max(1, Math.min(chunkSize, WALK_CHUNK_SIZE));
      let position = page.cursor;
      let offset = start;
      while (true) {
        const rows = await sql<Array<{ id: string; pos: string }>>`
          SELECT id::text AS id, ${positionColumn(sort)} AS pos
          FROM lead_read_model_rows
          WHERE ${filter} ${after(sort, position)}
          ORDER BY ${orderBy(sort)}
          OFFSET ${offset}
          LIMIT ${size}
        `;
        offset = 0;
        if (rows.length === 0) return;
        yield rows.map((r) => r.id);
        if (rows.length < size) return;
        const last = rows[rows.length - 1];
        position = { createdAt: last.pos, id: last.id };
      }
    },
  };
}

/** Record that these addresses' delivery evidence changed. The next read of any model asks again. */
export async function noteEvidenceChanged(orgId: string, emails: readonly string[]): Promise<number> {
  const unique = [...new Set(emails.map((e) => e.trim()).filter((e) => e.length > 0))];
  if (unique.length === 0) return 0;
  await sql`
    INSERT INTO lead_read_changes (org_id, email, kind)
    SELECT ${orgId}, e, 'evidence' FROM unnest(${unique}::text[]) AS e
  `;
  return unique.length;
}

/** The overlay a hydrated row gets from the model's evidence — the same flatten the model used. */
export function modelDeliveryFor(
  scope: ReadModelScope,
  status: string,
  result: StatusResult | undefined,
): FlattenedStatus {
  if (!scope.deliveryQueried || status !== "served") return DEFAULT_STATUS;
  return result ? flattenOf(scope)(result) : DEFAULT_STATUS;
}
