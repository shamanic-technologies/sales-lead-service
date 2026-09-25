import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const readFollowupActions = vi.fn();
const pickFollowupCandidate = vi.fn();
const writeFollowupStatement = vi.fn();

vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));
vi.mock("../../src/lib/followup-actions.js", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readFollowupActions: (...a: unknown[]) => readFollowupActions(...a),
}));
vi.mock("../../src/lib/followup-queue.js", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  pickFollowupCandidate: (...a: unknown[]) => pickFollowupCandidate(...a),
  writeFollowupStatement: (...a: unknown[]) => writeFollowupStatement(...a),
}));

const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const AI = "8c748ddd-86a2-4d7f-9f67-1528c7136665";
const PRED = "f7b1b610-4fa1-4b54-8fec-f7be124dc32b";
const ROW = "40000000-0000-0000-0000-000000000001";

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/followups.js");
  app = express();
  app.use(express.json());
  app.use(route);
  app.use((_e: Error, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
}, 30_000);

beforeEach(() => {
  readFollowupActions.mockReset();
  pickFollowupCandidate.mockReset();
  writeFollowupStatement.mockReset();
});

describe("GET /internal/brands/:brandId/followup-actions", () => {
  const url = `/internal/brands/${BRAND}/followup-actions`;

  it("401 without the api key", async () => {
    const res = await request(app).get(url).query({ campaignIds: AI });
    expect(res.status).toBe(401);
  });

  it("needs no org — service auth only", async () => {
    readFollowupActions.mockResolvedValue({ leads: [], campaigns: [] });
    const res = await request(app).get(url).set("x-api-key", "test-api-key").query({ campaignIds: AI });
    expect(res.status).toBe(200);
  });

  it("400 without campaignIds", async () => {
    const res = await request(app).get(url).set("x-api-key", "test-api-key");
    expect(res.status).toBe(400);
    expect(readFollowupActions).not.toHaveBeenCalled();
  });

  it("400 on a non-uuid brand", async () => {
    const res = await request(app)
      .get("/internal/brands/nope/followup-actions")
      .set("x-api-key", "test-api-key")
      .query({ campaignIds: AI });
    expect(res.status).toBe(400);
  });

  it("400 past the id ceiling", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `c-${i}`).join(",");
    const res = await request(app).get(url).set("x-api-key", "test-api-key").query({ campaignIds: ids });
    expect(res.status).toBe(400);
  });

  it("dedupes and trims the ids, and returns what the ledger read answers", async () => {
    const payload = {
      leads: [
        {
          actingCampaignId: AI,
          leadId: "l1",
          email: "a@x.com",
          leadCampaignIds: [ROW],
          heldByCampaignIds: [PRED],
          claimCount: 2,
          firstClaimedAt: "2026-09-21T15:22:53.922Z",
          lastClaimedAt: "2026-09-21T19:04:22.319Z",
          actedCount: 2,
          firstActedAt: "2026-09-21T15:23:10.902Z",
          lastActedAt: "2026-09-21T19:04:44.615Z",
        },
      ],
      campaigns: [{ campaignId: AI, leadsClaimed: 1, leadsActed: 1, claims: 2, acts: 2 }],
    };
    readFollowupActions.mockResolvedValue(payload);
    const res = await request(app)
      .get(url)
      .set("x-api-key", "test-api-key")
      .query({ campaignIds: ` ${AI}, ${AI},` });
    expect(res.status).toBe(200);
    expect(readFollowupActions).toHaveBeenCalledWith({ brandId: BRAND, campaignIds: [AI] });
    expect(res.body).toEqual({ brandId: BRAND, ...payload });
  });
});

describe("the writes attribute to the DISPATCHED campaign (x-campaign-id)", () => {
  const auth = { "x-api-key": "test-api-key", "x-org-id": "org-1", "x-run-id": "run-1", "x-campaign-id": AI };

  it("claim-next passes x-campaign-id as the acting campaign, the path as the holding one", async () => {
    pickFollowupCandidate.mockResolvedValue({ claimed: null, reason: "nothing_due" });
    await request(app).post(`/orgs/campaigns/${PRED}/followups/claim-next`).set(auth).send({});
    expect(pickFollowupCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: PRED, actingCampaignId: AI, runId: "run-1" }),
    );
  });

  it("an 'acted' statement carries the acting campaign and run", async () => {
    writeFollowupStatement.mockResolvedValue({ id: ROW });
    await request(app)
      .post(`/orgs/leads/${ROW}/followups`)
      .set(auth)
      .send({ kind: "acted", nextDueAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(writeFollowupStatement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "acted", actingCampaignId: AI, runId: "run-1" }),
    );
  });

  it("no x-campaign-id is recorded as null, never guessed", async () => {
    pickFollowupCandidate.mockResolvedValue({ claimed: null, reason: "nothing_due" });
    await request(app)
      .post(`/orgs/campaigns/${PRED}/followups/claim-next`)
      .set({ "x-api-key": "test-api-key", "x-org-id": "org-1" })
      .send({});
    expect(pickFollowupCandidate).toHaveBeenCalledWith(expect.objectContaining({ actingCampaignId: null }));
  });
});
