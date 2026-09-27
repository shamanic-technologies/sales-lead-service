import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const transferBrand = vi.fn();

vi.mock("../../src/lib/brand-transfer.js", async () => {
  class SharedBrandRowsError extends Error {
    constructor(public readonly shared: { tableName: string; count: number }[]) {
      super("brand is shared");
    }
  }
  return { transferBrand: (...a: unknown[]) => transferBrand(...a), SharedBrandRowsError };
});

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

async function buildApp() {
  const { default: route } = await import("../../src/routes/transfer-brand.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("POST /internal/transfer-brand", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    transferBrand.mockReset().mockResolvedValue([{ tableName: "leads_campaigns", count: 3 }]);
  });

  it("works WITHOUT an x-run-id — brand-service sends none", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: A, sourceOrgId: B, targetOrgId: C });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updatedTables: [{ tableName: "leads_campaigns", count: 3 }] });
    expect(transferBrand).toHaveBeenCalledWith({ sourceBrandId: A, sourceOrgId: B, targetOrgId: C });
  });

  it("forwards targetBrandId", async () => {
    await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: A, sourceOrgId: B, targetOrgId: C, targetBrandId: D });
    expect(transferBrand).toHaveBeenCalledWith({
      sourceBrandId: A,
      sourceOrgId: B,
      targetOrgId: C,
      targetBrandId: D,
    });
  });

  it("401 without the api key", async () => {
    const res = await request(app)
      .post("/internal/transfer-brand")
      .send({ sourceBrandId: A, sourceOrgId: B, targetOrgId: C });
    expect(res.status).toBe(401);
    expect(transferBrand).not.toHaveBeenCalled();
  });

  it("400 on a bad body or identical orgs", async () => {
    const bad = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: "nope", sourceOrgId: B, targetOrgId: C });
    expect(bad.status).toBe(400);
    const same = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: A, sourceOrgId: B, targetOrgId: B });
    expect(same.status).toBe(400);
    expect(transferBrand).not.toHaveBeenCalled();
  });

  it("409 when the brand shares rows with another brand", async () => {
    const { SharedBrandRowsError } = await import("../../src/lib/brand-transfer.js");
    transferBrand.mockRejectedValue(
      new SharedBrandRowsError([{ tableName: "leads_campaigns", count: 2 }]),
    );
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: A, sourceOrgId: B, targetOrgId: C });
    expect(res.status).toBe(409);
    expect(res.body.shared).toEqual([{ tableName: "leads_campaigns", count: 2 }]);
  });

  it("500 (never a hanging socket) when the transfer throws", async () => {
    transferBrand.mockRejectedValue(new Error("boom"));
    const res = await request(app)
      .post("/internal/transfer-brand")
      .set("x-api-key", "test-api-key")
      .send({ sourceBrandId: A, sourceOrgId: B, targetOrgId: C });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("nothing was moved");
  });
});
