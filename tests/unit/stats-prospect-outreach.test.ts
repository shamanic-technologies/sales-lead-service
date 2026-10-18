import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// CAMPAIGN-STATS-SENT-ZERO-1018: a campaign's outreach figures count PROSPECTS only. A
// transactional message stamped with the campaign id counts when its recipient is a lead of the
// scope; a notification to the client's own team ("<prospect> wants to book a call") never does.

let statusRows: Array<Record<string, unknown>> = [];
let whereConditions: unknown[] = [];
let leadEmailRows: Array<{ email: string }> = [];

const selectMock = vi.fn(() => ({
  from: () => ({
    where: (cond: unknown) => {
      whereConditions.push(cond);
      return { groupBy: () => Promise.resolve(statusRows) };
    },
  }),
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => selectMock(),
    execute: () => Promise.resolve(leadEmailRows),
  },
}));

const fetchEmailGatewayStatsMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  fetchEmailGatewayStats: (...args: unknown[]) => fetchEmailGatewayStatsMock(...args),
}));

const resolveCampaignFamilyMock = vi.fn();
vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (...args: unknown[]) => resolveCampaignFamilyMock(...args),
}));

vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveFeatureDynastySlugs: vi.fn(),
  resolveWorkflowDynastySlugs: vi.fn(),
  fetchFeatureDynastyMap: vi.fn(),
  fetchWorkflowDynastyMap: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
}));

const ORG = "org-1";
const BRAND = "brand-1";
const LIVE = "campaign-live";
const ANCESTOR = "campaign-ancestor";

function recipientStats(over: Partial<Record<string, number>> = {}) {
  return {
    contacted: over.contacted ?? 0,
    sent: over.sent ?? 0,
    delivered: over.delivered ?? 0,
    opened: over.opened ?? 0,
    bounced: over.bounced ?? 0,
    clicked: over.clicked ?? 0,
    unsubscribed: over.unsubscribed ?? 0,
    repliesPositive: over.repliesPositive ?? 0,
    repliesNegative: 0,
    repliesNeutral: 0,
    repliesAutoReply: 0,
    repliesDetail: {
      interested: over.interested ?? 0,
      meetingBooked: 0, closed: 0, notInterested: 0, wrongPerson: 0,
      unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0,
    },
  };
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/stats.js");
  const app = express();
  app.use(route);
  return app;
}

function get(app: express.Express, query: Record<string, string>) {
  return request(app).get("/orgs/stats").query(query).set("x-api-key", "test-api-key").set("x-org-id", ORG);
}

const TEAM = "kevin@distribute.you";
const PROSPECT = "jane@prospect.com";

describe("GET /orgs/stats counts prospects only", () => {
  beforeEach(() => {
    statusRows = [];
    whereConditions = [];
    leadEmailRows = [{ email: PROSPECT }, { email: "bob@prospect.com" }];
    selectMock.mockClear();
    fetchEmailGatewayStatsMock.mockReset();
    resolveCampaignFamilyMock.mockReset();
    resolveCampaignFamilyMock.mockResolvedValue([LIVE]);
  });

  it("a transactional notification to the org's team carrying the campaign id raises neither contacted nor sent", async () => {
    statusRows = [{ status: "served", count: 8 }];
    fetchEmailGatewayStatsMock.mockImplementation((params: { groupBy?: string }) =>
      Promise.resolve(
        params.groupBy === "recipientEmail"
          ? {
              groups: [
                { key: TEAM, transactional: { recipientStats: recipientStats({ contacted: 1, sent: 1, delivered: 1, opened: 1 }) } },
                { key: PROSPECT, broadcast: { recipientStats: recipientStats({ contacted: 1 }) } },
              ],
            }
          : {
              broadcast: { recipientStats: recipientStats({ contacted: 7 }) },
              transactional: { recipientStats: recipientStats({ contacted: 1, sent: 1, delivered: 1, opened: 1 }) },
            },
      ),
    );

    const app = await buildApp();
    const res = await get(app, { brandId: BRAND, campaignId: LIVE });

    expect(res.status).toBe(200);
    expect(res.body.byOutreachStatus.contacted).toBe(7);
    expect(res.body.byOutreachStatus.sent).toBe(0);
    expect(res.body.byOutreachStatus.delivered).toBe(0);
    expect(res.body.byOutreachStatus.opened).toBe(0);
    const perRecipient = fetchEmailGatewayStatsMock.mock.calls.find((c) => c[0].groupBy === "recipientEmail");
    expect(perRecipient?.[0]).toEqual(expect.objectContaining({ campaignId: LIVE, brandId: BRAND }));
  });

  it("a transactional message to a lead of the campaign still counts", async () => {
    statusRows = [{ status: "served", count: 8 }];
    fetchEmailGatewayStatsMock.mockImplementation((params: { groupBy?: string }) =>
      Promise.resolve(
        params.groupBy === "recipientEmail"
          ? {
              groups: [
                { key: "Jane@Prospect.com", transactional: { recipientStats: recipientStats({ contacted: 1, sent: 1 }) } },
                { key: TEAM, transactional: { recipientStats: recipientStats({ contacted: 1, sent: 1 }) } },
              ],
            }
          : {
              broadcast: { recipientStats: recipientStats({ contacted: 7, sent: 7 }) },
              transactional: { recipientStats: recipientStats({ contacted: 2, sent: 2 }) },
            },
      ),
    );

    const app = await buildApp();
    const res = await get(app, { brandId: BRAND, campaignId: LIVE });

    expect(res.body.byOutreachStatus.contacted).toBe(8);
    expect(res.body.byOutreachStatus.sent).toBe(8);
  });

  it("no transactional activity makes no extra call", async () => {
    statusRows = [{ status: "served", count: 7 }];
    fetchEmailGatewayStatsMock.mockResolvedValue({ broadcast: { recipientStats: recipientStats({ contacted: 7, sent: 7 }) } });

    const app = await buildApp();
    const res = await get(app, { brandId: BRAND, campaignId: LIVE });

    expect(res.body.byOutreachStatus.contacted).toBe(7);
    expect(fetchEmailGatewayStatsMock).toHaveBeenCalledTimes(1);
  });

  it("groupBy=campaignId drops the team notification from that campaign's line", async () => {
    statusRows = [{ key: LIVE, status: "served", count: 8 }];
    fetchEmailGatewayStatsMock.mockImplementation((params: { groupBy?: string; campaignId?: string }) =>
      Promise.resolve(
        params.groupBy === "recipientEmail"
          ? { groups: [{ key: TEAM, transactional: { recipientStats: recipientStats({ contacted: 1, sent: 1 }) } }] }
          : {
              groups: [
                {
                  key: LIVE,
                  broadcast: { recipientStats: recipientStats({ contacted: 7 }) },
                  transactional: { recipientStats: recipientStats({ contacted: 1, sent: 1 }) },
                },
              ],
            },
      ),
    );

    const app = await buildApp();
    const res = await get(app, { brandId: BRAND, campaignId: LIVE, groupBy: "campaignId" });

    expect(res.status).toBe(200);
    expect(res.body.groups[0].byOutreachStatus.contacted).toBe(7);
    expect(res.body.groups[0].byOutreachStatus.sent).toBe(0);
  });
});
