import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../src/lib/people-client.js";

// LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): pullNext's `find` (a source unit's own run) and `stock` (an outreach
// campaign fed by sources that find on their own) modes. The `serve` mode (today) is tests/unit/buffer.test.ts.
const serveNext = vi.fn();
// The candidate path (qualify before paying) has its own suite: tests/unit/candidate-serve.test.ts.
// Here every audience answers "not served through candidates", so pullNext uses serve-next.
vi.mock("../../src/lib/candidate-serve.js", () => ({ serveThroughCandidates: vi.fn(async () => null) }));

vi.mock("../../src/lib/people-client.js", () => ({
  serveNext: (...args: unknown[]) => serveNext(...args),
  isAudienceNotServeableError: (e: unknown) => e instanceof Error && e.message === "not serveable",
}));

const claimStockedLead = vi.fn();
vi.mock("../../src/lib/source-stock.js", () => ({
  SOURCE_FOUND_STATUS_REASON: "source_found",
  claimStockedLead: (...args: unknown[]) => claimStockedLead(...args),
}));

const getCurrentGoal = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => ({
  getCurrentGoal: (...args: unknown[]) => getCurrentGoal(...args),
}));

const upsertLeadFromPerson = vi.fn();
const recordEmploymentHistory = vi.fn();
const registerServedEmail = vi.fn();
vi.mock("../../src/lib/leads-registry.js", () => ({
  upsertLeadFromPerson: (...args: unknown[]) => upsertLeadFromPerson(...args),
  recordEmploymentHistory: (...args: unknown[]) => recordEmploymentHistory(...args),
  registerServedEmail: (...args: unknown[]) => registerServedEmail(...args),
}));

const pickRetryCandidate = vi.fn();
vi.mock("../../src/lib/retry-pool.js", () => ({
  pickRetryCandidate: (...args: unknown[]) => pickRetryCandidate(...args),
}));

const fetchCampaign = vi.fn();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: (...args: unknown[]) => fetchCampaign(...args),
}));

const buildFullLead = vi.fn();
vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLead: (...args: unknown[]) => buildFullLead(...args),
}));

// The writer's check results (src/lib/writer-checks.ts) have their own suite; here they are
// observed only for WHEN they run and that the serve hands them out.
const offerChecks = vi.fn();
const checksForWriter = vi.fn();
vi.mock("../../src/lib/writer-checks.js", () => ({
  offerChecks: (...args: unknown[]) => offerChecks(...args),
  checksForWriter: (...args: unknown[]) => checksForWriter(...args),
}));

const insertValues = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (...args: unknown[]) => {
        insertValues(...args);
        return { onConflictDoNothing: vi.fn(async () => undefined) };
      },
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  leadsCampaigns: { id: "leads_campaigns.id" },
}));

import { pullNext } from "../../src/lib/buffer.js";

const person: Person = {
  firstName: "Sara",
  lastName: "Lee",
  name: "Sara Lee",
  title: "Founder",
  headline: null,
  seniority: null,
  email: "sara@cascobay.com",
  emailStatus: "verified",
  catchAll: false,
  inferred: false,
  linkedinUrl: null,
  photoUrl: null,
  city: null,
  state: null,
  country: null,
  timezone: "America/New_York",
  provider: "apollo",
  providerPersonId: "apollo-person-1",
  organization: null,
};

const UNIT = "unit-1";
const findParams = (audienceIds: string[]) => ({
  orgId: "org-1",
  campaignId: UNIT,
  brandIds: ["brand-1"],
  brandId: "brand-1",
  featureSlug: "sourcing-apollo-cold-filters",
  runFeatureSlug: "sourcing-apollo-cold-filters",
  runCampaignId: UNIT,
  runId: "run-1",
  userId: "user-1",
  audienceId: null,
  mode: { kind: "find" as const, audienceIds },
});

const stockParams = (audienceId: string | null = null) => ({
  orgId: "org-1",
  campaignId: "outreach-1",
  brandIds: ["brand-1"],
  brandId: "brand-1",
  featureSlug: "sales-cold-email-outreach",
  runFeatureSlug: "sales-cold-email-outreach",
  runCampaignId: "outreach-1",
  runId: "run-1",
  userId: "user-1",
  audienceId,
  mode: { kind: "stock" as const, sourceCampaignIds: [UNIT] },
});

describe("pullNext find mode (a source unit's own run)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentGoal.mockResolvedValue("signup");
    pickRetryCandidate.mockResolvedValue(null);
    fetchCampaign.mockResolvedValue({ id: UNIT, offerId: "offer-1" });
    offerChecks.mockResolvedValue([
      { id: "c-hard", mode: "must_pass" },
      { id: "c-bonus", mode: "mention" },
    ]);
    checksForWriter.mockResolvedValue({ domain: null, checks: [] });
    upsertLeadFromPerson.mockResolvedValue("lead-1");
    registerServedEmail.mockResolvedValue("lead-1");
    recordEmploymentHistory.mockResolvedValue(undefined);
    buildFullLead.mockResolvedValue({ leadId: "lead-1" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("walks the source's audiences in order, stores the lead UNDER THE SOURCE marked source_found, never touches the retry pool, pays no Bonus check", async () => {
    serveNext.mockResolvedValueOnce({ status: "exhausted" }).mockResolvedValueOnce({ status: "served", person });

    const result = await pullNext(findParams(["aud-1", "aud-2"]));

    expect(result.found).toBe(true);
    expect(result.lead?.audienceId).toBe("aud-2");
    expect(serveNext).toHaveBeenNthCalledWith(1, "aud-1", expect.objectContaining({ audienceId: "aud-1", campaignId: UNIT, featureSlug: "sourcing-apollo-cold-filters" }));
    expect(serveNext).toHaveBeenNthCalledWith(2, "aud-2", expect.objectContaining({ audienceId: "aud-2", campaignId: UNIT }));
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: UNIT, status: "served", statusReason: "source_found", audienceId: "aud-2", featureSlug: "sourcing-apollo-cold-filters" }),
    );
    expect(pickRetryCandidate).not.toHaveBeenCalled();
    expect(claimStockedLead).not.toHaveBeenCalled();
    // Hard filters read back only: the Bonus check (writer context) is paid when an outreach campaign takes the lead.
    expect(checksForWriter).toHaveBeenCalledWith({ leadId: "lead-1" }, [{ id: "c-hard", mode: "must_pass" }], expect.anything());
  });

  it("every audience walked and empty = audience_exhausted (the one answer that means nobody left)", async () => {
    serveNext.mockResolvedValue({ status: "exhausted" });
    await expect(pullNext(findParams(["aud-1", "aud-2"]))).resolves.toEqual({ found: false, reason: "audience_exhausted" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("an audience that cannot be walked yet is skipped; if the rest are empty it is NOT exhaustion", async () => {
    serveNext.mockRejectedValueOnce(new Error("not serveable")).mockResolvedValueOnce({ status: "exhausted" });
    await expect(pullNext(findParams(["aud-1", "aud-2"]))).resolves.toEqual({ found: false, reason: "audience_not_serveable" });
  });

  it("an unfinished look stops the walk: serve_timed_out", async () => {
    serveNext.mockResolvedValueOnce({ status: "pending" });
    await expect(pullNext(findParams(["aud-1", "aud-2"]))).resolves.toEqual({ found: false, reason: "serve_timed_out" });
    expect(serveNext).toHaveBeenCalledTimes(1);
  });

  it("no audience of this source: no_audience, nothing bought", async () => {
    await expect(pullNext(findParams([]))).resolves.toEqual({ found: false, reason: "no_audience" });
    expect(serveNext).not.toHaveBeenCalled();
    expect(getCurrentGoal).not.toHaveBeenCalled();
  });
});

describe("pullNext stock mode (an outreach campaign fed by sources that find on their own)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentGoal.mockResolvedValue("signup");
    pickRetryCandidate.mockResolvedValue(null);
    fetchCampaign.mockResolvedValue({ id: "outreach-1", offerId: "offer-1" });
    offerChecks.mockResolvedValue([{ id: "c-bonus", mode: "mention" }]);
    checksForWriter.mockResolvedValue({ domain: "acme.com", checks: [] });
    buildFullLead.mockResolvedValue({ leadId: "lead-9", apolloPersonId: "ap-9" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("serves the oldest stocked lead (no audience needed), never finds on demand, runs the writer's checks", async () => {
    claimStockedLead.mockResolvedValueOnce({
      sourceRowId: "row-1",
      sourceCampaignId: UNIT,
      leadId: "lead-9",
      email: "x@acme.com",
      audienceId: "aud-7",
      buyingSignal: null,
      personId: null,
      goal: "signup",
    });

    const result = await pullNext(stockParams());

    expect(result.found).toBe(true);
    expect(result.lead).toMatchObject({ leadId: "lead-9", email: "x@acme.com", audienceId: "aud-7", apolloPersonId: "ap-9" });
    expect(claimStockedLead).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", sourceCampaignIds: [UNIT], outreachCampaignId: "outreach-1", featureSlug: "sales-cold-email-outreach", runId: "run-1" }),
    );
    expect(serveNext).not.toHaveBeenCalled();
    expect(checksForWriter).toHaveBeenCalledWith({ leadId: "lead-9", apolloPersonId: "ap-9" }, [{ id: "c-bonus", mode: "mention" }], expect.anything());
  });

  it("drains the outreach campaign's own paid pool FIRST, like every serve", async () => {
    pickRetryCandidate.mockResolvedValueOnce({ leadId: "lead-r", email: "r@x.co", retryCount: 0, goal: null, audienceId: null, buyingSignal: null, personId: null });
    const result = await pullNext(stockParams());
    expect(result.lead?.leadId).toBe("lead-r");
    expect(claimStockedLead).not.toHaveBeenCalled();
  });

  it("stock empty = source_stock_empty, never exhaustion, nothing found on demand", async () => {
    claimStockedLead.mockResolvedValueOnce(null);
    await expect(pullNext(stockParams("aud-1"))).resolves.toEqual({ found: false, reason: "source_stock_empty" });
    expect(serveNext).not.toHaveBeenCalled();
  });
});
