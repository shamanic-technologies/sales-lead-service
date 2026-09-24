import { describe, it, expect, beforeEach, vi } from "vitest";

// A `sql` mock that actually HONOURS the LIMIT / OFFSET / keyset predicate the query carries,
// instead of handing back a fixed slice. Without that, a handler that accepts a bound and drops it
// still passes — which is exactly how the dropped bound shipped and stayed unnoticed. The mock
// walks the same (created_at, id) total order Postgres would.
interface SqlNode {
  __sql: true;
  strings: readonly string[];
  values: unknown[];
}

let mockRows: Array<Record<string, unknown>> = [];
/** Every executed (non-fragment) query, in order, with the bounds it actually carried. */
let executed: Array<{ limit: number | null; offset: number | null; cursorId: string | null }> = [];

function isNode(v: unknown): v is SqlNode {
  return !!v && typeof v === "object" && (v as SqlNode).__sql === true;
}

/** Pull the bounds out of a query tree — nested `sql` fragments are values on the outer node. */
function readBounds(node: SqlNode): { limit: number | null; offset: number | null; cursorId: string | null } {
  let limit: number | null = null;
  let offset: number | null = null;
  let cursorId: string | null = null;

  node.strings.forEach((s, i) => {
    if (/LIMIT\s*$/.test(s)) limit = node.values[i] as number;
    if (/OFFSET\s*$/.test(s)) offset = node.values[i] as number;
    if (/lc\.id\)\s*>\s*\(\s*$/.test(s)) cursorId = node.values[i + 1] as string;
  });

  for (const v of node.values) {
    if (!isNode(v)) continue;
    const nested = readBounds(v);
    limit = limit ?? nested.limit;
    offset = offset ?? nested.offset;
    cursorId = cursorId ?? nested.cursorId;
  }
  return { limit, offset, cursorId };
}

// Bind-faithful: postgres.js calls Buffer.byteLength() on every param, which THROWS on a Date
// before the query is ever sent. A mock that ignores params lets a handler that binds a raw Date
// ship green and 500 on the first production request — assert it here instead.
function assertBindable(values: unknown[]): void {
  for (const v of values) {
    if (isNode(v)) { assertBindable(v.values); continue; }
    if (v instanceof Date) {
      throw new TypeError(
        'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date',
      );
    }
  }
}

function isExecutable(node: SqlNode): boolean {
  const text = node.strings.join(" ");
  return /ORDER BY lc\.created_at/.test(text);
}

function resolveRows(node: SqlNode): Array<Record<string, unknown>> {
  assertBindable(node.values);
  const { limit, offset, cursorId } = readBounds(node);
  executed.push({ limit, offset, cursorId });
  // ids are lexically ordered and created_at is uniform, so `(created_at, id) > (c, cid)`
  // reduces to `id > cid` — the same total order the real query walks.
  let rows = cursorId === null ? mockRows : mockRows.filter((r) => (r.id as string) > cursorId);
  if (offset) rows = rows.slice(offset);
  if (limit !== null) rows = rows.slice(0, limit);
  return rows;
}

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const node: SqlNode = { __sql: true, strings, values };
    if (!isExecutable(node)) return node;
    return {
      ...node,
      then: (resolve: (rows: unknown[]) => void) => Promise.resolve(resolveRows(node)).then(resolve),
      // Server-side cursor: the unbounded path streams the whole set in chunks.
      cursor: (size: number) => ({
        async *[Symbol.asyncIterator]() {
          const rows = resolveRows(node);
          for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
        },
      }),
    };
  },
}));

const { streamBasicLeadChunks } = await import("../../src/lib/basic-leads.js");
const { encodeLeadCursor, UNBOUNDED_LEAD_PAGE } = await import("../../src/lib/lead-list-query.js");

const ORG = "30000000-0000-0000-0000-000000000001";
const SCOPE = { orgId: ORG };

/** A minimal raw row: the walk only keys on (created_at, id). */
function rawRow(i: number) {
  return {
    id: `lc-${String(i).padStart(4, "0")}`,
    lead_id: `lead-${i}`,
    // String, not Date — the shape postgres.js actually returns on this path. The MICROseconds
    // matter: a cursor that floors them to milliseconds re-reads rows on the next page.
    created_at: `2026-01-01 00:00:00.00000${i % 10}+00`,
    created_at_cursor: `2026-01-01 00:00:00.00000${i % 10}+00`,
  };
}

async function collect(page = UNBOUNDED_LEAD_PAGE, chunkSize = 500) {
  const ids: string[] = [];
  for await (const chunk of streamBasicLeadChunks(SCOPE, chunkSize, page)) {
    for (const row of chunk) ids.push(row.id);
  }
  return ids;
}

beforeEach(() => {
  mockRows = Array.from({ length: 57 }, (_, i) => rawRow(i));
  executed = [];
});

describe("streamBasicLeadChunks — bounded reads", () => {
  it("returns the whole population when the caller names no bound", async () => {
    const ids = await collect();
    expect(ids).toHaveLength(57);
    // Unbounded keeps the single server-side-cursor query: no per-chunk re-execution.
    expect(executed).toHaveLength(1);
    expect(executed[0].limit).toBeNull();
  });

  it("returns AT MOST the number of rows the caller asked for, and stops reading there", async () => {
    const ids = await collect({ limit: 5, cursor: null, offset: null });
    expect(ids).toHaveLength(5);
    // The bound reaches the database: one query, LIMIT 5. The 52 other rows are never read,
    // never hydrated, never serialized.
    expect(executed).toEqual([{ limit: 5, offset: null, cursorId: null }]);
  });

  it("never fetches more than the caller asked for even when the bound is under one chunk", async () => {
    const ids = await collect({ limit: 3, cursor: null, offset: null }, 500);
    expect(ids).toHaveLength(3);
    expect(executed[0].limit).toBe(3);
  });

  it("walks the whole population in bounded pages with no gaps and no repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = {
        limit: 10,
        cursor: cursor === null ? null : decodeCursor(cursor),
        offset: null,
      };
      const ids = await collect(page);
      seen.push(...ids);
      if (ids.length < 10) break;
      const lastRow = mockRows.find((r) => r.id === ids[ids.length - 1])!;
      cursor = encodeLeadCursor({ createdAt: lastRow.created_at_cursor as string, id: lastRow.id as string });
    }
    expect(seen).toHaveLength(57);
    expect(new Set(seen).size).toBe(57);
    expect(seen).toEqual(mockRows.map((r) => r.id));
  });

  it("honours offset over the same order, then keeps walking by keyset", async () => {
    const ids = await collect({ limit: 4, cursor: null, offset: 50 });
    expect(ids).toEqual(mockRows.slice(50, 54).map((r) => r.id));
    expect(executed[0]).toEqual({ limit: 4, offset: 50, cursorId: null });
  });

  it("reads a bounded page in ONE statement, however many chunks it streams in", async () => {
    // chunkSize below the limit: the page arrives in two chunks, but it is one execution carrying
    // the whole bound. A statement per chunk re-ran the brand's whole-population dedup per chunk —
    // ten times for a 5,000-row page in production.
    const ids = await collect({ limit: 6, cursor: null, offset: 10 }, 3);
    expect(ids).toEqual(mockRows.slice(10, 16).map((r) => r.id));
    expect(executed).toEqual([{ limit: 6, offset: 10, cursorId: null }]);
  });

  it("resumes from a keyset cursor in ONE statement", async () => {
    const last = mockRows[20];
    const ids = await collect(
      { limit: 5, cursor: { createdAt: last.created_at_cursor as string, id: last.id as string }, offset: null },
      2,
    );
    expect(ids).toEqual(mockRows.slice(21, 26).map((r) => r.id));
    expect(executed).toEqual([{ limit: 5, offset: null, cursorId: last.id }]);
  });
});

function decodeCursor(encoded: string): { createdAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { t: string; i: string };
  return { createdAt: parsed.t, id: parsed.i };
}
