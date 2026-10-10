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

const call = (app: express.Express, path: string, org: string | null = "org-1") => {
  const r = request(app).get(path).set("x-api-key", "test-api-key");
  return org ? r.set("x-org-id", org) : r;
};

describe("GET /orgs/brands/:brandId/never-cold-contact", () => {
  let app: express.Express;
  beforeAll(async () => {
    const { default: route } = await import("../../src/routes/never-cold-contact.js");
    app = express();
    app.use(route);
  }, 30_000);
  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  it("requires the api key and the org", async () => {
    expect((await request(app).get("/orgs/brands/b1/never-cold-contact")).status).toBe(401);
    expect((await call(app, "/orgs/brands/b1/never-cold-contact", null)).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reads live attributed meetings AND sales of the org's brand", async () => {
    await call(app, "/orgs/brands/b1/never-cold-contact");
    const q = compile(execute.mock.calls[0][0]);
    expect(q.params).toContain("org-1");
    expect(q.params).toContain("b1");
    expect(q.params).toContainEqual(["sale", "purchase", "meeting_booked", "meeting_attended"]);
    expect(q.sql).toContain("attribution_status = 'attributed'");
    expect(q.sql).toContain("withdrawn_at IS NULL");
  });

  it("returns the union of addresses and folds the legacy sale spelling", async () => {
    execute.mockResolvedValue([
      { lead_id: "l1", emails: ["a@x.com"], first_at: "2026-10-07 16:04:20+00", steps: ["meeting_booked"], sources: ["crm"] },
      { lead_id: "l2", emails: ["a@x.com", "b@x.com"], first_at: null, steps: ["purchase", "sale"], sources: ["manual"] },
      { lead_id: "l3", emails: null, first_at: null, steps: ["meeting_attended"], sources: ["tracker"] },
    ]);
    const res = await call(app, "/orgs/brands/b1/never-cold-contact");
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual(["a@x.com", "b@x.com"]);
    expect(res.body.leads).toEqual([
      { leadId: "l1", emails: ["a@x.com"], firstAt: "2026-10-07T16:04:20.000Z", steps: ["meeting_booked"], sources: ["crm"] },
      { leadId: "l2", emails: ["a@x.com", "b@x.com"], firstAt: null, steps: ["sale"], sources: ["manual"] },
      { leadId: "l3", emails: [], firstAt: null, steps: ["meeting_attended"], sources: ["tracker"] },
    ]);
  });

  it("narrows the SAME query to one normalized address", async () => {
    execute.mockResolvedValue([{ lead_id: "l1", emails: ["a@x.com"], first_at: null, steps: ["meeting_booked"], sources: ["crm"] }]);
    const res = await call(app, "/orgs/brands/b1/never-cold-contact?email=%20A@X.com%20");
    const q = compile(execute.mock.calls[0][0]);
    expect(q.sql).toContain("EXISTS");
    expect(q.params).toContain("a@x.com");
    expect(res.body.emails).toEqual(["a@x.com"]);
  });

  it("refuses an empty email", async () => {
    expect((await call(app, "/orgs/brands/b1/never-cold-contact?email=%20")).status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails loud — a 500, never an empty set — when the read fails", async () => {
    execute.mockRejectedValue(new Error("db down"));
    const res = await call(app, "/orgs/brands/b1/never-cold-contact");
    expect(res.status).toBe(500);
    expect(res.body.emails).toBeUndefined();
  });
});
