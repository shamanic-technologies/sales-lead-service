import { afterEach, describe, expect, it, vi } from "vitest";

// REUSED-ACQUISITION-COST-1017: per source campaign, what an EARLIER run paid to find its own-run finds
// (src/lib/source-reused-acquisitions.ts), priced by apollo-service POST /internal/acquisition-costs.

vi.mock("../../src/config.js", () => ({
  APOLLO_SERVICE_URL: "http://apollo",
  APOLLO_SERVICE_API_KEY: "apollo-key",
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
}));
vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn(async () => []) } }));

import {
  askApolloAcquisitionCosts,
  computeSourceReusedAcquisitions,
  type AskAcquisitionCosts,
  type OwnRunFind,
} from "../../src/lib/source-reused-acquisitions.js";

const ORG_A = "308f528f-03ad-44b1-9cbc-623a6af9ba0e";
const ORG_B = "91e76989-71ba-420d-ba73-bb3961430aa7";

function find(campaignId: string, orgId: string, n: number, extra: Partial<OwnRunFind> = {}): OwnRunFind {
  return { rowId: `${campaignId}-${n}`, orgId, campaignId, servedAt: "2026-10-14T10:00:00.000Z", apolloPersonId: `p-${campaignId}-${n}`, email: null, ...extra };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("computeSourceReusedAcquisitions", () => {
  it("serves apollo-service's per-campaign figures; a campaign that bought every lead itself reads 0 reused", async () => {
    const asked: Array<{ orgId: string; n: number }> = [];
    const ask: AskAcquisitionCosts = async (orgId, finds) => {
      asked.push({ orgId, n: finds.length });
      return {
        campaigns: [
          { campaignId: "reuser", servedLeads: 2, reusedLeads: 2, earlierAcquisitionCostInUsdCents: "18.5000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000" },
          { campaignId: "buyer", servedLeads: 1, reusedLeads: 0, earlierAcquisitionCostInUsdCents: "0.0000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000" },
        ],
        unpricedRunIds: [],
      };
    };
    const got = await computeSourceReusedAcquisitions(
      [find("reuser", ORG_A, 1), find("reuser", ORG_A, 2), find("buyer", ORG_A, 1), find("buyer", ORG_A, 2, { apolloPersonId: null, email: null })],
      ask,
    );
    expect(asked).toEqual([{ orgId: ORG_A, n: 3 }]);
    expect(got.basis).toBe("own_runs");
    expect(got.recordedSince).toBe("2026-10-12T00:00:00.000Z");
    expect(got.counts).toEqual([
      { campaignId: "buyer", orgId: ORG_A, ownRuns: 2, checkedLeads: 1, uncheckedLeads: 1, reusedLeads: 0, earlierAcquisitionCostInUsdCents: "0.0000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000", unavailableReason: null },
      { campaignId: "reuser", orgId: ORG_A, ownRuns: 2, checkedLeads: 2, uncheckedLeads: 0, reusedLeads: 2, earlierAcquisitionCostInUsdCents: "18.5000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000", unavailableReason: null },
    ]);
  });

  it("an org apollo-service cannot answer for reads null + reason, never 0; other orgs still served", async () => {
    const ask: AskAcquisitionCosts = async (orgId, finds) => {
      if (orgId === ORG_B) throw new Error("apollo down");
      return { campaigns: [{ campaignId: finds[0].campaignId, servedLeads: finds.length, reusedLeads: 1, earlierAcquisitionCostInUsdCents: "9.0000000000", paidByOtherOrgsCostInUsdCents: "1.0000000000" }], unpricedRunIds: ["r1"] };
    };
    const got = await computeSourceReusedAcquisitions([find("a", ORG_A, 1), find("b", ORG_B, 1)], ask);
    expect(got.counts.find((c) => c.campaignId === "a")).toMatchObject({ reusedLeads: 1, earlierAcquisitionCostInUsdCents: "9.0000000000", paidByOtherOrgsCostInUsdCents: "1.0000000000", unavailableReason: null });
    expect(got.counts.find((c) => c.campaignId === "b")).toMatchObject({ ownRuns: 1, reusedLeads: null, earlierAcquisitionCostInUsdCents: null, paidByOtherOrgsCostInUsdCents: null, unavailableReason: "apollo_service_unavailable" });
    expect(got.unpricedRunIds).toEqual(["r1"]);
  });

  it("an answer that does not cover every find asked is unavailable, never a partial figure", async () => {
    const ask: AskAcquisitionCosts = async () => ({
      campaigns: [{ campaignId: "a", servedLeads: 1, reusedLeads: 1, earlierAcquisitionCostInUsdCents: "5.0000000000", paidByOtherOrgsCostInUsdCents: "0.0000000000" }],
      unpricedRunIds: [],
    });
    const got = await computeSourceReusedAcquisitions([find("a", ORG_A, 1), find("a", ORG_A, 2)], ask);
    expect(got.counts[0]).toMatchObject({ reusedLeads: null, earlierAcquisitionCostInUsdCents: null, unavailableReason: "apollo_answer_incomplete" });
  });
});

describe("askApolloAcquisitionCosts", () => {
  it("one call per 5000 finds, totals summed exactly across chunks, request names the served campaign and date", async () => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://apollo/internal/acquisition-costs");
        expect((init.headers as Record<string, string>)["x-api-key"]).toBe("apollo-key");
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        return new Response(
          JSON.stringify({
            people: [],
            campaigns: [{ campaignId: "a", servedLeads: body.servedLeads.length, reusedLeads: 1, earlierAcquisitionCostInUsdCents: "0.1000000001", paidByOtherOrgsCostInUsdCents: "0.0000000000" }],
            unpricedRunIds: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const finds = Array.from({ length: 5001 }, (_, i) => find("a", ORG_A, i, i === 0 ? { email: "x@y.com" } : {}));
    const got = await askApolloAcquisitionCosts(ORG_A, finds);
    expect(bodies.map((b) => b.servedLeads.length)).toEqual([5000, 1]);
    expect(bodies[0].orgId).toBe(ORG_A);
    expect(bodies[0].servedLeads[0]).toEqual({ ref: "a-0", servedCampaignId: "a", servedAt: "2026-10-14T10:00:00.000Z", apolloPersonId: "p-a-0", email: "x@y.com" });
    expect(bodies[0].servedLeads[1]).not.toHaveProperty("email");
    expect(got.campaigns).toEqual([{ campaignId: "a", servedLeads: 5001, reusedLeads: 2, earlierAcquisitionCostInUsdCents: "0.2000000002", paidByOtherOrgsCostInUsdCents: "0.0000000000" }]);
  });

  it("a non-2xx answer throws (the caller marks the org unavailable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(askApolloAcquisitionCosts(ORG_A, [find("a", ORG_A, 1)])).rejects.toThrow(/500/);
  });
});
