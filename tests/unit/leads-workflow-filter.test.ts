import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Capture the argument passed to .where() so we can assert on the compiled SQL.
let capturedWhere: unknown = null;

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: (arg: unknown) => {
            capturedWhere = arg;
            return {
              orderBy: () => ({
                limit: () => Promise.resolve([]),
              }),
            };
          },
        }),
      }),
    }),
  },
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: vi.fn().mockResolvedValue({ results: [] }),
}));

vi.mock("../../src/lib/trace-event.js", () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const dialect = new PgDialect();
function compileWhere(): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(capturedWhere as SQL);
}

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";

async function buildApp() {
  vi.resetModules();
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("GET /orgs/leads workflowSlug filter", () => {
  beforeEach(() => {
    capturedWhere = null;
  });

  it("rejects missing x-api-key with 401", async () => {
    const app = await buildApp();
    const res = await request(app).get(`/orgs/leads?brandId=${BRAND}`).set("x-org-id", ORG);
    expect(res.status).toBe(401);
  });

  it("adds a workflow_slug condition when workflowSlug is provided", async () => {
    const app = await buildApp();
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&workflowSlug=sales-cold-email-outreach-lithium`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leads: [] });

    const { sql, params } = compileWhere();
    expect(sql.toLowerCase()).toContain("workflow_slug");
    expect(params).toContain("sales-cold-email-outreach-lithium");
  });

  it("does NOT add a workflow_slug condition when workflowSlug is absent", async () => {
    const app = await buildApp();
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leads: [] });

    const { sql, params } = compileWhere();
    expect(sql.toLowerCase()).not.toContain("workflow_slug");
    expect(params).not.toContain("sales-cold-email-outreach-lithium");
  });
});
