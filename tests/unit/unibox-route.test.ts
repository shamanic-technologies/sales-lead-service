import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// UNIBOX-SIX-TAGS-1017: the routes only parse and refuse; the SQL is proven in tests/integration/unibox-model-sql.test.ts.
vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: { execute: vi.fn() } }));
vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));
const readUniboxPage = vi.fn();
const readUniboxLead = vi.fn();
const readUniboxLifecycleCounts = vi.fn();
const resolveUniboxScope = vi.fn();
class UniboxCursorError extends Error {}
class UniboxScopeUnavailableError extends Error {}
vi.mock("../../src/lib/unibox-scope.js", () => ({
  resolveUniboxScope: (...a: unknown[]) => resolveUniboxScope(...a),
  UniboxScopeUnavailableError,
}));
vi.mock("../../src/lib/unibox-model.js", () => ({
  loadLifecycleCatalogue: async () => ({ ladder: [{ key: "engaged", rank: 3, label: "Engaged" }], ranks: new Map() }),
  readUniboxPage: (...a: unknown[]) => readUniboxPage(...a),
  readUniboxLead: (...a: unknown[]) => readUniboxLead(...a),
  readUniboxLifecycleCounts: (...a: unknown[]) => readUniboxLifecycleCounts(...a),
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
  readUniboxLifecycleCounts.mockReset();
  resolveUniboxScope.mockReset();
  resolveUniboxScope.mockImplementation(async (_ctx: unknown, s: { offerId?: string; campaignId?: string }) =>
    s.offerId || s.campaignId ? ["camp-a", "camp-b"] : undefined,
  );
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

  it("an unscoped answer is unchanged (no scope keys); offerId/campaignId narrow to the resolved campaigns", async () => {
    readUniboxPage.mockResolvedValue({ rows: [], total: 0, nextCursor: null, builtAt: null });
    const plain = await get(`/orgs/leads/unibox?brandId=${BRAND}`);
    expect(Object.keys(plain.body)).toEqual(["brandId", "lifecycleLadder", "rows", "total", "nextCursor", "builtAt"]);
    expect(readUniboxPage.mock.calls[0][1]).not.toHaveProperty("campaignIds");
    const scoped = await get(`/orgs/leads/unibox?brandId=${BRAND}&offerId=offer-1&campaignId=sfc-1&lifecycle=engaged`);
    expect(scoped.status).toBe(200);
    expect(scoped.body).toMatchObject({ brandId: BRAND, offerId: "offer-1", campaignId: "sfc-1" });
    expect(resolveUniboxScope).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: ORG, brandId: BRAND }), { offerId: "offer-1", campaignId: "sfc-1" });
    expect(readUniboxPage.mock.calls[1][1]).toMatchObject({ lifecycle: ["engaged"], campaignIds: ["camp-a", "camp-b"] });
  });

  it("campaign-service unreadable = 502, never the whole brand; a blank offerId = 400", async () => {
    resolveUniboxScope.mockRejectedValueOnce(new UniboxScopeUnavailableError("campaign-service down"));
    const res = await get(`/orgs/leads/unibox?brandId=${BRAND}&offerId=offer-1`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("scope_unavailable");
    expect((await get(`/orgs/leads/unibox?brandId=${BRAND}&offerId=`)).status).toBe(400);
    expect(readUniboxPage).not.toHaveBeenCalled();
  });

  it("a foreign cursor = 400; a read failure = 500 (never an empty page)", async () => {
    readUniboxPage.mockRejectedValueOnce(new UniboxCursorError("cursor is not one this endpoint issued"));
    expect((await get(`/orgs/leads/unibox?brandId=${BRAND}&cursor=zzz`)).status).toBe(400);
    readUniboxPage.mockRejectedValueOnce(new Error("db down"));
    expect((await get(`/orgs/leads/unibox?brandId=${BRAND}`)).status).toBe(500);
  });
});

describe("GET /orgs/leads/unibox-lifecycle-counts", () => {
  it("answers the counts per rung for the scope and filters, the ladder beside them", async () => {
    readUniboxLifecycleCounts.mockResolvedValue({ total: 3, byLifecycle: { engaged: 2, none: 1 }, builtAt: null });
    const res = await get(`/orgs/leads/unibox-lifecycle-counts?brandId=${BRAND}&offerId=offer-1&interest=interested&fit=fit`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      brandId: BRAND,
      offerId: "offer-1",
      campaignId: null,
      lifecycleLadder: [{ key: "engaged", rank: 3, label: "Engaged" }],
      total: 3,
      byLifecycle: { engaged: 2, none: 1 },
      builtAt: null,
    });
    expect(readUniboxLifecycleCounts).toHaveBeenCalledWith(
      { orgId: ORG, brandId: BRAND },
      expect.objectContaining({ interest: ["interested"], fit: ["fit"], campaignIds: ["camp-a", "camp-b"] }),
    );
  });

  it("bad filter = 400, scope unreadable = 502, read failure = 500", async () => {
    expect((await get(`/orgs/leads/unibox-lifecycle-counts?brandId=${BRAND}&fit=maybe`)).status).toBe(400);
    expect((await get(`/orgs/leads/unibox-lifecycle-counts`)).status).toBe(400);
    resolveUniboxScope.mockRejectedValueOnce(new UniboxScopeUnavailableError("down"));
    expect((await get(`/orgs/leads/unibox-lifecycle-counts?brandId=${BRAND}&campaignId=c`)).status).toBe(502);
    readUniboxLifecycleCounts.mockRejectedValueOnce(new Error("db down"));
    expect((await get(`/orgs/leads/unibox-lifecycle-counts?brandId=${BRAND}`)).status).toBe(500);
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
