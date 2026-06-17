import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    execute: (...args: unknown[]) => execute(...args),
  },
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const dialect = new PgDialect();
/** Compile the captured drizzle SQL object into { sql, params } for assertions. */
function compile(call: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(call as SQL);
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/feature-memberships.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("GET /internal/feature-memberships", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    execute.mockReset().mockResolvedValue([]);
  });

  it("rejects missing x-api-key with 401", async () => {
    const res = await request(app).get("/internal/feature-memberships?featureSlugs=sales-cold-email-outreach");
    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns distinct memberships mapped to {orgId, brandId, workflowSlug}", async () => {
    execute.mockResolvedValueOnce([
      { org_id: "org-1", brand_id: "brand-1", workflow_slug: "sales-cold-email-outreach-lithium" },
      { org_id: "org-1", brand_id: "brand-2", workflow_slug: "sales-cold-email-outreach-bronze-2" },
    ]);

    const res = await request(app)
      .get("/internal/feature-memberships?featureSlugs=sales-cold-email-outreach")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      memberships: [
        { orgId: "org-1", brandId: "brand-1", workflowSlug: "sales-cold-email-outreach-lithium" },
        { orgId: "org-1", brandId: "brand-2", workflowSlug: "sales-cold-email-outreach-bronze-2" },
      ],
    });

    expect(execute).toHaveBeenCalledOnce();
    const { sql, params } = compile(execute.mock.calls[0][0]);
    const lower = sql.toLowerCase();
    expect(lower).toContain("feature_slug in");
    expect(lower).toContain("workflow_slug is not null");
    expect(lower).toContain("unnest(brand_ids)");
    expect(lower).toContain("distinct");
    expect(params).toEqual(["sales-cold-email-outreach"]);
  });

  it("parses comma-separated featureSlugs (trim + drop empties)", async () => {
    const res = await request(app)
      .get("/internal/feature-memberships?featureSlugs=a, b ,,c")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    const { params } = compile(execute.mock.calls[0][0]);
    expect(params).toEqual(["a", "b", "c"]);
  });

  it("returns empty memberships and skips the query when featureSlugs is missing", async () => {
    const res = await request(app)
      .get("/internal/feature-memberships")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ memberships: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns empty memberships and skips the query when featureSlugs has only empties", async () => {
    const res = await request(app)
      .get("/internal/feature-memberships?featureSlugs=,, ,")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ memberships: [] });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns empty memberships when the query matches no rows", async () => {
    execute.mockResolvedValueOnce([]);
    const res = await request(app)
      .get("/internal/feature-memberships?featureSlugs=nonexistent-feature")
      .set("x-api-key", "test-api-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ memberships: [] });
    expect(execute).toHaveBeenCalledOnce();
  });
});
