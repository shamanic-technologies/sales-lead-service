import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let statusRows: Array<Record<string, unknown>> = [];
let evidenceRows: Array<Record<string, unknown>> = [];

const selectMock = vi.fn(() => ({
  from: () => ({
    where: () => ({
      groupBy: () => Promise.resolve(statusRows),
    }),
  }),
}));

const executeMock = vi.fn(() => Promise.resolve(evidenceRows));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => selectMock(),
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

const fetchEmailGatewayStatsMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  fetchEmailGatewayStats: (...args: unknown[]) => fetchEmailGatewayStatsMock(...args),
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

function recipientStats(overrides: Partial<{
  contacted: number;
  sent: number;
  delivered: number;
  opened: number;
  bounced: number;
  clicked: number;
  unsubscribed: number;
  repliesPositive: number;
  repliesNegative: number;
  repliesNeutral: number;
  repliesAutoReply: number;
  interested: number;
  meetingBooked: number;
  closed: number;
}> = {}) {
  return {
    contacted: overrides.contacted ?? 1,
    sent: overrides.sent ?? 1,
    delivered: overrides.delivered ?? 1,
    opened: overrides.opened ?? 0,
    bounced: overrides.bounced ?? 0,
    clicked: overrides.clicked ?? 0,
    unsubscribed: overrides.unsubscribed ?? 0,
    repliesPositive: overrides.repliesPositive ?? 0,
    repliesNegative: overrides.repliesNegative ?? 0,
    repliesNeutral: overrides.repliesNeutral ?? 0,
    repliesAutoReply: overrides.repliesAutoReply ?? 0,
    repliesDetail: {
      interested: overrides.interested ?? 0,
      meetingBooked: overrides.meetingBooked ?? 0,
      closed: overrides.closed ?? 0,
      notInterested: 0,
      wrongPerson: 0,
      unsubscribe: 0,
      neutral: 0,
      autoReply: 0,
      outOfOffice: 0,
    },
  };
}

function evidence(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "lc-1",
    campaignId: "campaign-1",
    brandIds: [BRAND],
    workflowSlug: "wf-1",
    featureSlug: "feat-1",
    goal: "signup",
    activeGoalId: "goal-1",
    brandProfileId: "brand-profile-1",
    customerPersonaId: "persona-1",
    customerProfileId: "profile-1",
    email: "lead@example.com",
    ...overrides,
  };
}

async function buildApp() {
  const { default: route } = await import("../../src/routes/stats.js");
  const app = express();
  app.use(route);
  return app;
}

describe("GET /orgs/stats persona attribution", () => {
  beforeEach(() => {
    statusRows = [];
    evidenceRows = [];
    selectMock.mockClear();
    executeMock.mockClear();
    fetchEmailGatewayStatsMock.mockReset();
  });

  it("keeps tagged customer profiles as separate evidence rows with their own outcomes", async () => {
    statusRows = [
      { key: "profile-a", status: "served", count: 1 },
      { key: "profile-b", status: "served", count: 1 },
    ];
    evidenceRows = [
      evidence({ id: "lc-a", campaignId: "campaign-a", customerProfileId: "profile-a", email: "a@example.com" }),
      evidence({ id: "lc-b", campaignId: "campaign-b", customerProfileId: "profile-b", email: "b@example.com" }),
    ];
    fetchEmailGatewayStatsMock.mockImplementation((params: { campaignId?: string }) => {
      if (params.campaignId === "campaign-a") {
        return Promise.resolve({
          groups: [
            {
              key: "a@example.com",
              broadcast: {
                recipientStats: recipientStats({
                  clicked: 2,
                  repliesPositive: 1,
                  interested: 1,
                }),
              },
            },
          ],
        });
      }
      return Promise.resolve({
        groups: [
          {
            key: "b@example.com",
            broadcast: {
              recipientStats: recipientStats({
                clicked: 0,
                repliesPositive: 0,
              }),
            },
          },
        ],
      });
    });

    const app = await buildApp();
    const res = await request(app)
      .get("/orgs/stats")
      .query({
        brandId: BRAND,
        featureSlug: "feat-1",
        goal: "signup",
        groupBy: "customerProfileId",
      })
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    const groups = new Map(res.body.groups.map((g: { key: string }) => [g.key, g]));
    expect(groups.size).toBe(2);
    expect(groups.get("profile-a").byOutreachStatus.clicked).toBe(2);
    expect(groups.get("profile-a").byOutreachStatus.repliesPositive).toBe(1);
    expect(groups.get("profile-a").repliesDetail.interested).toBe(1);
    expect(groups.get("profile-b").byOutreachStatus.clicked).toBe(0);
    expect(groups.get("profile-b").byOutreachStatus.repliesPositive).toBe(0);
    expect(fetchEmailGatewayStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "campaign-a", groupBy: "recipientEmail" }),
      expect.any(Object),
    );
  });

  it("does not assign untagged served rows to a persona/profile group", async () => {
    statusRows = [
      { key: "profile-a", status: "served", count: 1 },
      { key: null, status: "served", count: 1 },
    ];
    evidenceRows = [
      evidence({ id: "lc-a", customerProfileId: "profile-a", email: "a@example.com" }),
      evidence({ id: "lc-untagged", customerProfileId: null, email: "untagged@example.com" }),
    ];
    fetchEmailGatewayStatsMock.mockResolvedValue({
      groups: [
        {
          key: "a@example.com",
          broadcast: { recipientStats: recipientStats({ clicked: 1, repliesPositive: 1, interested: 1 }) },
        },
        {
          key: "untagged@example.com",
          broadcast: { recipientStats: recipientStats({ clicked: 9, repliesPositive: 9, interested: 9 }) },
        },
      ],
    });

    const app = await buildApp();
    const res = await request(app)
      .get("/orgs/stats")
      .query({ brandId: BRAND, featureSlug: "feat-1", groupBy: "customerProfileId" })
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { key: string }) => g.key)).toEqual(["profile-a"]);
    expect(res.body.groups[0].byOutreachStatus.clicked).toBe(1);
    expect(res.body.groups[0].byOutreachStatus.repliesPositive).toBe(1);
  });

  it("keeps existing aggregate stats behavior when no attribution field is requested", async () => {
    statusRows = [{ status: "served", count: 3 }];
    fetchEmailGatewayStatsMock.mockResolvedValue({
      broadcast: { recipientStats: recipientStats({ clicked: 4, repliesPositive: 2, interested: 2 }) },
    });

    const app = await buildApp();
    const res = await request(app)
      .get("/orgs/stats")
      .query({ brandId: BRAND })
      .set("x-api-key", "test-api-key")
      .set("x-org-id", ORG);

    expect(res.status).toBe(200);
    expect(res.body.totalLeads).toBe(3);
    expect(res.body.byOutreachStatus.clicked).toBe(4);
    expect(res.body.byOutreachStatus.repliesPositive).toBe(2);
    expect(executeMock).not.toHaveBeenCalled();
    expect(fetchEmailGatewayStatsMock).toHaveBeenCalledTimes(1);
    expect(fetchEmailGatewayStatsMock).toHaveBeenCalledWith({ brandId: BRAND }, expect.any(Object));
  });
});
