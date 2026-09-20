/**
 * The read plan, executed against a REAL database.
 *
 * The order of a filtered read is the one part of it that is unavoidably O(the population), and it
 * now lives in Postgres rather than in this process — which means the ordering, the tie-break, the
 * cursor and the window are SQL, and a mocked `sql` compiles none of them. So this file runs the
 * statements: it creates a plan, fills it, and asserts the pages it hands back.
 *
 * The properties that matter are the ones a walk depends on. Both orders are TOTAL (`id` breaks
 * every tie), so walking a plan with a cursor visits every row exactly once — no gaps, no repeats
 * — which is what a customer pressing Export is entitled to.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { openLeadPlanStore } = await import("../../src/lib/lead-plan-store.js");
const { decodeLeadCursor } = await import("../../src/lib/lead-list-query.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

type Store = Awaited<ReturnType<typeof openLeadPlanStore>>;

const page = (over: Partial<{ limit: number | null; offset: number | null; cursor: unknown }> = {}) =>
  ({ limit: null, offset: null, cursor: null, ...over }) as never;

describe.skipIf(!hasRealDatabase)("the read plan against a real database", () => {
  let open: Store[] = [];

  async function plan(rows: Array<{ id: string; activityAt: string; createdAtText: string }>) {
    const store = await openLeadPlanStore();
    open.push(store);
    await store.add(rows);
    return store;
  }

  afterEach(async () => {
    for (const store of open) await store.close();
    open = [];
  });

  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
  const rows = [
    { id: ids[0], activityAt: "2026-03-01T10:00:00.000Z", createdAtText: "2026-01-01 10:00:00.000001+00" },
    { id: ids[1], activityAt: "2026-03-03T10:00:00.000Z", createdAtText: "2026-01-01 10:00:00.000002+00" },
    { id: ids[2], activityAt: "2026-03-02T10:00:00.000Z", createdAtText: "2026-01-02 10:00:00+00" },
    { id: ids[3], activityAt: "2026-03-04T10:00:00.000Z", createdAtText: "2026-01-03 10:00:00+00" },
  ];

  async function collect(store: Store, sort: "created" | "activity", over = {}) {
    const result = await store.page(sort, page(over));
    const out: string[] = [];
    for await (const chunk of result.ids(2)) out.push(...chunk);
    return { ...result, ids: out };
  }

  it("counts what matches and hands back every id, unbounded", async () => {
    const store = await plan(rows);
    const result = await collect(store, "created");
    expect(result.total).toBe(4);
    expect(result.ids).toHaveLength(4);
    expect(result.nextCursor).toBeNull();
  });

  it("orders `created` by the microsecond, not by the millisecond", async () => {
    const store = await plan(rows);
    // The first two differ only in the SIXTH decimal place. A position rendered through a JS Date
    // would floor both to the same millisecond and the second page would re-read the first row.
    const result = await collect(store, "created");
    expect(result.ids).toEqual([ids[0], ids[1], ids[2], ids[3]]);
  });

  it("orders `activity` newest-first", async () => {
    const store = await plan(rows);
    const result = await collect(store, "activity");
    expect(result.ids).toEqual([ids[3], ids[1], ids[2], ids[0]]);
  });

  it("windows by limit and offset over the read's own order", async () => {
    const store = await plan(rows);
    expect((await collect(store, "activity", { limit: 2 })).ids).toEqual([ids[3], ids[1]]);
    expect((await collect(store, "activity", { limit: 2, offset: 2 })).ids).toEqual([ids[2], ids[0]]);
    expect((await collect(store, "created", { limit: 1, offset: 3 })).ids).toEqual([ids[3]]);
  });

  it("issues a cursor only when something follows the page", async () => {
    const store = await plan(rows);
    expect((await collect(store, "created", { limit: 4 })).nextCursor).toBeNull();
    expect((await collect(store, "created", { limit: 3 })).nextCursor).not.toBeNull();
  });

  for (const sort of ["created", "activity"] as const) {
    it(`walks the whole plan exactly once with a cursor, in \`${sort}\` order`, async () => {
      const store = await plan(rows);
      const seen: string[] = [];
      let cursor: unknown = null;
      for (let guard = 0; guard < 10; guard++) {
        const result = await collect(store, sort, { limit: 1, cursor });
        seen.push(...result.ids);
        if (!result.nextCursor) break;
        cursor = decodeLeadCursor(result.nextCursor);
      }
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
      const straight = await collect(store, sort);
      expect(seen).toEqual(straight.ids);
    });
  }

  it("ties on the activity instant are broken by id, so the order is total", async () => {
    const tied = [randomUUID(), randomUUID()].sort();
    const store = await plan([
      { id: tied[0], activityAt: "2026-04-01T00:00:00.000Z", createdAtText: "2026-01-01 00:00:00+00" },
      { id: tied[1], activityAt: "2026-04-01T00:00:00.000Z", createdAtText: "2026-01-02 00:00:00+00" },
    ]);
    const first = await collect(store, "activity", { limit: 1 });
    expect(first.ids).toEqual([tied[1]]);
    const second = await collect(store, "activity", {
      limit: 1,
      cursor: decodeLeadCursor(first.nextCursor!),
    });
    expect(second.ids).toEqual([tied[0]]);
  });

  it("holds a plan bigger than one insert batch", async () => {
    const many = Array.from({ length: 2_500 }, (_, i) => ({
      id: randomUUID(),
      activityAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1000).toISOString(),
      createdAtText: `2026-01-01 00:00:00.${String(i).padStart(6, "0")}+00`,
    }));
    const store = await plan(many);
    const result = await store.page("activity", page());
    expect(result.total).toBe(2_500);
    let count = 0;
    for await (const chunk of result.ids(500)) count += chunk.length;
    expect(count).toBe(2_500);
  });

  it("a closed plan leaves nothing behind for the next read on that connection", async () => {
    const store = await plan(rows);
    await store.close();
    open = [];
    const next = await plan([rows[0]]);
    expect((await next.page("created", page())).total).toBe(1);
  });
});
