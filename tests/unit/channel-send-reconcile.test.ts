import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WA-SENDS-BATCH-1014: a STOPPED non-email campaign was never read by the pool again, so the people its sender wrote
 * to stayed unmarked and every "contacted" read showed 0 (campaign 4af21454 "Valued": 12 served rows, 0 marked, 8 people
 * `sent` at crm-service). The reconcile walk marks them from the sender's batch read, live or stopped campaign alike.
 */
const loadedRows: Array<Record<string, unknown>> = [];
const executeCalls: unknown[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: { execute: async (q: unknown) => (executeCalls.push(q), loadedRows) },
}));

const fetchChannelSendsBatch = vi.fn();
vi.mock("../../src/lib/channel-send-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/channel-send-client.js")>("../../src/lib/channel-send-client.js");
  return { ...actual, fetchChannelSendsBatch: (...a: unknown[]) => fetchChannelSendsBatch(...a) };
});

const methods: Record<string, string[] | null> = {
  "cold-whatsapp-outreach": ["phone"],
  "sales-cold-email-outreach": ["email"],
  "your-team-closing-calls": ["phone"],
};
vi.mock("../../src/lib/sourcing-origin.js", () => ({
  listChannelsWithContactMethods: async () => Object.keys(methods),
}));
vi.mock("../../src/lib/channel-reach.js", () => ({
  channelReachableBy: async (slug: string) => methods[slug] ?? null,
}));

const marked: Array<Array<{ id: string; sentAt: string; sendId: string }>> = [];
vi.mock("../../src/lib/retry-pool.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/retry-pool.js")>("../../src/lib/retry-pool.js");
  return { ...actual, markChannelSentCandidates: async (sent: Array<{ id: string; sentAt: string; sendId: string }>) => void marked.push(sent) };
});

const { ChannelSendsUnavailableError } = await import("../../src/lib/channel-send-client.js");
const { reconcileChannelSends, nonEmailChannels, groupByCampaign } = await import("../../src/lib/channel-send-reconcile.js");

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const CAMPAIGN = "4af21454-ae93-4d62-8528-cc95081145ac";
const row = (over: Record<string, unknown>) => ({
  id: "r1",
  org_id: "org-1",
  campaign_id: CAMPAIGN,
  feature_slug: "cold-whatsapp-outreach",
  brand_ids: ["brand-1"],
  user_id: "user-1",
  email: "imenez@gmail.com",
  ...over,
});
const send = (over: Record<string, unknown>) => ({
  sendId: "s1",
  status: "sent",
  campaignId: CAMPAIGN,
  sentAt: "2026-10-12T14:43:32.913Z",
  createdAt: "2026-10-12T14:43:31.765Z",
  ...over,
});

beforeEach(() => {
  loadedRows.length = 0;
  executeCalls.length = 0;
  marked.length = 0;
  fetchChannelSendsBatch.mockReset();
});

describe("channel send reconcile", () => {
  it("only the pipes whose pool asks the non-email sender are walked (the pool's own rule)", async () => {
    expect(await nonEmailChannels()).toEqual(["cold-whatsapp-outreach", "your-team-closing-calls"]);
  });

  it("marks every person the sender states SENT for this campaign, one batch call per campaign, nothing else", async () => {
    loadedRows.push(
      row({ id: "sent", email: "Imenez@gmail.com" }),
      row({ id: "sending", email: "a@x.co" }),
      row({ id: "failed", email: "b@x.co" }),
      row({ id: "none", email: "c@x.co" }),
    );
    fetchChannelSendsBatch.mockResolvedValue(
      new Map([
        ["imenez@gmail.com", [send({ sendId: "s-imenez" })]],
        ["a@x.co", [send({ status: "sending", sentAt: null })]],
        ["b@x.co", [send({ status: "failed", sentAt: null }), send({ status: "refused", sentAt: null })]],
      ]),
    );
    const result = await reconcileChannelSends({ servedSince: null, nowMs: NOW });
    expect(fetchChannelSendsBatch).toHaveBeenCalledTimes(1);
    const [brandId, campaignId, emails, ctx] = fetchChannelSendsBatch.mock.calls[0];
    expect([brandId, campaignId, emails, ctx]).toEqual(["brand-1", CAMPAIGN, ["Imenez@gmail.com", "a@x.co", "b@x.co", "c@x.co"], { orgId: "org-1", userId: "user-1" }]);
    expect(marked).toEqual([[{ id: "sent", sentAt: "2026-10-12T14:43:32.913Z", sendId: "s-imenez" }]]);
    expect(result).toMatchObject({ rows: 4, marked: 1, noEmail: 0, failedCampaigns: 0 });
  });

  it("a dry run asks and counts, writes nothing", async () => {
    loadedRows.push(row({}));
    fetchChannelSendsBatch.mockResolvedValue(new Map([["imenez@gmail.com", [send({})]]]));
    const result = await reconcileChannelSends({ servedSince: null, dryRun: true, nowMs: NOW });
    expect(result).toMatchObject({ dryRun: true, marked: 1 });
    expect(marked).toEqual([]);
  });

  it("a row with no email is never asked and is counted (a phone-only send cannot be matched)", async () => {
    loadedRows.push(row({ id: "noemail", email: null }), row({ id: "e", email: "e@x.co" }));
    fetchChannelSendsBatch.mockResolvedValue(new Map());
    const result = await reconcileChannelSends({ servedSince: null, nowMs: NOW });
    expect(fetchChannelSendsBatch.mock.calls[0][2]).toEqual(["e@x.co"]);
    expect(result).toMatchObject({ noEmail: 1, marked: 0 });
  });

  it("a campaign whose sender cannot be read marks nothing and never stops the others", async () => {
    loadedRows.push(row({ id: "a", campaign_id: "camp-a" }), row({ id: "b", campaign_id: "camp-b", email: "b@x.co" }));
    fetchChannelSendsBatch.mockImplementation(async (_b: string, campaignId: string) => {
      if (campaignId === "camp-a") throw new ChannelSendsUnavailableError("crm-service 502");
      return new Map([["b@x.co", [send({ campaignId: "camp-b", sendId: "s-b" })]]]);
    });
    const result = await reconcileChannelSends({ servedSince: null, nowMs: NOW });
    expect(result.failedCampaigns).toBe(1);
    expect(result.campaigns.find((c) => c.campaignId === "camp-a")?.skipped).toMatch(/502/);
    expect(marked.flat().map((m) => m.id)).toEqual(["b"]);
  });

  it("a campaign whose rows name several brands is not asked (the sender is asked for one brand)", async () => {
    loadedRows.push(row({ id: "a" }), row({ id: "b", brand_ids: ["brand-2"] }));
    const result = await reconcileChannelSends({ servedSince: null, nowMs: NOW });
    expect(fetchChannelSendsBatch).not.toHaveBeenCalled();
    expect(result.campaigns[0].skipped).toMatch(/2 brand/);
  });

  it("asks nothing when no pipe writes outside email", async () => {
    const saved = { ...methods };
    for (const k of Object.keys(methods)) methods[k] = ["email"];
    try {
      const result = await reconcileChannelSends({ servedSince: null, nowMs: NOW });
      expect(result.rows).toBe(0);
      expect(executeCalls).toHaveLength(0);
    } finally {
      Object.assign(methods, saved);
    }
  });

  it("groups rows by campaign", () => {
    expect([...groupByCampaign([row({ id: "1" }), row({ id: "2", campaign_id: "x" }), row({ id: "3" })] as never).entries()].map(([k, v]) => [k, v.length])).toEqual([
      [CAMPAIGN, 2],
      ["x", 1],
    ]);
  });
});
