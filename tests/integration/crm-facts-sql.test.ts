/**
 * The fact-feed copy against a REAL database: a page and its cursor land together, a replayed page
 * copies nothing twice, NULL dates stay NULL, and a page with an unreadable fact writes nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { ingestFactsPage, loadFeedCursor } = await import("../../src/lib/crm-fact-feed.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("crm fact feed bronze against a real database", () => {
  const org = randomUUID();
  const feed = `itest-${randomUUID()}`;
  const base = Math.floor(Math.random() * 1e12) * 10;

  function fact(i: number, over: Record<string, unknown> = {}) {
    return {
      factId: randomUUID(),
      seq: String(base + i),
      orgId: org,
      brandId: "brand-itest",
      personKey: "a@example.com",
      sourceContactId: "ghl-1",
      crmContactId: "0b6c8d0e-1111-4222-8333-944455556666",
      fullName: "Ann Example",
      emails: ["a@example.com"],
      phones: ["+33600000000"],
      type: "sale",
      occurredAt: "2026-10-01T10:00:00.123Z",
      dateBasis: "changed_at",
      source: "gohighlevel",
      sourceRef: `opp-${i}`,
      payload: { amountMinor: 120000, currency: "USD", via: "status" },
      ...over,
    };
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM crm_facts WHERE org_id = ${org}`);
    await db.execute(sql`DELETE FROM crm_feed_cursors WHERE feed = ${feed}`);
  });

  it("copies a page verbatim and moves the cursor with it; a replay copies nothing", async () => {
    const page = { facts: [fact(1), fact(2, { occurredAt: null, sourceContactId: null })], nextCursor: "c2", hasMore: false };
    expect(await ingestFactsPage(page, feed)).toBe(2);
    expect(await loadFeedCursor(feed)).toBe("c2");
    expect(await ingestFactsPage(page, feed)).toBe(0);

    const rows = (await db.execute(sql`
      SELECT seq::text AS seq, occurred_at, source_contact_id, crm_contact_id, emails, phones, payload, raw
      FROM crm_facts WHERE org_id = ${org} ORDER BY seq`)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(String(base + 1));
    expect(new Date(rows[0].occurred_at as string).toISOString()).toBe("2026-10-01T10:00:00.123Z");
    expect(rows[0].emails).toEqual(["a@example.com"]);
    expect(rows[0].crm_contact_id).toBe("0b6c8d0e-1111-4222-8333-944455556666");
    expect(rows[0].payload).toEqual({ amountMinor: 120000, currency: "USD", via: "status" });
    expect((rows[0].raw as Record<string, unknown>).sourceRef).toBe("opp-1");
    expect(rows[1].occurred_at).toBeNull();
    expect(rows[1].source_contact_id).toBeNull();
  });

  it("writes nothing and keeps the cursor when the page holds an unreadable fact", async () => {
    const before = await loadFeedCursor(feed);
    await expect(
      ingestFactsPage({ facts: [fact(3), { factId: "broken" }], nextCursor: "c3", hasMore: false }, feed),
    ).rejects.toThrow();
    expect(await loadFeedCursor(feed)).toBe(before);
    const n = (await db.execute(sql`SELECT count(*)::int AS n FROM crm_facts WHERE org_id = ${org}`)) as unknown as Array<{ n: number }>;
    expect(n[0].n).toBe(2);
  });
});
