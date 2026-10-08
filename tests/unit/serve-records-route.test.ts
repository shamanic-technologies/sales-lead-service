import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

/** The route's stream contract: closed body with `count`, 500 before the first byte, a destroyed
 *  socket after it (a short body must never parse as a complete one). No error middleware. */
describe("GET /internal/brands/:brandId/serve-records", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function appWith(gen: () => AsyncGenerator<unknown[]>) {
    vi.doMock("../../src/lib/serve-records.js", () => ({ streamServeRecords: gen }));
    const routes = (await import("../../src/routes/serve-records.js")).default;
    const app = express();
    app.use(routes);
    return app;
  }

  const get = (app: express.Express) =>
    request(app).get("/internal/brands/b1/serve-records").set("x-api-key", "test-api-key").set("x-org-id", "o1");

  it("streams every chunk and closes the body with the row count", async () => {
    const app = await appWith(async function* () {
      yield [{ runId: "r1" }, { runId: "r2" }];
      yield [{ runId: "r3" }];
    });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ serves: [{ runId: "r1" }, { runId: "r2" }, { runId: "r3" }], count: 3 });
  });

  it("a failure before the first row is a 500", async () => {
    const app = await appWith(async function* () {
      throw new Error("db down");
    });
    const res = await get(app);
    expect(res.status).toBe(500);
  });

  it("a failure mid-stream destroys the socket instead of ending a short body", async () => {
    const app = await appWith(async function* () {
      yield [{ runId: "r1" }];
      throw new Error("db down");
    });
    await expect(get(app)).rejects.toThrow();
  });
});
