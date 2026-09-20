/**
 * An in-memory stand-in for the database-side read plan, for route tests that mock `sql` outright.
 *
 * The real plan (src/lib/lead-plan-store.ts) lives in a temp table on a reserved connection,
 * precisely so that the ORDER of a filtered read never occupies this process. A test whose `sql`
 * is a `vi.fn()` compiles none of that, so it gets this instead: the same contract — append rows,
 * then take a page — with the order and the window done in JS.
 *
 * What that DOES NOT cover is whether the SQL is right, which is the part that can only fail
 * against a real Postgres. `tests/integration/lead-plan-store-sql.test.ts` runs the statements.
 */
import { encodeLeadCursor, type LeadListPage } from "../../src/lib/lead-list-query.js";
import type { LeadPlanPage, LeadPlanRow } from "../../src/lib/lead-plan-store.js";
import type { LeadSortOrder } from "../../src/lib/lead-page-plan.js";

export class FakeLeadPlanStore {
  readonly rows: LeadPlanRow[] = [];
  closed = false;

  async add(rows: readonly LeadPlanRow[]): Promise<void> {
    this.rows.push(...rows);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async page(sort: LeadSortOrder, page: LeadListPage): Promise<LeadPlanPage> {
    const total = this.rows.length;
    const ordered = [...this.rows].sort((a, b) =>
      sort === "created"
        ? a.createdAtText === b.createdAtText
          ? a.id < b.id
            ? -1
            : 1
          : a.createdAtText < b.createdAtText
            ? -1
            : 1
        : a.activityAt === b.activityAt
          ? a.id > b.id
            ? -1
            : 1
          : new Date(a.activityAt).getTime() > new Date(b.activityAt).getTime()
            ? -1
            : 1,
    );
    const position = (row: LeadPlanRow) => (sort === "created" ? row.createdAtText : row.activityAt);
    const cursor = page.cursor;
    const afterCursor = cursor
      ? ordered.filter((row) =>
          sort === "created"
            ? position(row) === cursor.createdAt
              ? row.id > cursor.id
              : position(row) > cursor.createdAt
            : new Date(position(row)).getTime() === new Date(cursor.createdAt).getTime()
              ? row.id < cursor.id
              : new Date(position(row)).getTime() < new Date(cursor.createdAt).getTime(),
        )
      : ordered;
    const start = page.offset !== null && page.offset > 0 ? page.offset : 0;
    const windowed = afterCursor.slice(start);
    const pageRows = page.limit === null ? windowed : windowed.slice(0, page.limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      page.limit !== null && last && windowed.length > pageRows.length
        ? encodeLeadCursor({ createdAt: position(last), id: last.id })
        : null;

    async function* ids(chunkSize: number): AsyncGenerator<string[]> {
      for (let i = 0; i < pageRows.length; i += Math.max(1, chunkSize)) {
        yield pageRows.slice(i, i + Math.max(1, chunkSize)).map((row) => row.id);
      }
    }

    return { total, nextCursor, ids };
  }
}

/** The `vi.mock` factory a route test hands `src/lib/lead-plan-store.js`. */
export function fakePlanStoreModule(capture?: (store: FakeLeadPlanStore) => void) {
  return {
    openLeadPlanStore: async () => {
      const store = new FakeLeadPlanStore();
      capture?.(store);
      return store;
    },
  };
}
