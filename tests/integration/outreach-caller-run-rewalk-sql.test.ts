/**
 * MODEL-TAG-EVERY-AI-MESSAGE-1126: one walk of the outreach feed copies instantly-service's `callerRunId` onto facts
 * copied before it served it, against a REAL database. Writes only `raw.callerRunId`, never over a stated one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { sql } = await import("../../src/db/index.js");
const { rewalkCallerRuns, CALLER_RUN_REWALK_FEED } = await import("../../src/lib/outreach-fact-feed.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("caller run re-walk of the outreach copy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fills callerRunId on old copies once, keeps a stated one, then never runs again", async () => {
    await sql`DELETE FROM crm_feed_cursors WHERE feed = ${CALLER_RUN_REWALK_FEED}`;
    const base = BigInt(Date.now()) * 1000n + 777_000n;
    const s1 = (base + 1n).toString();
    const s2 = (base + 2n).toString();
    const s3 = (base + 3n).toString();
    const raw = (seq: string, extra: Record<string, unknown> = {}) => ({ seq, type: "reply_sent", replySent: { sentBy: "automation" }, ...extra });
    for (const [seq, r] of [
      [s1, raw(s1)],
      [s2, raw(s2, { callerRunId: "run-kept" })],
      [s3, raw(s3)],
    ] as const) {
      await sql`
        INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, campaign_id, brand_ids, raw)
        VALUES (${seq}::bigint, ${`rsent:${seq}`}, 'reply_sent', now(), 'x@example.test', 'org-x', 'c', ARRAY[]::text[], ${JSON.stringify(r)}::jsonb)
      `;
    }
    const pages = [
      { facts: [raw(s1, { callerRunId: "run-1" }), raw(s2, { callerRunId: "run-other" })], nextCursor: s2, hasMore: true },
      { facts: [raw(s3, { callerRunId: null })], nextCursor: s3, hasMore: false },
    ];
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        asked.push(url);
        const page = pages[asked.length - 1];
        return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    expect(await rewalkCallerRuns(10)).toEqual({ pages: 2, updated: 1, done: true });
    const rows = (await sql`
      SELECT seq::text AS seq, raw->>'callerRunId' AS run FROM outreach_facts WHERE seq IN (${s1}::bigint, ${s2}::bigint, ${s3}::bigint) ORDER BY seq
    `) as unknown as Array<{ seq: string; run: string | null }>;
    expect(rows.map((r) => r.run)).toEqual(["run-1", "run-kept", null]);
    expect(asked[0]).not.toContain("since=");
    expect(asked[1]).toContain(`since=${s2}`);

    // Finished: never asks the feed again.
    expect(await rewalkCallerRuns(10)).toEqual({ pages: 0, updated: 0, done: true });
    expect(asked).toHaveLength(2);
    await sql`DELETE FROM outreach_facts WHERE seq IN (${s1}::bigint, ${s2}::bigint, ${s3}::bigint)`;
  });
});
