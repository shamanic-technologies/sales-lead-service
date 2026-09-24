import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
}));

const dialect = new PgDialect();
function compile(call: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(call as SQL);
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/won-leads.js");
  const app = express();
  app.use(route);
  return app;
}

const call = (app: express.Express, path: string, org: string | null = "org-1") => {
  const r = request(app).get(path).set("x-api-key", "test-api-key");
  return org ? r.set("x-org-id", org) : r;
};

describe("GET /orgs/brands/:brandId/won-leads", () => {
  let app: express.Express;
  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  it("requires the api key and the org", async () => {
    expect((await request(app).get("/orgs/brands/b1/won-leads")).status).toBe(401);
    expect((await call(app, "/orgs/brands/b1/won-leads", null)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("scopes the read to the org AND the brand, on live attributed sales only", async () => {
    await call(app, "/orgs/brands/b1/won-leads");
    const q = compile(execute.mock.calls[0][0]);
    expect(q.params).toContain("org-1");
    expect(q.params).toContain("b1");
    expect(q.params).toContainEqual(["sale", "purchase"]);
    expect(q.sql).toContain("attribution_status = 'attributed'");
    expect(q.sql).toContain("withdrawn_at IS NULL");
    expect(q.sql).not.toContain("EXISTS");
  });

  it("returns the distinct union of every won lead's addresses", async () => {
    execute.mockResolvedValue([
      { lead_id: "l1", emails: ["a@x.com", "b@x.com"], won_at: "2026-05-12 16:03:36.845+00", sources: ["manual"] },
      { lead_id: "l2", emails: ["a@x.com"], won_at: null, sources: ["crm"] },
      { lead_id: "l3", emails: null, won_at: null, sources: ["tracker"] },
    ]);
    const res = await call(app, "/orgs/brands/b1/won-leads");
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual(["a@x.com", "b@x.com"]);
    expect(res.body.wonLeads).toEqual([
      { leadId: "l1", emails: ["a@x.com", "b@x.com"], wonAt: "2026-05-12T16:03:36.845Z", sources: ["manual"] },
      { leadId: "l2", emails: ["a@x.com"], wonAt: null, sources: ["crm"] },
      { leadId: "l3", emails: [], wonAt: null, sources: ["tracker"] },
    ]);
  });

  it("narrows the SAME query to one normalized address", async () => {
    execute.mockResolvedValue([{ lead_id: "l1", emails: ["a@x.com"], won_at: null, sources: ["manual"] }]);
    const res = await call(app, "/orgs/brands/b1/won-leads?email=%20A@X.com%20");
    const q = compile(execute.mock.calls[0][0]);
    expect(q.sql).toContain("EXISTS");
    expect(q.params).toContain("a@x.com");
    expect(res.body.emails).toEqual(["a@x.com"]);
  });

  it("answers an unknown address with an empty set", async () => {
    const res = await call(app, "/orgs/brands/b1/won-leads?email=nobody@x.com");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ brandId: "b1", emails: [], wonLeads: [] });
  });

  it("refuses an empty email", async () => {
    expect((await call(app, "/orgs/brands/b1/won-leads?email=%20")).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails loud — a 500, never an empty set — when the read fails", async () => {
    execute.mockRejectedValue(new Error("db down"));
    const res = await call(app, "/orgs/brands/b1/won-leads");
    expect(res.status).toBe(500);
    expect(res.body.emails).toBeUndefined();
  });
});
