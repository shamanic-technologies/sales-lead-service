import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** PUT /orgs/leads/:id/followup-date refuses an unclear statement before touching anything, and names each refusal. */
describe("PUT /orgs/leads/:id/followup-date", () => {
  const stated: unknown[] = [];
  beforeEach(() => {
    vi.resetModules();
    stated.length = 0;
  });

  async function appWith() {
    vi.doMock("../../src/db/index.js", () => ({
      db: { execute: async () => [{ lead_id: "11111111-1111-4111-8111-111111111111", brand_ids: ["b1"] }] },
    }));
    vi.doMock("../../src/lib/lead-followup-date.js", async (orig) => ({
      ...(await orig<typeof import("../../src/lib/lead-followup-date.js")>()),
      stateLeadFollowupDate: async (input: unknown) => {
        stated.push(input);
        return { row: {}, replayed: false };
      },
      dueVerdict: async () => ({ owed: true, kind: "owed", retryAfter: null, reason: null, reasons: [], relationshipTags: [] }),
      loadFollowupDate: async () => ({ nextFollowupAt: "2026-10-18T09:00:00.000Z", basis: "stated" }),
      loadQueued: async () => ({ any: false, emailSequence: false, followups: [], inDueStock: false }),
    }));
    const routes = (await import("../../src/routes/lead-followup-date.js")).default;
    const app = express();
    app.use(express.json());
    app.use(routes);
    return app;
  }

  const put = (app: express.Express, body: unknown) =>
    request(app)
      .put("/orgs/leads/22222222-2222-4222-8222-222222222222/followup-date")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "o1")
      .set("x-campaign-id", "c1")
      .set("x-run-id", "r1")
      .send(body as object);

  it("refuses nothing stated, a date without a reason, and a stop beside a date", async () => {
    const app = await appWith();
    expect((await put(app, {})).body.error).toBe("nothing_stated");
    expect((await put(app, { nextFollowupAt: "2026-10-18T09:00:00Z" })).body.error).toBe("reason_required");
    expect((await put(app, { stop: { reason: "stop" }, nextFollowupAt: "2026-10-18T09:00:00Z", reason: "x" })).body.error).toBe("stop_excludes_date");
    expect((await put(app, { nextFollowupAt: "tomorrow", reason: "x" })).status).toBe(400);
    expect(stated).toHaveLength(0);
  });

  it("states a date with the writer's campaign and run, and answers the date, queue and verdict", async () => {
    const app = await appWith();
    const res = await put(app, { nextFollowupAt: "2026-10-18T09:00:00Z", reason: "He waits for a price", sent: { channel: "whatsapp" } });
    expect(res.status).toBe(200);
    expect(stated[0]).toMatchObject({
      brandId: "b1",
      campaignId: "c1",
      runId: "r1",
      statement: { kind: "date", nextFollowupAt: "2026-10-18T09:00:00Z", reason: "He waits for a price", sent: { channel: "whatsapp" } },
    });
    expect(res.body).toMatchObject({ brandId: "b1", followupDate: { basis: "stated" }, queued: { any: false }, owed: { owed: true }, replayed: false });
  });
});
