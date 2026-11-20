import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fetchOrgCampaignRowsMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/campaign-leg-client.js", () => ({
  fetchOrgCampaignRows: (...args: unknown[]) => fetchOrgCampaignRowsMock(...args),
}));

import {
  readSharedOrgCampaignRows,
  resetSharedOrgCampaignRows,
  SHARED_ORG_CAMPAIGNS_TTL_MS,
} from "../../src/lib/shared-org-campaigns.js";

const ORG_A = { orgId: "org-a", brandId: "brand-1" };
const ORG_B = { orgId: "org-b", brandId: "brand-1" };

function answer(ids: string[]) {
  return ids.map((id) => ({ id, legKey: null, offerId: `offer-of-${id}` }));
}

beforeEach(() => {
  resetSharedOrgCampaignRows();
  fetchOrgCampaignRowsMock.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("shared org campaign read (MON-PAGE-SPEED-FLOOR-1120)", () => {
  it("a burst of 8 parallel reads of one org shares ONE campaign-service read", async () => {
    fetchOrgCampaignRowsMock.mockImplementation(async () => answer(["c1", "c2"]));
    const rows = await Promise.all(Array.from({ length: 8 }, () => readSharedOrgCampaignRows(ORG_A, ["c1"])));
    expect(fetchOrgCampaignRowsMock).toHaveBeenCalledTimes(1);
    for (const r of rows) expect(r.map((x) => x.id)).toEqual(["c1", "c2"]);
  });

  it("never crosses orgs: each org is read with its own context", async () => {
    fetchOrgCampaignRowsMock.mockImplementation(async (ctx: { orgId: string }) => answer([`${ctx.orgId}-c`]));
    const [a, b] = await Promise.all([readSharedOrgCampaignRows(ORG_A, []), readSharedOrgCampaignRows(ORG_B, [])]);
    expect(a.map((x) => x.id)).toEqual(["org-a-c"]);
    expect(b.map((x) => x.id)).toEqual(["org-b-c"]);
    expect(fetchOrgCampaignRowsMock.mock.calls.map((c) => (c[0] as { orgId: string }).orgId).sort()).toEqual(["org-a", "org-b"]);
  });

  it("a campaign the held read does not hold re-asks campaign-service (never 'names no offer')", async () => {
    fetchOrgCampaignRowsMock.mockResolvedValueOnce(answer(["c1"])).mockResolvedValueOnce(answer(["c1", "c-new"]));
    await readSharedOrgCampaignRows(ORG_A, ["c1"]);
    const rows = await readSharedOrgCampaignRows(ORG_A, ["c-new"]);
    expect(rows.map((x) => x.id)).toEqual(["c1", "c-new"]);
    expect(fetchOrgCampaignRowsMock).toHaveBeenCalledTimes(2);
    // The fresher read now answers both.
    await readSharedOrgCampaignRows(ORG_A, ["c1", "c-new"]);
    expect(fetchOrgCampaignRowsMock).toHaveBeenCalledTimes(2);
  });

  it("a held read answers for at most the TTL, then campaign-service is asked again", async () => {
    vi.useFakeTimers();
    fetchOrgCampaignRowsMock.mockImplementation(async () => answer(["c1"]));
    await readSharedOrgCampaignRows(ORG_A, ["c1"]);
    vi.advanceTimersByTime(SHARED_ORG_CAMPAIGNS_TTL_MS - 1);
    await readSharedOrgCampaignRows(ORG_A, ["c1"]);
    expect(fetchOrgCampaignRowsMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await readSharedOrgCampaignRows(ORG_A, ["c1"]);
    expect(fetchOrgCampaignRowsMock).toHaveBeenCalledTimes(2);
  });

  it("a failed read is never served to the next caller", async () => {
    fetchOrgCampaignRowsMock.mockRejectedValueOnce(new Error("campaign-service down")).mockResolvedValueOnce(answer(["c1"]));
    await expect(readSharedOrgCampaignRows(ORG_A, ["c1"])).rejects.toThrow("campaign-service down");
    const rows = await readSharedOrgCampaignRows(ORG_A, ["c1"]);
    expect(rows.map((x) => x.id)).toEqual(["c1"]);
    expect(fetchOrgCampaignRowsMock).toHaveBeenCalledTimes(2);
  });
});
