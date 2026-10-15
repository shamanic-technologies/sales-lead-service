import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../src/lib/people-client.js";

// LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): pullNext's `find` (a source unit's own run) and `stock` (an outreach
// campaign fed by sources that find on their own) modes. The `serve` mode (today) is tests/unit/buffer.test.ts.
const serveNext = vi.fn();
// The candidate path (qualify before paying) has its own suite: tests/unit/candidate-serve.test.ts.
// Here every audience answers "not served through candidates", so pullNext uses serve-next.
vi.mock("../../src/lib/candidate-serve.js", () => ({ serveThroughCandidates: vi.fn(async () => null) }));
vi.mock("../../src/lib/serve-identity.js", () => ({ resolveServedIdentity: vi.fn(async () => null) }));

vi.mock("../../src/lib/people-client.js", () => ({
  serveNext: (...args: unknown[]) => serveNext(...args),
  isAudienceNotServeableError: (e: unknown) => e instanceof Error && e.message === "not serveable",
}));

const claimStockedLead = vi.fn();
const recordEmptyAnswer = vi.fn(async () => {});
const clearEmptyAnswer = vi.fn(async () => {});
vi.mock("../../src/lib/source-audience-walk.js", () => ({
  recordEmptyAnswer: (...a: unknown[]) => recordEmptyAnswer(...(a as [])),
  clearEmptyAnswer: (...a: unknown[]) => clearEmptyAnswer(...(a as [])),
}));
vi.mock("../../src/lib/source-stock.js", () => ({
  SOURCE_FOUND_STATUS_REASON: "source_found",
  claimStockedLead: (...args: unknown[]) => claimStockedLead(...args),
}));
const judgeSourceAudience = vi.fn();
vi.mock("../../src/lib/source-stock-belongs.js", () => ({
  createSourceAudienceJudge: () => (...args: unknown[]) => judgeSourceAudience(...args),
}));
const askAudienceFit = vi.fn();
vi.mock("../../src/lib/audience-fit-client.js", () => ({
  askAudienceFit: (...args: unknown[]) => askAudienceFit(...args),
}));

const getCurrentGoal = vi.fn();
vi.mock("../../src/lib/released-pool.js", () => ({ claimReleasedLead: vi.fn(async () => null) }));
vi.mock("../../src/lib/sourcing-origin.js", () => ({
  fetchAudienceOfferId: vi.fn(async () => null),
  AudienceOfferMismatchError: class extends Error {},
}));

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

// The `lead_found` outcome trigger (src/lib/outcome-triggers.ts) has its own suites: here only WHEN a serve rings it.
const noteLeadFound = vi.fn();
vi.mock("../../src/lib/outcome-triggers.js", () => ({
  noteLeadFound: (...args: unknown[]) => noteLeadFound(...args),
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
import { isAudienceExhaustedReason } from "../../src/lib/serve-reasons.js";

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
    // The source FOUND the person: lead_found rings under the source unit and its offer.
    expect(noteLeadFound).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-1", campaignId: UNIT, offerId: "offer-1" }));
  });

  it("every audience walked and empty = audience_exhausted (the one answer that means nobody left)", async () => {
    serveNext.mockResolvedValue({ status: "exhausted" });
    await expect(pullNext(findParams(["aud-1", "aud-2"]))).resolves.toEqual({ found: false, reason: "audience_exhausted" });
    expect(insertValues).not.toHaveBeenCalled();
    // Each empty answer is remembered so the next run asks the other audiences first.
    expect(recordEmptyAnswer).toHaveBeenCalledWith(expect.objectContaining({ audienceId: "aud-1", reason: "exhausted" }));
    expect(recordEmptyAnswer).toHaveBeenCalledWith(expect.objectContaining({ audienceId: "aud-2", reason: "exhausted" }));
  });

  it("an audience that cannot be walked yet is skipped; if the rest are empty it is NOT exhaustion", async () => {
    serveNext.mockRejectedValueOnce(new Error("not serveable")).mockResolvedValueOnce({ status: "exhausted" });
    await expect(pullNext(findParams(["aud-1", "aud-2"]))).resolves.toEqual({ found: false, reason: "audience_not_serveable" });
  });

  it("13 linkedin_engagement audiences whose competitor pages posted nothing = no_recent_posts, NOT exhaustion", async () => {
    // Doc Dinners 8d613bad (2026-10-13): ChiroCandy + MaxLiving had no post in the window.
    serveNext.mockResolvedValue({ status: "exhausted", person: null, reason: "no_recent_posts" });
    const ids = Array.from({ length: 13 }, (_, i) => `aud-${i + 1}`);
    const result = await pullNext(findParams(ids));
    expect(result).toEqual({ found: false, reason: "no_recent_posts" });
    expect(isAudienceExhaustedReason(result.reason)).toBe(false);
    expect(serveNext).toHaveBeenCalledTimes(13);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("real exhaustion mixed with no_recent_posts = no_recent_posts (a look found nothing to read, so not all walked out)", async () => {
    serveNext
      .mockResolvedValueOnce({ status: "exhausted", person: null })
      .mockResolvedValueOnce({ status: "exhausted", person: null, reason: "no_recent_posts" })
      .mockResolvedValueOnce({ status: "exhausted", person: null, reason: "pool_exhausted" });
    await expect(pullNext(findParams(["aud-1", "aud-2", "aud-3"]))).resolves.toEqual({ found: false, reason: "no_recent_posts" });
  });

  it("no_recent_posts beside an audience that cannot be walked = no_recent_posts", async () => {
    serveNext.mockRejectedValueOnce(new Error("not serveable")).mockResolvedValueOnce({ status: "exhausted", person: null, reason: "no_recent_posts" });
    await expect(pullNext(findParams(["aud-1", "aud-2"]))).resolves.toEqual({ found: false, reason: "no_recent_posts" });
  });

  it("every audience exhausted with another reason or none = still audience_exhausted", async () => {
    serveNext
      .mockResolvedValueOnce({ status: "exhausted", person: null, reason: "pool_exhausted" })
      .mockResolvedValueOnce({ status: "exhausted", person: null, reason: "yield_exhausted" })
      .mockResolvedValueOnce({ status: "exhausted", person: null });
    await expect(pullNext(findParams(["aud-1", "aud-2", "aud-3"]))).resolves.toEqual({ found: false, reason: "audience_exhausted" });
  });

  it("an audience with no recent posts is skipped and the next one still serves", async () => {
    serveNext.mockResolvedValueOnce({ status: "exhausted", person: null, reason: "no_recent_posts" }).mockResolvedValueOnce({ status: "served", person });
    const result = await pullNext(findParams(["aud-1", "aud-2"]));
    expect(result.found).toBe(true);
    expect(result.lead?.audienceId).toBe("aud-2");
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
      lead: {
        sourceRowId: "row-1",
        sourceCampaignId: UNIT,
        leadId: "lead-9",
        email: "x@acme.com",
        audienceId: "aud-7",
        buyingSignal: null,
        personId: null,
        goal: "signup",
      },
      setAside: [],
    });

    const result = await pullNext(stockParams());

    expect(result.found).toBe(true);
    expect(result.lead).toMatchObject({ leadId: "lead-9", email: "x@acme.com", audienceId: "aud-7", apolloPersonId: "ap-9" });
    expect(claimStockedLead).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", sourceCampaignIds: [UNIT], outreachCampaignId: "outreach-1", featureSlug: "sales-cold-email-outreach", runId: "run-1" }),
    );
    expect(serveNext).not.toHaveBeenCalled();
    expect(checksForWriter).toHaveBeenCalledWith({ leadId: "lead-9", apolloPersonId: "ap-9" }, [{ id: "c-bonus", mode: "mention" }], expect.anything());
    // A stocked find was FOUND by its source: handing it to the outreach pipe finds nobody new.
    expect(noteLeadFound).not.toHaveBeenCalled();
  });

  it("asks human-service, for the brand and org of the serve, whether each stocked find still fits its audience", async () => {
    claimStockedLead.mockResolvedValueOnce({ lead: null, setAside: [] });
    judgeSourceAudience.mockResolvedValueOnce({ belongs: true });
    askAudienceFit.mockResolvedValueOnce({ fits: false, reason: "Answered on WhatsApp" });
    await pullNext(stockParams());
    const { askFit } = claimStockedLead.mock.calls[0][0] as { askFit: (q: unknown) => Promise<unknown> };
    await expect(askFit({ sourceCampaignId: UNIT, audienceId: "aud-7", email: "x@acme.com", personId: "p-1" })).resolves.toEqual({ fits: false, reason: "Answered on WhatsApp" });
    expect(judgeSourceAudience).toHaveBeenCalledWith(UNIT, "aud-7");
    expect(askAudienceFit).toHaveBeenCalledWith(
      { audienceId: "aud-7", email: "x@acme.com", personId: "p-1", brandId: "brand-1" },
      expect.objectContaining({ orgId: "org-1", runId: "run-1" }),
    );
  });

  it("a pipe stating a stepFilter asks the still-fits question WITH it, verbatim (CRM-WARM-NURTURE-1015)", async () => {
    const stepFilter = { reached: ["form_submission"], notReached: ["sale", "disqualified"] };
    claimStockedLead.mockResolvedValueOnce({ lead: null, setAside: [] });
    judgeSourceAudience.mockResolvedValueOnce({ belongs: true });
    askAudienceFit.mockResolvedValueOnce({ fits: true });
    await pullNext({ ...stockParams(), stepFilter });
    const { askFit } = claimStockedLead.mock.calls[0][0] as { askFit: (q: unknown) => Promise<unknown> };
    await askFit({ sourceCampaignId: UNIT, audienceId: "aud-7", email: "x@acme.com", personId: null });
    expect(askAudienceFit).toHaveBeenCalledWith(
      { audienceId: "aud-7", email: "x@acme.com", personId: null, brandId: "brand-1", stepFilter },
      expect.objectContaining({ orgId: "org-1" }),
    );
  });

  it("a find that is not the holding source's own (another offer, origin or funnel audience) is set aside, human-service never asked", async () => {
    claimStockedLead.mockResolvedValueOnce({ lead: null, setAside: [] });
    judgeSourceAudience.mockResolvedValueOnce({ belongs: false, reason: "Found in audience aud-apollo, whose own list is sourcing-apollo-cold-filters" });
    await pullNext(stockParams());
    const { askFit } = claimStockedLead.mock.calls[0][0] as { askFit: (q: unknown) => Promise<unknown> };
    await expect(askFit({ sourceCampaignId: UNIT, audienceId: "aud-apollo", email: "x@acme.com", personId: null })).resolves.toEqual({
      fits: false,
      reason: "Found in audience aud-apollo, whose own list is sourcing-apollo-cold-filters",
    });
    expect(askAudienceFit).not.toHaveBeenCalled();
  });

  it("drains the outreach campaign's own paid pool FIRST, like every serve", async () => {
    pickRetryCandidate.mockResolvedValueOnce({ leadId: "lead-r", email: "r@x.co", retryCount: 0, goal: null, audienceId: null, buyingSignal: null, personId: null });
    const result = await pullNext(stockParams());
    expect(result.lead?.leadId).toBe("lead-r");
    expect(claimStockedLead).not.toHaveBeenCalled();
  });

  it("a pipe serving a source's stock and stating nothing takes the finds AS FOUND (the source chose its emails)", async () => {
    claimStockedLead.mockResolvedValueOnce({ lead: null, setAside: [] });
    await pullNext(stockParams());
    expect(pickRetryCandidate).toHaveBeenCalledWith(expect.objectContaining({ acceptedEmails: "as_found" }));
    expect(claimStockedLead).toHaveBeenCalledWith(expect.objectContaining({ acceptedEmails: "as_found" }));
  });

  it("a pipe serving a source's stock that STATES a policy keeps its own word on every pool", async () => {
    claimStockedLead.mockResolvedValueOnce({ lead: null, setAside: [] });
    await pullNext({ ...stockParams(), acceptedEmails: "valid_only" });
    expect(claimStockedLead).toHaveBeenCalledWith(expect.objectContaining({ acceptedEmails: "valid_only" }));
  });

  it("stock empty = source_stock_empty, never exhaustion, nothing found on demand", async () => {
    claimStockedLead.mockResolvedValueOnce({ lead: null, setAside: [] });
    await expect(pullNext(stockParams("aud-1"))).resolves.toEqual({ found: false, reason: "source_stock_empty" });
    expect(serveNext).not.toHaveBeenCalled();
  });
});
