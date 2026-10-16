/** CATCHALL-NEVER-SOURCED-1014: a source's walk remembers empty answers per policy. Real Postgres. */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { clearEmptyAnswer, loadEmptyAnswers, recordEmptyAnswer } from "../../src/lib/source-audience-walk.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("source audience walk, against a real database", () => {
  it("records per policy, re-records in place, clears on a serve", async () => {
    const source = `itest-src-${randomUUID()}`;
    const audience = randomUUID();
    await recordEmptyAnswer({ sourceCampaignId: source, audienceId: audience, acceptedEmails: undefined, reason: "exhausted" });
    await recordEmptyAnswer({ sourceCampaignId: source, audienceId: audience, acceptedEmails: undefined, reason: "no_recent_posts" });
    expect([...(await loadEmptyAnswers(source, "valid_only")).keys()]).toEqual([audience]);
    expect((await loadEmptyAnswers(source, "valid_and_catch_all")).size).toBe(0);
    await clearEmptyAnswer({ sourceCampaignId: source, audienceId: audience, acceptedEmails: null });
    expect((await loadEmptyAnswers(source, null)).size).toBe(0);
  });

  it("migration 0098 folds walks stored under the deprecated unknown policy into valid_and_catch_all (CATCHALL-BOUNCE-1016)", async () => {
    const source = `itest-src-${randomUUID()}`;
    const [onlyLegacy, both] = [randomUUID(), randomUUID()];
    await db.execute(sql`
      INSERT INTO source_audience_walks (source_campaign_id, audience_id, accepted_emails, last_empty_at, last_empty_reason) VALUES
        (${source}, ${onlyLegacy}, 'valid_catch_all_and_unknown', '2026-10-15T00:00:00Z', 'exhausted'),
        (${source}, ${both}, 'valid_catch_all_and_unknown', '2026-10-15T00:00:00Z', 'exhausted'),
        (${source}, ${both}, 'valid_and_catch_all', '2026-10-14T00:00:00Z', 'no_recent_posts')
    `);
    const migration = readFileSync(new URL("../../drizzle/0098_walks_unknown_policy_retired.sql", import.meta.url), "utf8");
    for (let run = 0; run < 2; run++) {
      for (const stmt of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(stmt));
    }
    const got = await loadEmptyAnswers(source, "valid_and_catch_all");
    expect(got.get(onlyLegacy)).toBe(Date.parse("2026-10-15T00:00:00Z"));
    expect(got.get(both)).toBe(Date.parse("2026-10-15T00:00:00Z"));
    const left = (await db.execute(sql`SELECT 1 FROM source_audience_walks WHERE source_campaign_id = ${source} AND accepted_emails = 'valid_catch_all_and_unknown'`)) as unknown as unknown[];
    expect(left).toHaveLength(0);
    await db.execute(sql`DELETE FROM source_audience_walks WHERE source_campaign_id = ${source}`);
  });
});
