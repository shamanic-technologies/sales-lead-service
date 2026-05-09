import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const dbExecute = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...args),
  },
  sql: {},
}));

describe("GET /health", () => {
  beforeEach(() => {
    dbExecute.mockReset();
    vi.resetModules();
  });

  it("returns 200 when DB ping succeeds", async () => {
    dbExecute.mockResolvedValueOnce([{ "?column?": 1 }]);

    const { default: healthRoutes } = await import("../../src/routes/health.js");
    const app = express();
    app.use(healthRoutes);

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "lead-service" });
    expect(dbExecute).toHaveBeenCalledOnce();
  });

  it("returns 503 when DB ping rejects", async () => {
    dbExecute.mockRejectedValueOnce(new Error("connection refused"));

    const { default: healthRoutes } = await import("../../src/routes/health.js");
    const app = express();
    app.use(healthRoutes);

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable", service: "lead-service" });
  });
});
