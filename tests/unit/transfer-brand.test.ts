import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const findFirst = vi.fn();
const insertValues = vi.fn().mockResolvedValue(undefined);
const updateReturning = vi.fn();
const updateBare = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      idempotencyCache: {
        findFirst: (...args: unknown[]) => findFirst(...args),
      },
    },
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: (...a: unknown[]) => updateReturning(...a),
          // when no .returning() chain is invoked we still need a thenable
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        }),
      }),
    }),
  },
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const VALID_UUID_A = "11111111-1111-4111-8111-111111111111";
const VALID_UUID_B = "22222222-2222-4222-8222-222222222222";
const VALID_UUID_C = "33333333-3333-4333-8333-333333333333";

async function buildApp() {
  vi.resetModules();
  const { default: route } = await import("../../src/routes/transfer-brand.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("POST /internal/transfer-brand", () => {
  beforeEach(() => {
    findFirst.mockReset();
    insertValues.mockReset().mockResolvedValue(undefined);
    updateReturning.mockReset().mockResolvedValue([{ id: "row-1" }]);
    updateBare.mockReset().mockResolvedValue(undefined);
  });

  it("rejects missing x-api-key with 401", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-run-id", "run-1")
      .send({ sourceBrandId: VALID_UUID_A, sourceOrgId: VALID_UUID_B, targetOrgId: VALID_UUID_C });
    expect(res.status).toBe(401);
  });

  it("rejects missing x-run-id with 400", async () => {
    const app = await buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: VALID_UUID_A, sourceOrgId: VALID_UUID_B, targetOrgId: VALID_UUID_C });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "x-run-id header required" });
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it("first call applies UPDATE and writes idempotency cache", async () => {
    findFirst.mockResolvedValue(undefined);
    updateReturning.mockResolvedValueOnce([{ id: "row-1" }, { id: "row-2" }]);

    const app = await buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .set("x-run-id", "run-1")
      .send({ sourceBrandId: VALID_UUID_A, sourceOrgId: VALID_UUID_B, targetOrgId: VALID_UUID_C });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updatedTables: [{ tableName: "leads_campaigns", count: 2 }] });
    expect(updateReturning).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledOnce();
    const cached = insertValues.mock.calls[0][0] as { idempotencyKey: string; response: unknown };
    expect(cached.idempotencyKey).toBe("run-1");
    expect(cached.response).toEqual({ updatedTables: [{ tableName: "leads_campaigns", count: 2 }] });
  });

  it("retries with same x-run-id replay cached response and skip the UPDATE", async () => {
    findFirst.mockResolvedValue({
      idempotencyKey: "run-1",
      response: { updatedTables: [{ tableName: "leads_campaigns", count: 7 }] },
    });

    const app = await buildApp();
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .set("x-run-id", "run-1")
      .send({ sourceBrandId: VALID_UUID_A, sourceOrgId: VALID_UUID_B, targetOrgId: VALID_UUID_C });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updatedTables: [{ tableName: "leads_campaigns", count: 7 }] });
    expect(updateReturning).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });
});
