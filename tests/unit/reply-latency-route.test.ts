import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";

/** POST /internal/reply-latency/grouped (REPLY-LATENCY-ALL-CHANNELS-1019): body contract, order, fail loud. No error middleware. */
describe("POST /internal/reply-latency/grouped", () => {
  const asked: unknown[] = [];
  beforeEach(() => {
    vi.resetModules();
    asked.length = 0;
  });

  async function appWith(fail = false) {
    vi.doMock("../../src/db/index.js", () => ({ db: { execute: async () => [] } }));
    vi.doMock("../../src/lib/reply-latency.js", () => ({
      REPLY_LATENCY_MAX_GROUPS: 100,
      REPLY_LATENCY_MAX_IDS_PER_GROUP: 500,
      loadReplyLatencyByGroups: async (groups: Array<{ key: string; campaignIds: string[] }>) => {
        asked.push(groups);
        if (fail) throw new Error("db down");
        return groups.map((g) => ({ ...g, timeToFirstPositiveReply: { sampleSize: 2, medianMs: 1000, averageMs: 1500 } }));
      },
    }));
    const mod = await import("../../src/routes/reply-latency.js");
    // Same parser order as src/app.ts: the route's own parser, then the global default one.
    const app = express();
    app.use(mod.REPLY_LATENCY_PATH, mod.replyLatencyBodyParser);
    app.use(express.json());
    app.use(mod.default);
    return app;
  }

  const post = (app: express.Express, body: unknown) =>
    request(app).post("/internal/reply-latency/grouped").set("x-api-key", "test-api-key").send(body as object);

  it("answers every group in request order with the metric", async () => {
    const app = await appWith();
    const res = await post(app, { groups: { campaign: { campaignIds: ["c1", "c2"] }, fleet: { campaignIds: ["c1", "c2", "c3"] } } });
    expect(res.status).toBe(200);
    expect(asked).toEqual([[{ key: "campaign", campaignIds: ["c1", "c2"] }, { key: "fleet", campaignIds: ["c1", "c2", "c3"] }]]);
    expect(res.body.basis).toBe("first_message_sent_to_first_positive_reply_since_inception");
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(["campaign", "fleet"]);
    expect(res.body.groups[0].timeToFirstPositiveReply).toEqual({ sampleSize: 2, medianMs: 1000, averageMs: 1500 });
  });

  it("takes two groups of 500 ids each (bigger than the default 100kb body)", async () => {
    const app = await appWith();
    const ids = Array.from({ length: 500 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const groups = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`g${i}`, { campaignIds: ids }]));
    const res = await post(app, { groups });
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(6);
  });

  it("src/app.ts mounts the route's parser BEFORE the global 100kb one", () => {
    const src = readFileSync(new URL("../../src/app.ts", import.meta.url), "utf8");
    const own = src.indexOf("app.use(REPLY_LATENCY_PATH, replyLatencyBodyParser);");
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(src.indexOf("app.use(express.json());"));
  });

  it("refuses no group, an empty group, or more than 500 ids", async () => {
    const app = await appWith();
    expect((await post(app, { groups: {} })).status).toBe(400);
    expect((await post(app, { groups: { a: { campaignIds: [] } } })).status).toBe(400);
    expect((await post(app, { groups: { a: { campaignIds: Array.from({ length: 501 }, (_, i) => `c${i}`) } } })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    expect(asked).toHaveLength(0);
  });

  it("refuses a caller without the api key", async () => {
    const app = await appWith();
    const res = await request(app).post("/internal/reply-latency/grouped").send({ groups: { a: { campaignIds: ["c1"] } } });
    expect(res.status).toBe(401);
  });

  it("fails loud on a read failure, never zeros", async () => {
    const res = await post(await appWith(true), { groups: { a: { campaignIds: ["c1"] } } });
    expect(res.status).toBe(500);
  });
});
