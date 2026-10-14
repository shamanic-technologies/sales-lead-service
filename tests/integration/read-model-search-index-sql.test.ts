/**
 * The Leads search's trigram index (src/lib/read-model-search-index.ts) against a REAL database:
 * built when missing, left alone when valid, rebuilt when a dead build left it INVALID, and never
 * built twice at once. The planner's choice is not asserted here (tiny tables are seq-scanned
 * whatever exists); what the index may never do is change a result, and it cannot: every candidate
 * is rechecked against the same ILIKE (search results are covered by lead-read-model-sql.test.ts).
 */
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const { sql } = await import("../../src/db/index.js");
const { ensureReadModelSearchIndex, SEARCH_INDEX_NAME } = await import(
  "../../src/lib/read-model-search-index.js"
);

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const dsn = process.env.LEAD_SERVICE_DATABASE_URL!;
const hasRealDatabase = dsn !== PLACEHOLDER_DSN;

async function indexState(): Promise<{ valid: boolean; def: string } | null> {
  const [row] = await sql<Array<{ valid: boolean; def: string }>>`
    SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = ${SEARCH_INDEX_NAME}
  `;
  return row ?? null;
}

describe.skipIf(!hasRealDatabase)("read-model search index against a real database", () => {
  afterAll(async () => {
    // Leave it built: it is what production holds after boot.
    await ensureReadModelSearchIndex(dsn);
  });

  it("builds a valid trigram index on search_text when none exists, then leaves it alone", async () => {
    await sql.unsafe(`DROP INDEX IF EXISTS ${SEARCH_INDEX_NAME}`);
    expect(await indexState()).toBeNull();

    expect(await ensureReadModelSearchIndex(dsn)).toBe("built");
    const built = await indexState();
    expect(built?.valid).toBe(true);
    expect(built?.def).toContain("lead_read_model_rows USING gin (search_text gin_trgm_ops)");

    expect(await ensureReadModelSearchIndex(dsn)).toBe("present");
  });

  it("rebuilds an index a dead build left INVALID", async () => {
    await ensureReadModelSearchIndex(dsn);
    await sql.unsafe(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${SEARCH_INDEX_NAME}'::regclass`,
    );
    expect((await indexState())?.valid).toBe(false);

    expect(await ensureReadModelSearchIndex(dsn)).toBe("rebuilt");
    expect((await indexState())?.valid).toBe(true);
  });

  it("does nothing while another process holds the build", async () => {
    await sql.unsafe(`DROP INDEX IF EXISTS ${SEARCH_INDEX_NAME}`);
    const other = postgres(dsn, { max: 1, prepare: false });
    try {
      await other`SELECT pg_advisory_lock(7290519146308441017::bigint)`;
      expect(await ensureReadModelSearchIndex(dsn)).toBe("busy");
      expect(await indexState()).toBeNull();
      await other`SELECT pg_advisory_unlock(7290519146308441017::bigint)`;
    } finally {
      await other.end({ timeout: 5 });
    }
    expect(await ensureReadModelSearchIndex(dsn)).toBe("built");
  });
});
