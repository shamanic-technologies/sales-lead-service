/**
 * A slow brand-wide read served from its stored answer (MON-PAGE-SPEED-1111), against a real database: a valid answer
 * is served without computing, an old one is served and rebuilt in the background, a write's invalidation makes the
 * next read wait for a build that started after it, and a build older than an invalidation is never stored.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { readThroughSnapshot, invalidateSnapshots, invalidateAndRebuild, settleReadSnapshotBuilds } = await import("../../src/lib/read-snapshots.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("read snapshots", () => {
  const org = randomUUID();
  afterAll(async () => {
    await db.execute(sql`DELETE FROM read_snapshots WHERE org_id = ${org}`);
  });

  function counter(prefix: string) {
    const c = { n: 0, compute: async () => `{"v":"${prefix}${++c.n}"}` };
    return c;
  }
  const read = (brandId: string, compute: () => Promise<string>, revalidateAfterMs = 60_000) =>
    readThroughSnapshot({ kind: "awaiting_reply", orgId: org, brandId, revalidateAfterMs, compute });

  it("computes once, then serves the stored body without computing", async () => {
    const brand = randomUUID();
    const c = counter("a");
    expect(await read(brand, c.compute)).toBe('{"v":"a1"}');
    expect(await read(brand, c.compute)).toBe('{"v":"a1"}');
    await settleReadSnapshotBuilds();
    expect(c.n).toBe(1);
  });

  it("an old answer is served at once and rebuilt in the background for the next read", async () => {
    const brand = randomUUID();
    const c = counter("b");
    await read(brand, c.compute);
    await new Promise((r) => setTimeout(r, 5));
    expect(await read(brand, c.compute, 1)).toBe('{"v":"b1"}');
    await settleReadSnapshotBuilds();
    expect(c.n).toBe(2);
    expect(await read(brand, c.compute)).toBe('{"v":"b2"}');
  });

  it("after an invalidation the next read computes (never the answer before the write)", async () => {
    const brand = randomUUID();
    const c = counter("c");
    await read(brand, c.compute);
    await invalidateSnapshots("awaiting_reply", org, brand);
    expect(await read(brand, c.compute)).toBe('{"v":"c2"}');
    expect(await read(brand, c.compute)).toBe('{"v":"c2"}');
  });

  it("an org-wide invalidation reaches every brand of the org, not another kind", async () => {
    const [b1, b2] = [randomUUID(), randomUUID()];
    const c = counter("d");
    await read(b1, c.compute);
    await read(b2, c.compute);
    const review = counter("r");
    await readThroughSnapshot({ kind: "relationship_review", orgId: org, brandId: b1, revalidateAfterMs: 60_000, compute: review.compute });
    await invalidateSnapshots("awaiting_reply", org, null);
    expect(await read(b1, c.compute)).toBe('{"v":"d3"}');
    expect(await read(b2, c.compute)).toBe('{"v":"d4"}');
    expect(await readThroughSnapshot({ kind: "relationship_review", orgId: org, brandId: b1, revalidateAfterMs: 60_000, compute: review.compute })).toBe('{"v":"r1"}');
  });

  it("the read after a write joins the rebuild the write started (one computation)", async () => {
    const brand = randomUUID();
    const c = counter("e");
    await read(brand, c.compute);
    await invalidateAndRebuild({ kind: "awaiting_reply", orgId: org, brandId: brand, compute: c.compute });
    expect(await read(brand, c.compute)).toBe('{"v":"e2"}');
    await settleReadSnapshotBuilds();
    expect(c.n).toBe(2);
  });

  it("a build that started before an invalidation is never stored over it", async () => {
    const brand = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => {
      await gate;
      return '{"v":"stale"}';
    };
    const first = read(brand, slow);
    await new Promise((r) => setTimeout(r, 5));
    await invalidateSnapshots("awaiting_reply", org, brand);
    release();
    expect(await first).toBe('{"v":"stale"}');
    const c = counter("f");
    expect(await read(brand, c.compute)).toBe('{"v":"f1"}');
  });
});
