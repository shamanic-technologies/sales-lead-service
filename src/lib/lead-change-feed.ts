/**
 * A CHANGE FEED of a scope's compact lead rows: what a consumer holding a copy of a brand's (or a
 * campaign identity's, or an offer's) lead population needs to fetch to bring that copy up to date
 * — and nothing else.
 *
 * Why it exists. features-service computes a campaign Overview over the brand's WHOLE population
 * (`GET /orgs/leads?view=compact`) and re-reads all of it on every refresh: ~17.8k rows on its
 * busiest brand, four pages one after another, 4-9s, and it dominates the refresh. Nearly none of
 * those rows changed since the previous refresh a few seconds earlier. So this keeps, per scope,
 * every compact row WITH the version that last changed it, and answers "everything after version N"
 * off an index.
 *
 * What a row is. Exactly the object `view=compact` emits for it (toCompactLead, from the same
 * query, the same delivery evidence and the same flatten), stored as the serialized text. So a
 * consumer that takes the snapshot and applies every change after it holds, row for row, what a
 * full compact read returns. A row that LEFT the scope (the person's winning membership changed, a
 * serve was requeued, a status dropped out of the read's statuses) stays as a TOMBSTONE — its id,
 * a null payload, a new version — so a consumer holding it is told to drop it.
 *
 * How it stays current — the same three bounds the read model states (lead-read-model.ts):
 *
 *  1. Anything WRITTEN HERE that moves a compact row (a serve, a re-point, a status, a name, an
 *     email, an employer and its displayed firmographics) is noted by a trigger in the writer's own
 *     transaction (migration 0042, kind 'lead'), and the next read applies it before answering.
 *  2. Delivery evidence the sender PUSHES as changed (instantly-service announces every event it
 *     promotes — a send, an open, a click, a reply, a bounce — and every opt-out and classification
 *     a person states) is asked again and applied the same way.
 *  3. Everything else — evidence nobody pushed — is caught by a full RECONCILE: the whole scope is
 *     re-read, re-hashed and only rows whose serialization differs take a new version. The worker
 *     runs it every `FEED_RECONCILE_AFTER_MS` for a feed somebody reads, and a read of a feed whose
 *     last reconcile is older than `FEED_MAX_RECONCILE_AGE_MS` reconciles before it answers. That
 *     is ENFORCED, never documented-only.
 *
 * Why a version is never skipped. Every write takes its versions by bumping the feed row's counter
 * in the SAME transaction that writes the rows, so the feed row's lock serializes writers and
 * versions commit in the order they are handed out; a reader reads the COMMITTED counter first and
 * never looks past it. So "everything after N, up to the counter" is complete at the moment it is
 * read, without holding a transaction open while the answer streams.
 *
 * How a consumer knows it must start over. A position names the FEED it came from. A feed is
 * dropped once nobody has read it for `FEED_DROP_AFTER` (its change log is pruned on the same
 * horizon, so nothing older can be replayed), and a scope whose campaign identity grew a member is
 * a new scope with a new feed — either way the position no longer names this scope's feed, and the
 * answer is the whole snapshot with `full: true` and the reason, never a partial delta.
 *
 * FAIL LOUD. A feed that cannot be reconciled or caught up (email-gateway unreachable) is an error
 * the route answers 502 with — never an answer that silently skipped the rows it could not read.
 */
import { createHash } from "node:crypto";
import { sql } from "../db/index.js";
import { streamBasicLeadChunks, type BasicLeadRow } from "./basic-leads.js";
import { toCompactLead } from "./compact-lead.js";
import { crmPositiveReplyAtFor, fetchCrmPositiveReplyDates } from "./crm-positive-reply-dates.js";
import type { StatusResult } from "./email-gateway-client.js";
import type { EvidenceRequest } from "./lead-delivery-evidence.js";
import {
  currentXmin,
  listScopeOf,
  modelDeliveryFor,
  READ_MODEL_MAX_EVIDENCE_AGE_MS,
  READ_MODEL_REFRESH_AFTER_MS,
  readModelDelivery,
  readModelKey,
  type ReadModelScope,
} from "./lead-read-model.js";
import { prefetchOne } from "./prefetch.js";

/** A feed somebody reads is fully reconciled this often by the worker. */
export const FEED_RECONCILE_AFTER_MS = READ_MODEL_REFRESH_AFTER_MS;
/** The ENFORCED bound: a read of a feed whose last reconcile is older than this reconciles first. */
export const FEED_MAX_RECONCILE_AGE_MS = READ_MODEL_MAX_EVIDENCE_AGE_MS;
/**
 * A reconcile reuses delivery evidence asked at most this long before it started. Wide enough to
 * share the answers the read model's own two-minute rebuild of the same brand just asked for, so
 * the two do not both fan out to email-gateway; narrow enough that reconcile interval + this stays
 * inside `FEED_MAX_RECONCILE_AGE_MS`.
 */
const FEED_EVIDENCE_REUSE_MS = 90_000;
/** A feed nobody has read for this long stops being kept current by the worker. */
const FEED_KEEP_WARM_MS = 30 * 60_000;
/** A feed nobody has read for this long is dropped; any position into it then reads as expired. */
export const FEED_DROP_AFTER = "1 day";
/** How many rows one reconcile step holds. Bounds the heap whatever the scope's size. */
const RECONCILE_CHUNK_SIZE = 1_000;
/** How many people one incremental recompute step holds. */
const RECOMPUTE_CHUNK_SIZE = 500;
/** How many rows one read step streams. */
const READ_CHUNK_SIZE = 1_000;
/** Change seqs remembered per feed within its re-read window (see catchUp). */
const MAX_REMEMBERED_CHANGES = 20_000;

/** A feed as stored. `version` is a bigint, carried as its decimal text. */
export interface ChangeFeed {
  id: string;
  scopeKey: string;
  orgId: string;
  scope: ReadModelScope;
  version: string;
  appliedXmin: string;
  evidenceAt: Date | null;
  reconciledAt: Date | null;
}

interface RawFeed {
  id: string;
  scope_key: string;
  org_id: string;
  scope: ReadModelScope;
  version: string;
  applied_xmin: string;
  evidence_at: Date | string | null;
  reconciled_at: Date | string | null;
}

function mapFeed(row: RawFeed): ChangeFeed {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    orgId: row.org_id,
    scope: row.scope,
    version: row.version,
    appliedXmin: row.applied_xmin,
    evidenceAt: row.evidence_at ? new Date(row.evidence_at) : null,
    reconciledAt: row.reconciled_at ? new Date(row.reconciled_at) : null,
  };
}

async function loadFeedBy(column: "scope_key" | "id", value: string): Promise<ChangeFeed | null> {
  const rows = await sql<RawFeed[]>`
    SELECT id::text AS id, scope_key, org_id, scope, version::text AS version,
           applied_xmin::text AS applied_xmin, evidence_at, reconciled_at
    FROM lead_change_feeds
    WHERE ${column === "id" ? sql`id = ${value}::uuid` : sql`scope_key = ${value}`}
  `;
  return rows[0] ? mapFeed(rows[0]) : null;
}

/** One key per distinct scope — the read model's canonical key, over the same fields. */
export function changeFeedKey(scope: ReadModelScope): string {
  return readModelKey(scope);
}

// ── positions ────────────────────────────────────────────────────────────────────────────────

/** A position in a feed: which feed, and the last version the holder has applied. */
export interface FeedPosition {
  feedId: string;
  version: string;
}

const POSITION_PREFIX = "lf1.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A position this service did not issue (or not for this scope). The route answers 400. */
export class FeedPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedPositionError";
  }
}

/** Opaque on the wire: a caller stores it and hands it back, nothing more. */
export function encodeFeedPosition(position: FeedPosition): string {
  return (
    POSITION_PREFIX +
    Buffer.from(`${position.feedId}:${position.version}`, "utf8").toString("base64url")
  );
}

/** Throws on anything this service did not issue — a caller error, answered 400, never a reset. */
export function decodeFeedPosition(raw: string): FeedPosition {
  if (!raw.startsWith(POSITION_PREFIX)) throw new FeedPositionError("since is not a position this endpoint issued");
  const decoded = Buffer.from(raw.slice(POSITION_PREFIX.length), "base64url").toString("utf8");
  const [feedId, version, extra] = decoded.split(":");
  if (extra !== undefined || !feedId || !UUID_RE.test(feedId) || !version || !/^\d{1,18}$/.test(version)) {
    throw new FeedPositionError("since is not a position this endpoint issued");
  }
  return { feedId: feedId.toLowerCase(), version };
}

// ── rows ─────────────────────────────────────────────────────────────────────────────────────

/** A row as the scope holds it right now. */
export interface FreshFeedRow {
  id: string;
  leadId: string;
  email: string | null;
  payload: string;
  hash: string;
}

/** The delivery questions a chunk asks: served rows with an address, under their primary brand. */
function evidenceRequests(rows: readonly BasicLeadRow[]): EvidenceRequest[] {
  const out: EvidenceRequest[] = [];
  for (const row of rows) {
    if (row.status !== "served" || !row.email?.value) continue;
    out.push({ brandId: row.brandIds[0] ?? "unknown", email: row.email.value });
  }
  return out;
}

/** Serialize a chunk exactly as `view=compact` does, off the same overlay. */
export function freshFeedRows(
  scope: ReadModelScope,
  rows: readonly BasicLeadRow[],
  delivery: ReadonlyMap<string, StatusResult>,
  crmReplies: ReadonlyMap<string, string>,
): FreshFeedRow[] {
  return rows.map((row) => {
    const payload = JSON.stringify(
      toCompactLead(
        row,
        modelDeliveryFor(scope, row.status, delivery.get(row.email?.value ?? "")),
        crmPositiveReplyAtFor(crmReplies, row),
      ),
    );
    return {
      id: row.id,
      leadId: row.leadId,
      email: row.email?.value ?? null,
      payload,
      hash: createHash("sha256").update(payload).digest("base64url"),
    };
  });
}

async function readChunk(
  feed: ChangeFeed,
  rows: readonly BasicLeadRow[],
  acceptFetchedSince: Date,
  changedAt?: ReadonlyMap<string, Date>,
): Promise<FreshFeedRow[]> {
  if (rows.length === 0) return [];
  const delivery = await readModelDelivery(
    feed.scope,
    evidenceRequests(rows),
    acceptFetchedSince,
    changedAt,
  );
  const crmReplies = await fetchCrmPositiveReplyDates(rows);
  return freshFeedRows(feed.scope, rows, delivery, crmReplies);
}

/**
 * Write what changed: every fresh row whose serialization differs from what the feed holds, and a
 * tombstone for every held row named in `removedIds` that is not one already. Each takes the next
 * version, handed out by the feed row's own counter in the same transaction — see the module note.
 * Returns how many rows changed.
 */
export async function applyFeedChanges(
  feed: ChangeFeed,
  fresh: readonly FreshFeedRow[],
  removedIds: readonly string[],
): Promise<number> {
  const ids = [...fresh.map((r) => r.id), ...removedIds];
  if (ids.length === 0) return 0;
  const stored = await sql<Array<{ id: string; hash: string | null }>>`
    SELECT id::text AS id, hash FROM lead_change_feed_rows
    WHERE feed_id = ${feed.id}::uuid AND id = ANY(${ids}::uuid[])
  `;
  const held = new Map(stored.map((r) => [r.id, r.hash]));
  const changed = fresh.filter((r) => held.get(r.id) !== r.hash);
  const tombstones = removedIds.filter((id) => (held.get(id) ?? null) !== null);
  const writes = changed.length + tombstones.length;
  if (writes === 0) return 0;

  const top = await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof sql;
    const bumped = await tx<Array<{ version: string }>>`
      UPDATE lead_change_feeds SET version = version + ${writes}::bigint
      WHERE id = ${feed.id}::uuid
      RETURNING version::text AS version
    `;
    if (!bumped[0]) throw new Error(`[lead-change-feed] feed ${feed.id} vanished mid-write`);
    const last = BigInt(bumped[0].version);
    const first = last - BigInt(writes) + 1n;
    const versions = Array.from({ length: writes }, (_, i) => (first + BigInt(i)).toString());
    if (changed.length > 0) {
      const n = changed.length;
      await tx`
        INSERT INTO lead_change_feed_rows (feed_id, id, lead_id, email, payload, hash, version)
        SELECT ${feed.id}::uuid, u.id, u.lead_id, u.email, u.payload, u.hash, u.version
        FROM unnest(
          ${changed.map((r) => r.id)}::uuid[],
          ${changed.map((r) => r.leadId)}::uuid[],
          ${changed.map((r) => r.email)}::text[],
          ${changed.map((r) => r.payload)}::text[],
          ${changed.map((r) => r.hash)}::text[],
          ${versions.slice(0, n)}::bigint[]
        ) AS u(id, lead_id, email, payload, hash, version)
        ON CONFLICT (feed_id, id) DO UPDATE SET
          lead_id = EXCLUDED.lead_id,
          email = EXCLUDED.email,
          payload = EXCLUDED.payload,
          hash = EXCLUDED.hash,
          version = EXCLUDED.version
      `;
    }
    if (tombstones.length > 0) {
      await tx`
        UPDATE lead_change_feed_rows r
        SET payload = NULL, hash = NULL, version = u.version
        FROM unnest(${tombstones}::uuid[], ${versions.slice(changed.length)}::bigint[]) AS u(id, version)
        WHERE r.feed_id = ${feed.id}::uuid AND r.id = u.id
      `;
    }
    return bumped[0].version;
  });
  feed.version = top;
  return writes;
}

// ── keeping a feed current ───────────────────────────────────────────────────────────────────

/** Evidence changes pushed recently enough that a stored answer may predate them. */
async function recentEvidenceChanges(orgId: string, since: Date): Promise<Map<string, Date>> {
  const rows = await sql<Array<{ email: string; at: Date | string }>>`
    SELECT lower(email) AS email, max(created_at) AS at
    FROM lead_read_changes
    WHERE org_id = ${orgId} AND kind = 'evidence' AND email IS NOT NULL
      AND created_at >= ${since.toISOString()}::timestamptz
    GROUP BY lower(email)
  `;
  return new Map(rows.map((r) => [r.email, new Date(r.at)]));
}

/**
 * Re-read the WHOLE scope and write only what differs. The first reconcile of a new feed is its
 * build: every row is new, so every row takes a version.
 */
export async function reconcileFeed(feed: ChangeFeed): Promise<number> {
  const startedAt = Date.now();
  // Taken BEFORE any row is read: a change committed from here on is re-applied by the next
  // catch-up even if this walk already read the row before it.
  const xmin = await currentXmin();
  const evidenceAt = new Date(startedAt - FEED_EVIDENCE_REUSE_MS);
  const changedAt = await recentEvidenceChanges(feed.orgId, evidenceAt);
  const seen = new Set<string>();
  let changed = 0;
  for await (const rows of prefetchOne(
    streamBasicLeadChunks(listScopeOf(feed.scope), RECONCILE_CHUNK_SIZE),
  )) {
    const fresh = await readChunk(feed, rows, evidenceAt, changedAt);
    for (const row of fresh) seen.add(row.id);
    changed += await applyFeedChanges(feed, fresh, []);
  }
  const gone = await sql<Array<{ id: string }>>`
    SELECT id::text AS id FROM lead_change_feed_rows
    WHERE feed_id = ${feed.id}::uuid AND payload IS NOT NULL
      AND NOT (id = ANY(${[...seen]}::uuid[]))
  `;
  changed += await applyFeedChanges(
    feed,
    [],
    gone.map((r) => r.id),
  );
  await sql`
    UPDATE lead_change_feeds
    SET reconciled_at = ${new Date(startedAt).toISOString()}::timestamptz,
        evidence_at = ${evidenceAt.toISOString()}::timestamptz,
        applied_xmin = GREATEST(applied_xmin, ${xmin}::xid8)
    WHERE id = ${feed.id}::uuid
  `;
  feed.reconciledAt = new Date(startedAt);
  feed.evidenceAt = evidenceAt;
  appliedChanges.delete(feed.id);
  console.log(
    `[lead-change-feed] reconciled org=${feed.orgId} brand=${feed.scope.brandId ?? "-"} ` +
      `campaigns=${feed.scope.campaignIds?.length ?? 0} rows=${seen.size} changed=${changed} ` +
      `in ${Date.now() - startedAt}ms`,
  );
  return changed;
}

/** Recompute these PEOPLE from the current rows and evidence, and write what differs. */
async function recomputeLeads(
  feed: ChangeFeed,
  leadIds: readonly string[],
  changedAt: ReadonlyMap<string, Date>,
): Promise<number> {
  const acceptSince = feed.evidenceAt ?? new Date(Date.now() - FEED_EVIDENCE_REUSE_MS);
  let changed = 0;
  for (let i = 0; i < leadIds.length; i += RECOMPUTE_CHUNK_SIZE) {
    const slice = leadIds.slice(i, i + RECOMPUTE_CHUNK_SIZE);
    const rows: BasicLeadRow[] = [];
    for await (const chunk of streamBasicLeadChunks(
      { ...listScopeOf(feed.scope), leadIds: slice },
      RECOMPUTE_CHUNK_SIZE,
    )) {
      rows.push(...chunk);
    }
    const fresh = await readChunk(feed, rows, acceptSince, changedAt);
    const freshIds = new Set(fresh.map((r) => r.id));
    // A person whose winning row changed, or who left the scope, leaves a held row behind.
    const held = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM lead_change_feed_rows
      WHERE feed_id = ${feed.id}::uuid AND lead_id = ANY(${slice}::uuid[]) AND payload IS NOT NULL
    `;
    changed += await applyFeedChanges(
      feed,
      fresh,
      held.map((r) => r.id).filter((id) => !freshIds.has(id)),
    );
  }
  return changed;
}

interface RawChange {
  seq: string;
  lead_id: string | null;
  email: string | null;
  kind: string;
  created_at: Date | string;
}

/** Change seqs each feed has already applied, within its re-read window. In-process only. */
const appliedChanges = new Map<string, Set<string>>();

/**
 * Apply every change the feed has not seen — exactly the read model's catch-up (see there for why
 * `applied_xmin` re-reads rather than skips a late commit), over the two kinds that move a compact
 * row: 'lead' (written here) and 'evidence' (pushed by the sender).
 */
export async function catchUpFeed(feed: ChangeFeed): Promise<number> {
  const xmin = await currentXmin();
  const seen = appliedChanges.get(feed.id) ?? new Set<string>();
  const changes = (
    await sql<RawChange[]>`
      SELECT seq::text AS seq, lead_id::text AS lead_id, email, kind, created_at
      FROM lead_read_changes
      WHERE org_id = ${feed.orgId} AND txid >= ${feed.appliedXmin}::xid8
        AND kind IN ('lead', 'evidence')
    `
  ).filter((change) => !seen.has(change.seq));
  let changed = 0;
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
        SELECT DISTINCT lead_id::text AS lead_id FROM lead_change_feed_rows
        WHERE feed_id = ${feed.id}::uuid AND lower(email) = ANY(${[...changedAt.keys()]}::text[])
      `;
      for (const row of affected) leadIds.add(row.lead_id);
    }
    if (leadIds.size > 0) changed = await recomputeLeads(feed, [...leadIds], changedAt);
    if (seen.size > MAX_REMEMBERED_CHANGES) seen.clear();
    for (const change of changes) seen.add(change.seq);
    appliedChanges.set(feed.id, seen);
  }
  await sql`
    UPDATE lead_change_feeds SET applied_xmin = ${xmin}::xid8
    WHERE id = ${feed.id}::uuid AND applied_xmin < ${xmin}::xid8
  `;
  feed.appliedXmin = xmin;
  return changed;
}

/** Per-feed serialization: a reconcile, a catch-up and a creation of one scope never overlap. */
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

function withinBound(feed: ChangeFeed, now: number): boolean {
  return feed.reconciledAt !== null && feed.reconciledAt.getTime() >= now - FEED_MAX_RECONCILE_AGE_MS;
}

async function createFeed(scope: ReadModelScope, key: string): Promise<ChangeFeed> {
  const xmin = await currentXmin();
  await sql`
    INSERT INTO lead_change_feeds (scope_key, org_id, scope, applied_xmin)
    VALUES (${key}, ${scope.orgId}, ${JSON.stringify(scope)}::jsonb, ${xmin}::xid8)
    ON CONFLICT (scope_key) DO NOTHING
  `;
  const feed = await loadFeedBy("scope_key", key);
  if (!feed) throw new Error(`[lead-change-feed] feed for ${key} could not be created`);
  return feed;
}

/**
 * The feed a read answers from, current: created and built if the scope has none, reconciled if
 * its last reconcile is past the bound, otherwise caught up with every change it has not seen.
 *
 * One exception keeps a read fast: when the feed is within its bound and somebody else (the
 * worker's reconcile, another read) is already bringing it up to date, the read answers from what
 * is COMMITTED rather than queueing behind a whole-scope reconcile. What that read misses is at
 * most what lands during that reconcile, and it carries a higher version than the position the
 * read hands back — so the next read delivers it. Nothing is ever lost, only a few seconds late.
 */
export async function openChangeFeed(scope: ReadModelScope): Promise<ChangeFeed> {
  const key = changeFeedKey(scope);
  const current = await loadFeedBy("scope_key", key);
  if (current && withinBound(current, Date.now()) && keyLocks.has(key)) {
    await touch(current);
    return current;
  }
  return withKeyLock(key, async () => {
    let feed = await loadFeedBy("scope_key", key);
    if (!feed) {
      feed = await createFeed(scope, key);
      await reconcileFeed(feed);
    } else if (!withinBound(feed, Date.now())) {
      await reconcileFeed(feed);
    } else {
      await catchUpFeed(feed);
    }
    await touch(feed);
    return feed;
  });
}

async function touch(feed: ChangeFeed): Promise<void> {
  await sql`
    UPDATE lead_change_feeds SET last_read_at = now()
    WHERE id = ${feed.id}::uuid AND last_read_at < now() - interval '10 seconds'
  `;
}

/** The feed a position names, whatever scope it belongs to — or null when it no longer exists. */
export async function feedById(feedId: string): Promise<ChangeFeed | null> {
  return loadFeedBy("id", feedId);
}

// ── reading a feed ───────────────────────────────────────────────────────────────────────────

/** The committed version: nothing at or below it can still be in flight. */
async function committedVersion(feed: ChangeFeed): Promise<string> {
  const rows = await sql<Array<{ version: string }>>`
    SELECT version::text AS version FROM lead_change_feeds WHERE id = ${feed.id}::uuid
  `;
  if (!rows[0]) throw new Error(`[lead-change-feed] feed ${feed.id} vanished`);
  return rows[0].version;
}

/** One step of a read: rows to put (serialized payloads) and ids to drop. */
export interface FeedReadChunk {
  put: string[];
  removed: string[];
}

/**
 * Read a feed: the whole snapshot when `since` is null, otherwise every row that changed after it.
 * Either way bounded by the version committed when the read began, which is the position returned
 * — a row changed after that is left out here and carries a higher version, so the next read has
 * it. Walked by keyset a chunk at a time; never holds the population, never holds a transaction.
 */
export async function readChangeFeed(
  feed: ChangeFeed,
  since: string | null,
): Promise<{ position: string; chunks: AsyncGenerator<FeedReadChunk> }> {
  const top = await committedVersion(feed);
  // Versions only grow, so a position past the counter was never handed out by this feed.
  if (since !== null && BigInt(since) > BigInt(top)) {
    throw new FeedPositionError("since names a version this feed never handed out");
  }
  const position = encodeFeedPosition({ feedId: feed.id, version: top });
  async function* chunks(): AsyncGenerator<FeedReadChunk> {
    if (since === null) {
      let after: string | null = null;
      for (;;) {
        const rows: Array<{ id: string; payload: string }> = await sql<Array<{ id: string; payload: string }>>`
          SELECT id::text AS id, payload FROM lead_change_feed_rows
          WHERE feed_id = ${feed.id}::uuid AND payload IS NOT NULL AND version <= ${top}::bigint
            ${after ? sql`AND id > ${after}::uuid` : sql``}
          ORDER BY id
          LIMIT ${READ_CHUNK_SIZE}
        `;
        if (rows.length === 0) return;
        yield { put: rows.map((r) => r.payload), removed: [] };
        if (rows.length < READ_CHUNK_SIZE) return;
        after = rows[rows.length - 1].id;
      }
    }
    let after = since;
    for (;;) {
      const rows: Array<{ id: string; payload: string | null; version: string }> = await sql<
        Array<{ id: string; payload: string | null; version: string }>
      >`
        SELECT id::text AS id, payload, version::text AS version FROM lead_change_feed_rows
        WHERE feed_id = ${feed.id}::uuid AND version > ${after}::bigint AND version <= ${top}::bigint
        ORDER BY version
        LIMIT ${READ_CHUNK_SIZE}
      `;
      if (rows.length === 0) return;
      yield {
        put: rows.filter((r) => r.payload !== null).map((r) => r.payload!),
        removed: rows.filter((r) => r.payload === null).map((r) => r.id),
      };
      if (rows.length < READ_CHUNK_SIZE) return;
      after = rows[rows.length - 1].version;
    }
  }
  return { position, chunks: chunks() };
}

// ── worker ───────────────────────────────────────────────────────────────────────────────────

let sweeping = false;

/** Keep every feed somebody reads current, and drop the ones nobody does. */
export async function sweepChangeFeeds(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const live = await sql<RawFeed[]>`
      SELECT id::text AS id, scope_key, org_id, scope, version::text AS version,
             applied_xmin::text AS applied_xmin, evidence_at, reconciled_at
      FROM lead_change_feeds
      WHERE last_read_at > now() - make_interval(secs => ${FEED_KEEP_WARM_MS / 1000})
    `;
    for (const raw of live) {
      const key = raw.scope_key;
      try {
        await withKeyLock(key, async () => {
          const feed = await loadFeedBy("scope_key", key);
          if (!feed) return;
          const due =
            feed.reconciledAt === null ||
            feed.reconciledAt.getTime() < Date.now() - FEED_RECONCILE_AFTER_MS;
          if (due) await reconcileFeed(feed);
          else await catchUpFeed(feed);
        });
      } catch (error) {
        console.error(
          `[lead-change-feed] feed ${raw.id} (org=${raw.org_id} brand=${raw.scope.brandId ?? "-"}) could ` +
            `not be kept current; a read past its bound will reconcile it or answer 502: ${(error as Error).message}`,
        );
      }
    }
    const dropped = await sql<Array<{ id: string }>>`
      DELETE FROM lead_change_feeds
      WHERE last_read_at < now() - ${FEED_DROP_AFTER}::interval
      RETURNING id::text AS id
    `;
    for (const row of dropped) appliedChanges.delete(row.id);
  } finally {
    sweeping = false;
  }
}

export const CHANGE_FEED_WORKER_INTERVAL_MS = 15_000;

export function startChangeFeedWorker(): void {
  const tick = () => {
    sweepChangeFeeds().catch((error) => console.error("[lead-change-feed] sweep failed:", error));
  };
  setTimeout(tick, 25_000).unref();
  setInterval(tick, CHANGE_FEED_WORKER_INTERVAL_MS).unref();
}
