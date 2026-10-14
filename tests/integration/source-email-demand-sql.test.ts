/**
 * CATCHALL-NEVER-SOURCED-1014: a pipe's stated email policy reaches the source that finds for it. Raw SQL against a
 * real database.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { loadSourceEmailDemands, recordSourceEmailDemand, sourceRunEmailPolicy } from "../../src/lib/source-email-demand.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("source email demands, against a real database", () => {
  it("a catch-all pipe widens its source's run; its latest word wins; a valid-only source sends nothing", async () => {
    const source = `itest-src-${randomUUID()}`;
    const other = `itest-src-${randomUUID()}`;
    const outreach = `itest-out-${randomUUID()}`;

    expect(await sourceRunEmailPolicy(source, null)).toBeNull();

    await recordSourceEmailDemand({ sourceCampaignIds: [source, other], outreachCampaignId: outreach, acceptedEmails: "valid_and_catch_all" });
    expect(await loadSourceEmailDemands(source)).toEqual(["valid_and_catch_all"]);
    expect(await sourceRunEmailPolicy(source, null)).toBe("valid_and_catch_all");
    expect(await sourceRunEmailPolicy(other, null)).toBe("valid_and_catch_all");

    await recordSourceEmailDemand({ sourceCampaignIds: [source], outreachCampaignId: outreach, acceptedEmails: undefined });
    expect(await loadSourceEmailDemands(source)).toEqual(["valid_only"]);
    expect(await sourceRunEmailPolicy(source, null)).toBeNull();
    expect(await sourceRunEmailPolicy(source, "valid_only")).toBe("valid_only");
  });
});
