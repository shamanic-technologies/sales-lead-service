/**
 * FACTORY-RECORD-SERVE-1028: a serve's walk stored and read back against a REAL database (src/lib/serve-walk.ts),
 * replaying to the person served. Scoped to this suite's own campaign ids.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { persistServeWalk, pruneServeWalks, readServeWalks, ServeWalk, withServeWalk, walkCandidate, walkEvent } from "../../src/lib/serve-walk.js";
import { replayServeWalk } from "../../src/lib/serve-walk-rules.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("serve walks against a real database", () => {
  const campaignId = `walk-${randomUUID()}`;
  const serveRunId = randomUUID();
  const leadId = randomUUID();

  afterAll(async () => {
    await db.execute(sql`DELETE FROM serve_walks WHERE campaign_id = ${campaignId}`);
  });

  it("stores a walk with the serve, reads it by run and by campaign, and it replays to the served lead", async () => {
    const walk = new ServeWalk({ orgId: "org-w", brandId: "brand-w", campaignId, callerRunId: "caller-1", serveRunId, mode: "serve", context: { acceptedEmails: null } });
    await withServeWalk(walk, async () => {
      walkEvent("audience_answer", { audienceId: "aud-1", answer: "pending" });
      const skipped = walkCandidate("serve_next", "person:p1", randomUUID());
      skipped.check("journalist", { journalist: true }, false);
      skipped.skip();
      const served = walkCandidate("serve_next", "person:p2", leadId);
      served.check("journalist", { journalist: false }, true);
      served.serve();
    });
    await persistServeWalk(walk, { found: true, reason: null, servedLeadId: leadId, error: null });

    const [byRun] = await readServeWalks({ runId: serveRunId, limit: 5 });
    expect(byRun).toEqual(
      expect.objectContaining({ campaignId, serveRunId, callerRunId: "caller-1", mode: "serve", found: true, servedLeadId: leadId, context: { acceptedEmails: null } }),
    );
    expect(byRun.steps).toEqual(walk.steps);
    expect(replayServeWalk(byRun.steps)).toEqual({ servedRef: "person:p2", servedLeadId: leadId, mismatches: [] });

    const [byCaller] = await readServeWalks({ runId: "caller-1", limit: 5 });
    expect(byCaller.id).toBe(byRun.id);
    expect((await readServeWalks({ campaignId, limit: 5 })).map((w) => w.id)).toEqual([byRun.id]);
  });

  it("deletes walks past their retention, keeps recent ones", async () => {
    const old = new ServeWalk({ orgId: "org-w", brandId: "brand-w", campaignId, callerRunId: null, serveRunId: null, mode: "stock", context: {} });
    await persistServeWalk(old, { found: false, reason: "source_stock_empty", servedLeadId: null, error: null });
    await db.execute(sql`UPDATE serve_walks SET created_at = now() - interval '91 days' WHERE campaign_id = ${campaignId} AND mode = 'stock'`);
    await pruneServeWalks();
    const left = await readServeWalks({ campaignId, limit: 10 });
    expect(left.map((w) => w.mode)).toEqual(["serve"]);
  });
});
