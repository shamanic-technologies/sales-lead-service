import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// The SQL itself is proven in tests/integration/conversation-counts-sql.test.ts; this pins the
// route: registered ahead of /orgs/leads/:id, org from the header, campaignId required, and a
// throw becomes a 500 rather than a hung socket.
vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: { execute: vi.fn() } }));

const readConversationCountsMock = vi.fn();
vi.mock("../../src/lib/followup-actions.js", () => ({
  readConversationCounts: (...args: unknown[]) => readConversationCountsMock(...args),
}));
vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const CAMPAIGN = "600996b5-84b5-4368-86a5-a118b50bc2c9";

let app: express.Express;
beforeAll(async () => {
  const { default: route } = await import("../../src/routes/leads.js");
  app = express();
  app.use(express.json());
  app.use(route);
});

beforeEach(() => {
  readConversationCountsMock.mockReset();
});

function get(path: string) {
  return request(app).get(path).set("x-api-key", "test-api-key").set("x-org-id", ORG);
}

describe("GET /orgs/leads/conversation-counts", () => {
  it("answers the four counts for the acting campaign in the caller's org", async () => {
    readConversationCountsMock.mockResolvedValue({ handed: 7, ongoing: 2, meetingsBooked: 1, dropped: 4 });
    const res = await get(`/orgs/leads/conversation-counts?campaignId=${CAMPAIGN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      campaignId: CAMPAIGN,
      conversations: { handed: 7, ongoing: 2, meetingsBooked: 1, dropped: 4 },
    });
    expect(readConversationCountsMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, campaignId: CAMPAIGN }),
    );
  });

  it("refuses a read naming no campaign", async () => {
    const res = await get("/orgs/leads/conversation-counts");
    expect(res.status).toBe(400);
    expect(readConversationCountsMock).not.toHaveBeenCalled();
  });

  it("a failed read is a 500, never a hung socket or zeros", async () => {
    readConversationCountsMock.mockRejectedValue(new Error("boom"));
    const res = await get(`/orgs/leads/conversation-counts?campaignId=${CAMPAIGN}`);
    expect(res.status).toBe(500);
  });
});
