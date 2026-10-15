import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const readFollowupOwed = vi.fn();

vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));
vi.mock("../../src/lib/followup-owed.js", () => ({
  readFollowupOwed: (...a: unknown[]) => readFollowupOwed(...a),
}));

const auth = { "x-api-key": "test-api-key", "x-org-id": "org-1" };
let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/followups.js");
  app = express();
  app.use(express.json());
  app.use(route);
}, 30_000);

beforeEach(() => {
  readFollowupOwed.mockReset();
  readFollowupOwed.mockImplementation(async ({ query }: { query: { campaignId: string; heldCampaignIds: string[] } }) => ({
    campaignId: query.campaignId,
    heldCampaignIds: query.heldCampaignIds,
    owedNow: false,
    owedCampaignIds: [],
    nextOwedAt: null,
    held: [],
  }));
});

describe("POST /internal/followups/owed", () => {
  const url = "/internal/followups/owed";

  it("answers each campaign in order, held set defaulting to the campaign itself", async () => {
    const res = await request(app)
      .post(url)
      .set(auth)
      .send({ campaigns: [{ campaignId: "r1", heldCampaignIds: ["p1", "p2"] }, { campaignId: "r2" }] });
    expect(res.status).toBe(200);
    expect(typeof res.body.asOf).toBe("string");
    expect(res.body.answers.map((a: { campaignId: string }) => a.campaignId)).toEqual(["r1", "r2"]);
    expect(readFollowupOwed.mock.calls[0][0]).toMatchObject({ orgId: "org-1", query: { campaignId: "r1", heldCampaignIds: ["p1", "p2"] } });
    expect(readFollowupOwed.mock.calls[1][0]).toMatchObject({ query: { campaignId: "r2", heldCampaignIds: ["r2"] } });
  });

  it("refuses a bad body with invalid_owed_query", async () => {
    for (const body of [{}, { campaigns: [] }, { campaigns: [{}] }, { campaigns: [{ campaignId: "r1", extra: 1 }] }]) {
      const res = await request(app).post(url).set(auth).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("invalid_owed_query");
    }
    expect(readFollowupOwed).not.toHaveBeenCalled();
  });

  it("requires x-org-id and the api key", async () => {
    expect((await request(app).post(url).set({ "x-api-key": "test-api-key" }).send({ campaigns: [{ campaignId: "r1" }] })).status).toBe(400);
    expect((await request(app).post(url).set({ "x-org-id": "org-1" }).send({ campaigns: [{ campaignId: "r1" }] })).status).toBe(401);
  });
});
