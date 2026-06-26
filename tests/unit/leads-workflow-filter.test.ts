import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Capture every `sql` tagged-template invocation (the full path now builds its query
// from raw postgres.js fragments, not a drizzle query builder). The workflow_slug
// filter is a conditional `sql`AND lc.workflow_slug = ${slug}`` fragment, so when it is
// applied it shows up as a captured call whose strings mention workflow_slug and whose
// values carry the slug; when absent, the conditional emits an empty `sql```` instead.
let mockSqlCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    mockSqlCalls.push({ strings, values });
    return { then: (resolve: (rows: unknown[]) => void) => Promise.resolve([]).then(resolve) };
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

// Flatten all captured sql fragments into one text blob + the union of their values.
function compileWhere(): { sql: string; params: unknown[] } {
  return {
    sql: mockSqlCalls.map((c) => c.strings.join(" ")).join(" "),
    params: mockSqlCalls.flatMap((c) => c.values),
  };
}

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";

async function buildApp() {
  const { default: route } = await import("../../src/routes/leads.js");
  const app = express();
  app.use(express.json());
  app.use(route);
  return app;
}

describe("GET /orgs/leads workflowSlug filter", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    mockSqlCalls = [];
  });

  it("rejects missing x-api-key with 401", async () => {
    const res = await request(app).get(`/orgs/leads?brandId=${BRAND}`).set("x-org-id", ORG);
    expect(res.status).toBe(401);
  });

  it("adds a workflow_slug condition when workflowSlug is provided", async () => {
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}&workflowSlug=sales-cold-email-outreach-lithium`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leads: [] });

    const { sql, params } = compileWhere();
    // The column is always SELECTed; assert the FILTER predicate + bound value.
    expect(sql.toLowerCase()).toContain("workflow_slug =");
    expect(params).toContain("sales-cold-email-outreach-lithium");
  });

  it("does NOT add a workflow_slug condition when workflowSlug is absent", async () => {
    const res = await request(app)
      .get(`/orgs/leads?brandId=${BRAND}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ leads: [] });

    const { sql, params } = compileWhere();
    // No filter predicate (the column is still SELECTed, but never compared).
    expect(sql.toLowerCase()).not.toContain("workflow_slug =");
    expect(params).not.toContain("sales-cold-email-outreach-lithium");
  });
});
