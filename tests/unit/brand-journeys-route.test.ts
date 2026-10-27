import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** The route's contract: closed body with `count`/`factCount`, 503 on a partial copy, 502 when
 *  offers cannot be named, 500 before the first byte, a destroyed socket after it. */
describe("GET /internal/brands/:brandId/timeline-journeys", () => {
  beforeEach(() => {
    vi.resetModules();
    held.clear();
    moved = false;
  });

  /** The cache, faked: a Map, every held answer valid until `moved` is set. */
  const held = new Map<string, string>();
  let moved = false;

  async function appWith(opts: { gen?: () => AsyncGenerator<unknown[]>; caughtUp?: boolean; offersFail?: boolean }) {
    vi.doMock("../../src/lib/brand-journeys.js", () => ({
      streamBrandJourneys: opts.gen ?? (async function* () {}),
    }));
    vi.doMock("../../src/lib/brand-journeys-cache.js", () => ({
      journeysCacheKey: (o: string, b: string) => `${o}|${b}`,
      journeysSnapshotXmin: async () => "1",
      cachedJourneys: async (key: string) => (moved ? null : held.get(key) ?? null),
      rememberJourneys: (key: string, _o: string, _x: string, body: string) => void held.set(key, body),
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

  it("answers an identical read from the held bytes while nothing moved, and reads again once something did", async () => {
    let reads = 0;
    const gen = async function* () {
      reads += 1;
      yield [{ leadId: `l${reads}`, facts: [{ id: "f1" }], acts: [] }];
    };
    const first = await get(await appWith({ gen }));
    const second = await get(await appWith({ gen }));
    expect(reads).toBe(1);
    expect(second.status).toBe(200);
    expect(second.headers["content-type"]).toBe(first.headers["content-type"]);
    expect(second.text).toBe(first.text);
    moved = true;
    const third = await get(await appWith({ gen }));
    expect(reads).toBe(2);
    expect(third.body.journeys[0].leadId).toBe("l2");
  });

  it("never holds a body that broke mid-stream", async () => {
    const app = await appWith({
      gen: async function* () {
        yield [{ leadId: "l1", facts: [], acts: [] }];
        throw new Error("db down");
      },
    });
    await expect(get(app)).rejects.toThrow();
    expect(held.size).toBe(0);
  });
});
