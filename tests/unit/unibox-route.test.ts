import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// UNIBOX-SIX-TAGS-1017: the routes only parse and refuse; the SQL is proven in tests/integration/unibox-model-sql.test.ts.
vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: { execute: vi.fn() } }));
vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));
const readUniboxPage = vi.fn();
const readUniboxLead = vi.fn();
class UniboxCursorError extends Error {}
vi.mock("../../src/lib/unibox-model.js", () => ({
  loadLifecycleCatalogue: async () => ({ ladder: [{ key: "engaged", rank: 3, label: "Engaged" }], ranks: new Map() }),
  readUniboxPage: (...a: unknown[]) => readUniboxPage(...a),
  readUniboxLead: (...a: unknown[]) => readUniboxLead(...a),
  UniboxCursorError,
}));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const HUMAN = "11111111-2222-4333-8444-555555555555";

let app: express.Express;
beforeAll(async () => {
  const { default: route } = await import("../../src/routes/unibox.js");
  app = express();
  app.use(route);
});
beforeEach(() => {
  readUniboxPage.mockReset();
  readUniboxLead.mockReset();
});
const get = (path: string) => request(app).get(path).set("x-api-key", "test-api-key").set("x-org-id", ORG);

describe("GET /orgs/leads/unibox", () => {
  it("passes the parsed filters and bounds; answers the ladder beside the page", async () => {
    readUniboxPage.mockResolvedValue({ rows: [], total: 0, nextCursor: null, builtAt: null });
    const res = await get(`/orgs/leads/unibox?brandId=${BRAND}&type=prospect,customer&lifecycle=engaged,none&fit=fit&limit=20`);
    expect(res.status).toBe(200);
    expect(res.body.lifecycleLadder).toEqual([{ key: "engaged", rank: 3, label: "Engaged" }]);
    expect(readUniboxPage).toHaveBeenCalledWith(
      { orgId: ORG, brandId: BRAND },
      expect.objectContaining({ types: ["prospect", "customer"], lifecycle: ["engaged", "none"], fit: ["fit"] }),
      { limit: 20, cursor: null },
    );
  });

  it.each([
    ["no brandId", "/orgs/leads/unibox"],
    ["unknown type", `/orgs/leads/unibox?brandId=${BRAND}&type=friend`],
    ["unknown lifecycle key", `/orgs/leads/unibox?brandId=${BRAND}&lifecycle=hot`],
    ["empty filter", `/orgs/leads/unibox?brandId=${BRAND}&interest=`],
    ["limit 0", `/orgs/leads/unibox?brandId=${BRAND}&limit=0`],
    ["limit too big", `/orgs/leads/unibox?brandId=${BRAND}&limit=500`],
  ])("%s = 400, nothing read", async (_n, path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    expect(readUniboxPage).not.toHaveBeenCalled();
  });

  it("a foreign cursor = 400; a read failure = 500 (never an empty page)", async () => {
    readUniboxPage.mockRejectedValueOnce(new UniboxCursorError("cursor is not one this endpoint issued"));
    expect((await get(`/orgs/leads/unibox?brandId=${BRAND}&cursor=zzz`)).status).toBe(400);
    readUniboxPage.mockRejectedValueOnce(new Error("db down"));
    expect((await get(`/orgs/leads/unibox?brandId=${BRAND}`)).status).toBe(500);
  });
});

describe("GET /orgs/leads/unibox-lead", () => {
  it("answers the card; a person who is no lead of the brand = 404", async () => {
    readUniboxLead.mockResolvedValueOnce({ lead: { humanId: HUMAN }, campaigns: [] });
    const ok = await get(`/orgs/leads/unibox-lead?brandId=${BRAND}&humanId=${HUMAN}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ brandId: BRAND, lead: { humanId: HUMAN }, campaigns: [] });
    readUniboxLead.mockResolvedValueOnce(null);
    expect((await get(`/orgs/leads/unibox-lead?brandId=${BRAND}&humanId=${HUMAN}`)).status).toBe(404);
    expect((await get(`/orgs/leads/unibox-lead?brandId=${BRAND}&humanId=nope`)).status).toBe(400);
  });
});
