/** CATCHALL-NEVER-SOURCED-1014: a source's walk remembers empty answers per policy. Real Postgres. */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
});
