import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** The route's contract: closed body with `count`/`factCount`, 503 on a partial copy, 502 when
 *  offers cannot be named, 500 before the first byte, a destroyed socket after it. */
describe("GET /internal/brands/:brandId/timeline-journeys", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function appWith(opts: { gen?: () => AsyncGenerator<unknown[]>; caughtUp?: boolean; offersFail?: boolean }) {
    vi.doMock("../../src/lib/brand-journeys.js", () => ({
      streamBrandJourneys: opts.gen ?? (async function* () {}),
    }));
    vi.doMock("../../src/lib/outreach-fact-feed.js", () => ({
      loadOutreachFeedState: async () => ({ cursor: "1", caughtUp: opts.caughtUp ?? true }),
    }));
    vi.doMock("../../src/lib/campaign-leg-client.js", () => ({
      fetchOrgCampaignOffers: async () => {
        if (opts.offersFail) throw new Error("campaign-service down");
        return new Map();
      },
    }));
    const routes = (await import("../../src/routes/brand-journeys.js")).default;
    const app = express();
    app.use(routes);
    return app;
  }

  const get = (app: express.Express) =>
    request(app).get("/internal/brands/b1/timeline-journeys").set("x-api-key", "test-api-key").set("x-org-id", "o1");

  it("streams every chunk and closes the body with the counts", async () => {
    const app = await appWith({
      gen: async function* () {
        yield [{ leadId: "l1", facts: [{ id: "f1" }, { id: "f2" }], acts: [] }];
        yield [{ leadId: "l2", facts: [], acts: [] }];
      },
    });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body.brandId).toBe("b1");
    expect(res.body.count).toBe(2);
    expect(res.body.factCount).toBe(2);
    expect(res.body.journeys).toHaveLength(2);
  });

  it("an empty brand is a closed empty body", async () => {
    const res = await get(await appWith({}));
    expect(res.body).toEqual({ brandId: "b1", journeys: [], count: 0, factCount: 0 });
  });

  it("refuses while the outreach copy has not caught up", async () => {
    const res = await get(await appWith({ caughtUp: false }));
    expect(res.status).toBe(503);
  });

  it("campaign-service down is a 502, never a partial answer", async () => {
    const res = await get(await appWith({ offersFail: true }));
    expect(res.status).toBe(502);
  });

  it("a failure before the first row is a 500", async () => {
    const app = await appWith({
      gen: async function* () {
        throw new Error("db down");
      },
    });
    expect((await get(app)).status).toBe(500);
  });

  it("a failure mid-stream destroys the socket", async () => {
    const app = await appWith({
      gen: async function* () {
        yield [{ leadId: "l1", facts: [], acts: [] }];
        throw new Error("db down");
      },
    });
    await expect(get(app)).rejects.toThrow();
  });
});
