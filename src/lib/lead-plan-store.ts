/**
 * WHICH rows a filtered / searched / re-ordered read returns, and in what order — held in the
 * DATABASE for the duration of one request, never in this process.
 *
 * A page whose ORDER depends on evidence another service holds (the reply that dates a lead) or
 * whose FILTER does (the bucket it is in) cannot be expressed as a SQL keyset over
 * `leads_campaigns` alone. So the population is walked in bounded chunks, each chunk's evidence is
 * fetched, the filter is applied, and the survivors' `(id, position)` pairs are appended HERE.
 * Only then is the order taken, and only the page's own ids are hydrated.
 *
 * The reason this is a temp table and not an array is that an array is O(the population). The
 * array form cost about 3.4 KB per person once its delivery overlay, its buckets and its outcome
 * set were attached, which is 160 MB of peak heap for one brand's 16,599-row export — over the
 * 384 MB heap this service ran with, so `FATAL ERROR: Reached heap limit` killed the process on
 * every press. Exit code 0, restart policy, `/health` green again in seconds: one customer's
 * download took every other org's Leads page down with it and nothing anywhere went red.
 *
 * A temp table moves the one unavoidably O(N) structure — the ORDER — to the one place equipped
 * for it: Postgres sorts it, spilling to disk if it must, and this process holds one chunk at a
 * time whatever the population is. The table lives on a RESERVED connection (a temp table is
 * session-scoped, so every statement touching it must be the same session) and is dropped when the
 * read ends, whether it ended well or not.
 */
import { sql } from "../db/index.js";
import { encodeLeadCursor, type LeadListPage } from "./lead-list-query.js";
import type { LeadSortOrder } from "./lead-page-plan.js";

/** The reserved connection a plan lives on. */
type ReservedSql = Awaited<ReturnType<typeof sql.reserve>>;

/** One row that survived the filter: what to hydrate, and where it sits in each order. */
export interface LeadPlanRow {
  /** `leads_campaigns.id` — the identity a list row carries, and what a page is hydrated by. */
  id: string;
  /** The instant that dates this lead's most advanced status. Never null — see leadActivityAt. */
  activityAt: string;
  /** `created_at::text`, full precision — the position a default-ordered cursor is built from. */
  createdAtText: string;
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
 * How the position a cursor carries is spelled, per order.
 *
 * `created` is the `created_at::text` Postgres gave us, carried through verbatim: `timestamptz`
 * holds MICROseconds and a JS `Date` holds milliseconds, so rendering it through one would floor
 * it and the next page would re-read everything inside the dropped microseconds.
 *
 * `activity` is an instant that already came in as a millisecond-precision ISO string (every
 * timestamp folded into it is normalized by `toIsoTimestamp`), so rendering it back to the same
 * shape loses nothing.
 */
function positionColumn(db: ReservedSql, sort: LeadSortOrder) {
  return sort === "created"
    ? db`created_at_text`
    : db`to_char(activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * The read's order.
 *
 * `created` is `(created_at, id)` ascending — the list's own total order, compared as TEXT under
 * the `C` collation so it is a byte comparison and agrees with the SQL `ORDER BY` of the plain
 * keyset walk to the microsecond. `activity` is newest-first, tie-broken by id descending.
 *
 * `id` is unique in both, so both orders are TOTAL: a walk visits every row exactly once.
 */
function orderBy(db: ReservedSql, sort: LeadSortOrder) {
  return sort === "created" ? db`created_at_text ASC, id ASC` : db`activity_at DESC, id DESC`;
}

/** Rows strictly after the caller's cursor, in the read's order. */
function cursorPredicate(db: ReservedSql, sort: LeadSortOrder, page: LeadListPage) {
  if (!page.cursor) return db``;
  return sort === "created"
    ? db`WHERE (created_at_text, id) > (${page.cursor.createdAt}, ${page.cursor.id}::uuid)`
    : db`WHERE (activity_at, id) < (${page.cursor.createdAt}::timestamptz, ${page.cursor.id}::uuid)`;
}

/** How many plan rows one INSERT carries. Bounded so no statement ever binds a whole population. */
const PLAN_INSERT_CHUNK = 1_000;

export class LeadPlanStore {
  constructor(private readonly db: ReservedSql) {}

  /** Append the rows of one chunk that survived the filter. Nothing else about them is kept. */
  async add(rows: readonly LeadPlanRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += PLAN_INSERT_CHUNK) {
      const slice = rows.slice(i, i + PLAN_INSERT_CHUNK);
      if (slice.length === 0) continue;
      const values = slice.map((row) => ({
        id: row.id,
        activity_at: row.activityAt,
        created_at_text: row.createdAtText,
      }));
      await this.db`INSERT INTO lead_read_plan ${this.db(values)}`;
    }
  }

  /**
   * Order the plan, apply the caller's window, and answer the page.
   *
   * `total` is counted AFTER the filter and BEFORE the window, so it is what the caller is paging
   * through — the number that labels "1-50 of N", not the size of the brand.
   */
  async page(sort: LeadSortOrder, page: LeadListPage): Promise<LeadPlanPage> {
    const totalRows = await this.db<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM lead_read_plan
    `;
    const total = totalRows[0]?.n ?? 0;

    // The order, taken ONCE and numbered, so the emit walk is a range scan over `seq` rather than
    // a re-sort per chunk.
    await this.db`DROP TABLE IF EXISTS lead_read_order`;
    await this.db`
      CREATE TEMP TABLE lead_read_order AS
      SELECT
        row_number() OVER (ORDER BY ${orderBy(this.db, sort)}) AS seq,
        id,
        ${positionColumn(this.db, sort)} AS pos
      FROM lead_read_plan
      ${cursorPredicate(this.db, sort, page)}
    `;

    const start = page.offset !== null && page.offset > 0 ? page.offset : 0;
    const end = page.limit === null ? null : start + page.limit;

    // A cursor is issued only when there is something after this page — the same rule the plain
    // keyset walk follows, so a caller that lands exactly on the last row is told it is done.
    let nextCursor: string | null = null;
    if (end !== null) {
      const boundary = await this.db<Array<{ seq: string; id: string; pos: string }>>`
        SELECT seq, id, pos FROM lead_read_order WHERE seq IN (${end}, ${end + 1}) ORDER BY seq
      `;
      const last = boundary.find((row) => Number(row.seq) === end);
      const more = boundary.some((row) => Number(row.seq) === end + 1);
      if (last && more) nextCursor = encodeLeadCursor({ createdAt: last.pos, id: last.id });
    }

    const db = this.db;
    async function* ids(chunkSize: number): AsyncGenerator<string[]> {
      const size = Math.max(1, chunkSize);
      let lo = start;
      while (end === null || lo < end) {
        const hi = end === null ? lo + size : Math.min(lo + size, end);
        const rows = await db<Array<{ id: string }>>`
          SELECT id FROM lead_read_order WHERE seq > ${lo} AND seq <= ${hi} ORDER BY seq
        `;
        if (rows.length === 0) return;
        yield rows.map((row) => row.id);
        if (rows.length < hi - lo) return;
        lo = hi;
      }
    }

    return { total, nextCursor, ids };
  }

  /**
   * Take the plan down and hand the connection back.
   *
   * A failure to drop is loud but never fatal to a response that has already been written: the
   * connection goes back to the pool either way, and the next read on it drops whatever is left.
   */
  async close(): Promise<void> {
    try {
      await this.db`DROP TABLE IF EXISTS lead_read_order`;
      await this.db`DROP TABLE IF EXISTS lead_read_plan`;
    } catch (error) {
      console.error(
        `[lead-service] could not drop this read's plan tables: ${(error as Error).message}`,
      );
    } finally {
      this.db.release();
    }
  }
}

/**
 * Open a plan for one read. The caller MUST `close()` it, however the read ends.
 *
 * The connection is RESERVED because a temp table belongs to one session: the walk that fills the
 * plan and the walk that reads it back must be the same connection, and nothing else may be handed
 * that connection in between. It is one connection out of the pool's twenty for the duration of
 * the read — the same shape the unbounded list walk already has.
 */
export async function openLeadPlanStore(): Promise<LeadPlanStore> {
  const reserved = await sql.reserve();
  try {
    // A previous read on this same pooled connection cannot leave a plan behind (close() drops
    // it), but a read whose close() failed can, and a stale plan would be silently counted into
    // this one.
    await reserved`DROP TABLE IF EXISTS lead_read_order`;
    await reserved`DROP TABLE IF EXISTS lead_read_plan`;
    await reserved`
      CREATE TEMP TABLE lead_read_plan (
        id uuid NOT NULL,
        activity_at timestamptz NOT NULL,
        created_at_text text COLLATE "C" NOT NULL
      )
    `;
  } catch (error) {
    reserved.release();
    throw error;
  }
  return new LeadPlanStore(reserved);
}
