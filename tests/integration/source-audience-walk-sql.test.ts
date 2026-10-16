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

  it("migration 0100 puts back the 12 walk rows 0098 rewrote, under valid_catch_all_and_unknown (UNKNOWN-RESTORE-1016)", async () => {
    const SOURCES = ["3de6bdb2-3601-45ac-a89f-4083903a217d", "a41c4e52-7d37-4910-ac50-ff87ab66ae04"];
    const clean = () => db.execute(sql`DELETE FROM source_audience_walks WHERE source_campaign_id IN (${SOURCES[0]}, ${SOURCES[1]})`);
    await clean();
    // what 0098 left: the fold under valid_and_catch_all (one later rewritten by the walk)
    await db.execute(sql`
      INSERT INTO source_audience_walks (source_campaign_id, audience_id, accepted_emails, last_empty_at, last_empty_reason) VALUES
        (${SOURCES[0]}, '1470680d-3568-4019-b81f-52385f0a449e', 'valid_and_catch_all', '2026-10-16T10:04:06Z', 'exhausted'),
        (${SOURCES[1]}, 'a444a5ae-fb00-4fe2-ad69-c2d2257ad24c', 'valid_and_catch_all', '2026-10-15T09:31:11Z', 'exhausted')
    `);
    const migration = readFileSync(new URL("../../drizzle/0100_walks_unknown_policy_restored.sql", import.meta.url), "utf8");
    for (let run = 0; run < 2; run++) {
      for (const stmt of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(stmt));
    }
    const restored = await loadEmptyAnswers(SOURCES[0], "valid_catch_all_and_unknown");
    expect(restored.size).toBe(6);
    expect(restored.get("1470680d-3568-4019-b81f-52385f0a449e")).toBe(Date.parse("2026-10-16T03:17:30.662229Z"));
    expect((await loadEmptyAnswers(SOURCES[1], "valid_catch_all_and_unknown")).size).toBe(6);
    expect((await loadEmptyAnswers(SOURCES[0], "valid_and_catch_all")).size).toBe(0);
    expect((await loadEmptyAnswers(SOURCES[1], "valid_and_catch_all")).size).toBe(0);
    await clean();
  });
});
