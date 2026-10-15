import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../src/lib/people-client.js";

const serveNext = vi.fn();
// The candidate path (qualify before paying) has its own suite: tests/unit/candidate-serve.test.ts.
// Here every audience answers "not served through candidates", so pullNext uses serve-next.
vi.mock("../../src/lib/candidate-serve.js", () => ({ serveThroughCandidates: vi.fn(async () => null) }));
vi.mock("../../src/lib/serve-identity.js", () => ({ resolveServedIdentity: vi.fn(async () => null) }));

vi.mock("../../src/lib/people-client.js", () => ({
  serveNext: (...args: unknown[]) => serveNext(...args),
}));

const getCurrentGoal = vi.fn();
vi.mock("../../src/lib/brand-client.js", () => ({
  getCurrentGoal: (...args: unknown[]) => getCurrentGoal(...args),
}));

const upsertLeadFromPerson = vi.fn();
const recordEmploymentHistory = vi.fn();
const registerServedEmail = vi.fn();
const upsertContactMethod = vi.fn(async () => ({ inserted: true }));
vi.mock("../../src/lib/leads-registry.js", () => ({
  upsertLeadFromPerson: (...args: unknown[]) => upsertLeadFromPerson(...args),
  recordEmploymentHistory: (...args: unknown[]) => recordEmploymentHistory(...args),
  registerServedEmail: (...args: unknown[]) => registerServedEmail(...args),
  upsertContactMethod: (...args: unknown[]) => upsertContactMethod(...args),
}));

// Released people (src/lib/released-pool.ts) have their own suite: here nobody was released.
const claimReleasedLead = vi.fn(async () => null);
vi.mock("../../src/lib/released-pool.js", () => ({
  claimReleasedLead: (...args: unknown[]) => claimReleasedLead(...(args as [])),
}));

// The audience's offer (human-service): brand-wide unless a test says otherwise.
const fetchAudienceOfferId = vi.fn(async () => null as string | null);
vi.mock("../../src/lib/sourcing-origin.js", () => ({
  fetchAudienceOfferId: (...args: unknown[]) => fetchAudienceOfferId(...(args as [])),
  AudienceOfferMismatchError: class extends Error {
    constructor(a: string, b: string, c: string) {
      super(`audience ${a} belongs to offer ${b}, the campaign sells offer ${c}`);
    }
  },
}));

// Tactic "Fresh contacts only" (FRESH-CONTACTS-1015): its SQL runs in tests/integration/recently-emailed-sql.test.ts.
const leadRecentlyEmailed = vi.fn(async () => false);
const assertRecentlyEmailedReadable = vi.fn(async () => undefined);
vi.mock("../../src/lib/recently-emailed.js", () => ({
  leadRecentlyEmailed: (...args: unknown[]) => leadRecentlyEmailed(...(args as [])),
  assertRecentlyEmailedReadable: (...args: unknown[]) => assertRecentlyEmailedReadable(...(args as [])),
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

const baseParams = {
  orgId: "org-1",
  campaignId: "campaign-1",
  brandIds: ["brand-1"],
  brandId: "brand-1",
  featureSlug: "lead-finder-v1",
  runFeatureSlug: "sourcing-apollo-cold-filters",
  runId: "run-1",
  userId: "user-1",
  // Audience is selected by campaign-service and arrives as x-audience-id.
  audienceId: "aud-1",
};

describe("pullNext (audience serve-next flow)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // goal is brand-owned — default the brand-service lookup to "signup".
    getCurrentGoal.mockResolvedValue("signup");
    // Default: nobody in the already-paid pool, so the serve-next path is exercised
    // exactly as it was before the pool existed.
    pickRetryCandidate.mockResolvedValue(null);
    // Default: an offer-less campaign — the goal read stays brand-scoped, byte-identically.
    fetchCampaign.mockResolvedValue({ id: "campaign-1", offerId: null });
    offerChecks.mockResolvedValue([]);
    checksForWriter.mockResolvedValue({ domain: null, checks: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("serves the next person of the x-audience-id audience, records it, returns FullLead", async () => {
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1", firstName: "Sara" });

    const result = await pullNext(baseParams);

    // serve-next consumed for the campaign-selected audience, attributed to it
    expect(serveNext).toHaveBeenCalledWith("aud-1", expect.objectContaining({ audienceId: "aud-1" }));
    // what the serve buys downstream is labelled with the SOURCING origin...
    expect(serveNext).toHaveBeenCalledWith(
      "aud-1",
      expect.objectContaining({ featureSlug: "sourcing-apollo-cold-filters" }),
    );
    // ...while the lead row keeps the OUTREACH channel it was served for
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ featureSlug: "lead-finder-v1" }));
    // person persisted into silver
    expect(upsertLeadFromPerson).toHaveBeenCalledWith(person, { enriched: true, identity: null });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "lead-1", status: "served", audienceId: "aud-1" }),
    );

    expect(result.found).toBe(true);
    expect(result.lead?.leadId).toBe("lead-1");
    expect(result.lead?.email).toBe("sara@cascobay.com");
    expect(result.lead?.audienceId).toBe("aud-1");
    expect(result.lead?.apolloPersonId).toBe("apollo-person-1");
    expect(result.lead?.data).toEqual({ leadId: "lead-1", firstName: "Sara" });
  });

  it("a person qualified and revealed through candidates is recorded the same way, and serve-next is never asked", async () => {
    const { serveThroughCandidates } = await import("../../src/lib/candidate-serve.js");
    vi.mocked(serveThroughCandidates).mockResolvedValueOnce({ status: "served", person, personId: "8d2f6c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b" });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    const result = await pullNext(baseParams);

    expect(serveThroughCandidates).toHaveBeenCalledWith("aud-1", expect.objectContaining({ audienceId: "aud-1", orgId: "org-1" }), null, undefined);
    expect(serveNext).not.toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-1", status: "served", personId: "8d2f6c1e-3b4a-4f5e-9a7b-1c2d3e4f5a6b" }));
    expect(result.found).toBe(true);
  });

  it("fetches the brand goal and uses it for attribution/storage (NOT for selection)", async () => {
    getCurrentGoal.mockResolvedValueOnce("meetingBooked");
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    const result = await pullNext(baseParams);

    // goal came from brand-service for THIS brand, not from a caller input.
    // Offer-less campaign (the default fixture) keeps the brand-scoped read.
    expect(getCurrentGoal).toHaveBeenCalledWith("brand-1", "org-1", expect.any(Object), null);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ goal: "meetingBooked", audienceId: "aud-1" }));
    expect(result.lead?.goal).toBe("meetingBooked");
  });

  it("returns found=false WITHOUT serving or fetching goal when no x-audience-id is supplied", async () => {
    const result = await pullNext({ ...baseParams, audienceId: undefined });

    // Empty because nobody was named to look at — NOT because anybody ran out. A brand-new
    // campaign's very first ask lands here, and the caller stops a campaign for good if it
    // reads this as exhaustion (campaign 4769db14, 2026-08-20 10:08: 26ms, no audience id,
    // stopped `audience_exhausted` while its sibling served 109 leads for the same brand
    // that day). So the reason must never be the exhausted one.
    expect(result).toEqual({ found: false, reason: "no_audience" });
    expect(result.reason).not.toBe("audience_exhausted");
    expect(getCurrentGoal).not.toHaveBeenCalled();
    expect(serveNext).not.toHaveBeenCalled();
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("fails loud when the brand has no goal set (brand-service throws)", async () => {
    getCurrentGoal.mockRejectedValueOnce(
      new Error("[brand-client] runtime-context failed for brand brand-1: 404 Brand not found"),
    );

    await expect(pullNext(baseParams)).rejects.toThrow(/runtime-context failed/);
    expect(serveNext).not.toHaveBeenCalled();
  });

  it("scopes the goal read on the OFFER the campaign sells (multi-offer brand)", async () => {
    // A brand selling several offers refuses brand-scoped reads (409 SEVERAL_OFFERS),
    // so the goal read must name the campaign's own offer — read off the campaign row,
    // never guessed.
    fetchCampaign.mockResolvedValueOnce({ id: "campaign-1", offerId: "offer-9" });
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    await pullNext(baseParams);

    expect(getCurrentGoal).toHaveBeenCalledWith("brand-1", "org-1", expect.any(Object), "offer-9");
    // The same offer decides which must-pass checks the candidate serve applies.
    const { serveThroughCandidates } = await import("../../src/lib/candidate-serve.js");
    expect(serveThroughCandidates).toHaveBeenCalledWith("aud-1", expect.any(Object), "offer-9", undefined);
  });

  it("falls back to brand scope (which fails loud on a multi-offer brand) when the campaign cannot be read", async () => {
    // Fail-soft on the offer resolution — campaign-service must not become a new hard
    // dependency of the serve path — because the loud guard is the goal read itself:
    // without an offer, brand-service answers 409 SEVERAL_OFFERS verbatim.
    fetchCampaign.mockRejectedValueOnce(new Error("campaign-service unreachable"));
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    await pullNext(baseParams);

    expect(getCurrentGoal).toHaveBeenCalledWith("brand-1", "org-1", expect.any(Object), null);
  });

  it("returns found=false when serve-next reports the audience exhausted", async () => {
    serveNext.mockResolvedValueOnce({ status: "exhausted", person: null });

    const result = await pullNext(baseParams);

    // The audience WAS walked and came back empty — the one empty answer that is
    // evidence about a population, and the only one a caller may act on terminally.
    expect(result).toEqual({ found: false, reason: "audience_exhausted" });
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("reads an exhausted serve-next whose competitor pages posted nothing as no_recent_posts, never exhausted", async () => {
    serveNext.mockResolvedValueOnce({ status: "exhausted", person: null, reason: "no_recent_posts" });

    const result = await pullNext(baseParams);

    expect(result).toEqual({ found: false, reason: "no_recent_posts" });
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("reads a pending serve-next (producer budget spent mid-walk) as timed out, never exhausted", async () => {
    // Shockwavecenters 2026-10-04: the teaser screen rejected ~99.7% of an audience, so
    // one serve-next walked 700+ teasers and outran our 300s client timeout. human-service
    // now stops at its own budget and answers `pending`; the walk resumes on the next call.
    serveNext.mockResolvedValueOnce({ status: "pending", person: null });

    const result = await pullNext(baseParams);

    expect(result).toEqual({ found: false, reason: "serve_timed_out" });
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("names a timed-out look as timed out, never as an exhausted audience", async () => {
    // The serve budget expired before serve-next answered. An unfinished look says
    // nothing about who is left, so it must not arrive looking like exhaustion.
    const result = await pullNext(baseParams, AbortSignal.abort());

    expect(result).toEqual({ found: false, reason: "serve_timed_out" });
    expect(serveNext).not.toHaveBeenCalled();
    expect(getCurrentGoal).not.toHaveBeenCalled();
  });

  it("gives exactly one empty answer that means exhaustion, and it is the walked one", async () => {
    // Guards the distinction itself rather than any single branch: if a future empty
    // answer starts claiming exhaustion, this fails.
    const noAudience = await pullNext({ ...baseParams, audienceId: undefined });
    const timedOut = await pullNext(baseParams, AbortSignal.abort());
    serveNext.mockResolvedValueOnce({ status: "exhausted", person: null });
    const exhausted = await pullNext(baseParams);

    const exhaustedClaims = [noAudience, timedOut, exhausted].filter(
      (r) => r.reason === "audience_exhausted",
    );
    expect(exhaustedClaims).toEqual([exhausted]);
    // and every empty answer says something — silence is what made them identical.
    for (const r of [noAudience, timedOut, exhausted]) {
      expect(r.found).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });

  it("records the serve against the lead that owns the email, never an email-less lead", async () => {
    // The person's email already belongs to an older lead row. The global
    // one-email-one-lead index means no other lead can ever carry it, so the
    // membership row MUST land on the owning lead — otherwise the delivery
    // status (keyed on the registered email) can never resolve.
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-provider-id-owner");
    registerServedEmail.mockResolvedValueOnce("lead-email-owner");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-email-owner" });

    const result = await pullNext(baseParams);

    expect(registerServedEmail).toHaveBeenCalledWith({
      leadId: "lead-provider-id-owner",
      email: "sara@cascobay.com",
      status: "verified",
      source: "apollo",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: "lead-email-owner", status: "served" }),
    );
    expect(recordEmploymentHistory).toHaveBeenCalledWith({ leadId: "lead-email-owner", person });
    expect(buildFullLead).toHaveBeenCalledWith("lead-email-owner");
    expect(result.lead?.leadId).toBe("lead-email-owner");
    expect(result.lead?.email).toBe("sara@cascobay.com");
  });

  it("fails loud when the email cannot be registered at all (no silent email-less serve)", async () => {
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    registerServedEmail.mockRejectedValueOnce(
      new Error("[lead-service] email sara@cascobay.com hit the global one-email-one-lead index"),
    );

    await expect(pullNext(baseParams)).rejects.toThrow(/one-email-one-lead/);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("fails loud when serve-next returns status=served but no email", async () => {
    serveNext.mockResolvedValueOnce({ status: "served", person: { ...person, email: null } });

    await expect(pullNext(baseParams)).rejects.toThrow(/served without an email/);
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("drains the already-paid pool BEFORE buying anyone new", async () => {
    // This person was served for this campaign, billed, and never handed to the vendor.
    // human-service will never offer them again (they are suppressed for the brand for
    // three months), so if this pull buys someone new instead, the brand has paid for a
    // prospect it can no longer reach.
    pickRetryCandidate.mockResolvedValueOnce({
      id: "lc-1",
      leadId: "lead-paid",
      email: "stranded@cascobay.com",
      servedAt: "2026-08-25T09:00:00.000Z",
      audienceId: "aud-original",
      goal: "meetingBooked",
      retryCount: 0,
    });
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-paid", apolloPersonId: "apollo-9" });

    const result = await pullNext(baseParams);

    expect(result.found).toBe(true);
    expect(result.lead?.leadId).toBe("lead-paid");
    expect(result.lead?.email).toBe("stranded@cascobay.com");
    // The audience and goal the paid serve was recorded against, not a fresh guess.
    expect(result.lead?.audienceId).toBe("aud-original");
    expect(result.lead?.goal).toBe("meetingBooked");
    expect(result.lead?.apolloPersonId).toBe("apollo-9");

    // Nothing was bought and no new lifecycle row was written: this person already has one.
    expect(serveNext).not.toHaveBeenCalled();
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("keeps the buying signal the served person carried, on the serve row and on the lead", async () => {
    const signal = {
      type: "hiring",
      occurredOn: "2026-09-21",
      fact: "Acme Clinics posted a job for Office Manager (Austin, United States) on September 21, 2026",
      source: "apollo:job_postings",
      sourceUrl: "https://example.com/jobs/1",
    };
    serveNext.mockResolvedValueOnce({ status: "served", person: { ...person, buyingSignal: signal } });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    const result = await pullNext(baseParams);

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ buyingSignal: signal }));
    expect(result.lead?.buyingSignal).toEqual(signal);
  });

  it("serves and persists a linkedin_engagement signal with its engagement evidence", async () => {
    const signal = {
      type: "linkedin_engagement",
      occurredOn: "2026-09-28",
      fact: "Dana Ruiz commented on a LinkedIn post by Rival Co on September 28, 2026",
      source: "linkedin:company/rival-co",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1",
      engagement: {
        competitorPage: "https://www.linkedin.com/company/rival-co",
        postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1",
        postPublishedOn: "2026-09-27",
        kind: "comment",
        reactionType: null,
        commentText: "Great insight",
        commentedAt: "2026-09-28",
      },
    };
    serveNext.mockResolvedValueOnce({ status: "served", person: { ...person, buyingSignal: signal } });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    const result = await pullNext(baseParams);

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ buyingSignal: signal }));
    expect(result.lead?.buyingSignal).toEqual(signal);
  });

  it("a person with no signal serves exactly as before: null, never a default", async () => {
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    const result = await pullNext(baseParams);

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ buyingSignal: null }));
    expect(result.lead?.buyingSignal).toBeNull();
  });

  it("fails the serve loudly on a malformed signal, before writing anything", async () => {
    serveNext.mockResolvedValueOnce({
      status: "served",
      person: { ...person, buyingSignal: { type: "hiring", occurredOn: "2026-09-21", source: "apollo" } },
    });

    await expect(pullNext(baseParams)).rejects.toThrow(/malformed buyingSignal/);
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("a retried serve hands out the signal stored on its original serve", async () => {
    const signal = {
      type: "funding",
      occurredOn: "2026-09-02",
      fact: "Acme raised a Series A on September 2, 2026",
      source: "apollo:funding_events",
      sourceUrl: null,
    };
    pickRetryCandidate.mockResolvedValueOnce({
      id: "lc-1",
      leadId: "lead-paid",
      email: "stranded@cascobay.com",
      servedAt: "2026-08-25T09:00:00.000Z",
      audienceId: "aud-original",
      buyingSignal: signal,
      goal: "meetingBooked",
      retryCount: 0,
    });
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-paid" });

    const result = await pullNext(baseParams);

    expect(result.lead?.buyingSignal).toEqual(signal);
    expect(serveNext).not.toHaveBeenCalled();
  });

  describe("personId: which human-service person the served lead is", () => {
    const humanPersonId = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

    function mockRecordPath() {
      upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
      recordEmploymentHistory.mockResolvedValueOnce(undefined);
      registerServedEmail.mockResolvedValueOnce("lead-1");
      buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });
    }

    it("a person served via human-service carries its person id, on the serve row and on the lead", async () => {
      serveNext.mockResolvedValueOnce({ status: "served", person, personId: humanPersonId });
      mockRecordPath();

      const result = await pullNext(baseParams);

      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ personId: humanPersonId }));
      expect(result.lead?.personId).toBe(humanPersonId);
      // A different concept from the lead: never aliased onto leadId.
      expect(result.lead?.leadId).toBe("lead-1");
    });

    it("a person served without one omits it: serve succeeds, no key, never derived from leadId", async () => {
      serveNext.mockResolvedValueOnce({ status: "served", person });
      mockRecordPath();

      const result = await pullNext(baseParams);

      expect(result.found).toBe(true);
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ personId: null }));
      expect(result.lead).not.toHaveProperty("personId");
      expect(JSON.parse(JSON.stringify(result)).lead).not.toHaveProperty("personId");
    });

    it("an explicit null from the producer is the same as absent", async () => {
      serveNext.mockResolvedValueOnce({ status: "served", person, personId: null });
      mockRecordPath();

      const result = await pullNext(baseParams);

      expect(result.found).toBe(true);
      expect(result.lead).not.toHaveProperty("personId");
    });

    it("fails the serve loudly on a malformed person id, before writing anything", async () => {
      serveNext.mockResolvedValueOnce({ status: "served", person, personId: "lead-1" });

      await expect(pullNext(baseParams)).rejects.toThrow(/malformed personId/);
      expect(upsertLeadFromPerson).not.toHaveBeenCalled();
      expect(insertValues).not.toHaveBeenCalled();
    });

    it("a retried serve hands out the person stored on its original serve, and omits it when none was", async () => {
      const candidate = {
        id: "lc-1",
        leadId: "lead-paid",
        email: "stranded@cascobay.com",
        servedAt: "2026-08-25T09:00:00.000Z",
        audienceId: "aud-original",
        buyingSignal: null,
        goal: "meetingBooked",
        retryCount: 0,
      };
      pickRetryCandidate.mockResolvedValueOnce({ ...candidate, personId: humanPersonId });
      buildFullLead.mockResolvedValueOnce({ leadId: "lead-paid" });
      expect((await pullNext(baseParams)).lead?.personId).toBe(humanPersonId);

      pickRetryCandidate.mockResolvedValueOnce({ ...candidate, personId: null });
      buildFullLead.mockResolvedValueOnce({ leadId: "lead-paid" });
      expect((await pullNext(baseParams)).lead).not.toHaveProperty("personId");
    });
  });

  it("passes the claiming run to the pool so the retry is attributed to it", async () => {
    pickRetryCandidate.mockResolvedValueOnce(null);
    serveNext.mockResolvedValueOnce({ status: "exhausted", person: null });

    await pullNext(baseParams);

    expect(pickRetryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        campaignId: "campaign-1",
        brandId: "brand-1",
        runId: "run-1",
      }),
    );
  });

  it("never consults the pool when the caller named no audience", async () => {
    // Same early return as before: this service does not pick audiences, so an absent
    // x-audience-id is a run that was told to serve nobody.
    const result = await pullNext({ ...baseParams, audienceId: undefined });

    expect(result).toEqual({ found: false, reason: "no_audience" });
    expect(pickRetryCandidate).not.toHaveBeenCalled();
  });
  describe("check results for the email writer", () => {
    const bonus = { id: "crit-bonus", mode: "mention", enabled: true };
    const filter = { id: "crit-filter", mode: "must_pass", enabled: true };
    const qualification = {
      domain: "cascobay.com",
      checks: [{ criterionId: "crit-bonus", mode: "mention", verdict: "no", evidence: "Last LinkedIn post 5 months ago." }],
    };

    it("runs the offer's checks only AFTER the person is served and recorded, and hands every result out", async () => {
      fetchCampaign.mockResolvedValue({ id: "campaign-1", offerId: "offer-1" });
      offerChecks.mockResolvedValue([filter, bonus]);
      checksForWriter.mockResolvedValue(qualification);
      serveNext.mockResolvedValueOnce({ status: "served", person });
      upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
      registerServedEmail.mockResolvedValueOnce("lead-1");
      buildFullLead.mockResolvedValueOnce({ leadId: "lead-1", organization: { primaryDomain: "cascobay.com" } });

      const result = await pullNext(baseParams);

      expect(offerChecks).toHaveBeenCalledWith("org-1", "brand-1", "offer-1");
      expect(checksForWriter).toHaveBeenCalledWith(
        { leadId: "lead-1", organization: { primaryDomain: "cascobay.com" } },
        [filter, bonus],
        // Spend rides the serve's run, labelled like the must-pass spend.
        expect.objectContaining({ orgId: "org-1", runId: "run-1", userId: "user-1", campaignId: "campaign-1", featureSlug: "sourcing-apollo-cold-filters" }),
      );
      // Bonus spend only once someone was actually served and recorded.
      expect(serveNext.mock.invocationCallOrder[0]).toBeLessThan(checksForWriter.mock.invocationCallOrder[0]);
      expect(insertValues.mock.invocationCallOrder[0]).toBeLessThan(checksForWriter.mock.invocationCallOrder[0]);
      expect(result.lead?.qualification).toEqual(qualification);
    });

    it("never runs a check for nobody: an empty serve pays for no Bonus check", async () => {
      offerChecks.mockResolvedValue([bonus]);
      serveNext.mockResolvedValueOnce({ status: "exhausted", person: null });

      const result = await pullNext(baseParams);

      expect(result.found).toBe(false);
      expect(checksForWriter).not.toHaveBeenCalled();
    });

    it("hands the check results out on a re-served paid lead too", async () => {
      offerChecks.mockResolvedValue([bonus]);
      checksForWriter.mockResolvedValue(qualification);
      pickRetryCandidate.mockResolvedValueOnce({ id: "lc-1", leadId: "lead-paid", email: "stranded@cascobay.com", audienceId: "aud-1", goal: "signup", retryCount: 0 });
      buildFullLead.mockResolvedValueOnce({ leadId: "lead-paid" });

      const result = await pullNext(baseParams);

      expect(checksForWriter).toHaveBeenCalledWith({ leadId: "lead-paid" }, [bonus], expect.objectContaining({ runId: "run-1" }));
      expect(result.lead?.qualification).toEqual(qualification);
    });
  });
});

describe("pullNext for a pipe: reach, sources, released people (owner 2026-10-12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentGoal.mockResolvedValue("signup");
    pickRetryCandidate.mockResolvedValue(null);
    fetchCampaign.mockResolvedValue({ id: "campaign-1", offerId: null });
    offerChecks.mockResolvedValue([]);
    checksForWriter.mockResolvedValue({ domain: null, checks: [] });
    claimReleasedLead.mockResolvedValue(null);
    fetchAudienceOfferId.mockResolvedValue(null);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function served(p: Person) {
    serveNext.mockResolvedValueOnce({ status: "served", person: p });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce("lead-1");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });
  }

  it("a WhatsApp pipe asks human-service for people reachable by phone, every pool too, and records the phone served", async () => {
    served({ ...person, provider: "apollo", phone: "+33612345678" });
    const result = await pullNext({ ...baseParams, featureSlug: "cold-whatsapp-outreach", reachableBy: ["phone"] });
    expect(result.found).toBe(true);
    expect(serveNext).toHaveBeenCalledWith("aud-1", expect.objectContaining({ reachableBy: ["phone"] }));
    expect(pickRetryCandidate).toHaveBeenCalledWith(expect.objectContaining({ reachableBy: ["phone"] }));
    expect(claimReleasedLead).toHaveBeenCalledWith(expect.objectContaining({ reachableBy: ["phone"] }));
    expect(upsertContactMethod).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-1", channel: "phone", value: "+33612345678" }));
  });

  // WA-RESERVE-LOOP-1014: the pool of a pipe that does not write by email asks the channel's sender, not email-gateway.
  it("a pipe whose channel does not write by email hands its pool sender to the retry pool; absent stays absent", async () => {
    served({ ...person, provider: "apollo", phone: "+33612345678" });
    await pullNext({ ...baseParams, featureSlug: "cold-whatsapp-outreach", reachableBy: ["phone"], poolSender: "channel" });
    expect(pickRetryCandidate).toHaveBeenCalledWith(expect.objectContaining({ sender: "channel" }));
    served(person);
    await pullNext(baseParams);
    expect(pickRetryCandidate.mock.calls[1][0]).not.toHaveProperty("sender");
  });

  it("an email pipe asks for email", async () => {
    served(person);
    await pullNext({ ...baseParams, featureSlug: "sales-cold-email-outreach", reachableBy: ["email"] });
    expect(serveNext).toHaveBeenCalledWith("aud-1", expect.objectContaining({ reachableBy: ["email"] }));
    expect(upsertContactMethod).not.toHaveBeenCalled();
  });

  it("no requirement stated: the serve context carries none", async () => {
    served(person);
    await pullNext(baseParams);
    expect(serveNext.mock.calls[0][1]).not.toHaveProperty("reachableBy");
  });

  it("an audience whose origin does not feed the pipe: no fresh serve, the reason says so", async () => {
    const result = await pullNext({
      ...baseParams,
      reachableBy: ["phone"],
      freshServeRefused: { reason: "origin_not_fed", detail: "apollo does not feed whatsapp" },
    });
    expect(result).toEqual({ found: false, reason: "origin_not_fed" });
    expect(serveNext).not.toHaveBeenCalled();
    // The campaign's own pools were still asked first.
    expect(pickRetryCandidate).toHaveBeenCalled();
  });

  it("an audience of ANOTHER offer than the campaign's is never served", async () => {
    fetchCampaign.mockResolvedValue({ id: "campaign-1", offerId: "offer-a" });
    fetchAudienceOfferId.mockResolvedValue("offer-b");
    const result = await pullNext(baseParams);
    expect(result).toEqual({ found: false, reason: "audience_offer_mismatch" });
    expect(serveNext).not.toHaveBeenCalled();
  });

  // CRM-WARM-NURTURE-1015: the pipe's step filter rides every fresh serve; a released person is never vouched for.
  it("a stepFilter rides the fresh serve verbatim and the released pool is never asked", async () => {
    const stepFilter = { reached: ["meeting_booked"], notReached: ["sale"] };
    served(person);
    const result = await pullNext({ ...baseParams, stepFilter });
    expect(result.found).toBe(true);
    expect(serveNext).toHaveBeenCalledWith("aud-1", expect.objectContaining({ stepFilter }));
    expect(claimReleasedLead).not.toHaveBeenCalled();
  });

  it("no stepFilter: none in the serve context, the released pool asked as today", async () => {
    served(person);
    await pullNext(baseParams);
    expect(serveNext.mock.calls[0][1]).not.toHaveProperty("stepFilter");
    expect(claimReleasedLead).toHaveBeenCalled();
  });

  it("a person another pipe released is taken before anyone is bought", async () => {
    claimReleasedLead.mockResolvedValueOnce({
      releasedRowId: "row-0",
      releasedFromCampaignId: "whatsapp-campaign",
      leadId: "lead-9",
      email: "j@mii.md",
      audienceId: "aud-apollo",
      buyingSignal: null,
      personId: null,
      goal: null,
    } as never);
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-9" });
    const result = await pullNext({ ...baseParams, featureSlug: "sales-cold-email-outreach", reachableBy: ["email"] });
    expect(result.found).toBe(true);
    expect(result.lead?.leadId).toBe("lead-9");
    expect(serveNext).not.toHaveBeenCalled();
  });
});

describe("pullNext with the tactic \"Fresh contacts only\" (FRESH-CONTACTS-1015)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentGoal.mockResolvedValue("signup");
    pickRetryCandidate.mockResolvedValue(null);
    fetchCampaign.mockResolvedValue({ id: "campaign-1", offerId: null });
    offerChecks.mockResolvedValue([]);
    checksForWriter.mockResolvedValue({ domain: null, checks: [] });
    claimReleasedLead.mockResolvedValue(null);
    fetchAudienceOfferId.mockResolvedValue(null);
    leadRecentlyEmailed.mockResolvedValue(false);
    assertRecentlyEmailedReadable.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function served(leadId: string, email: string) {
    serveNext.mockResolvedValueOnce({ status: "served", person: { ...person, email } });
    upsertLeadFromPerson.mockResolvedValueOnce(leadId);
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    registerServedEmail.mockResolvedValueOnce(leadId);
  }

  it("never hands out a person the brand emailed recently: kept filed under the campaign, the next one is bought", async () => {
    served("lead-emailed", "emailed@x.com");
    served("lead-fresh", "fresh@x.com");
    leadRecentlyEmailed.mockImplementation((async (leadId: string) => leadId === "lead-emailed") as never);
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-fresh" });

    const result = await pullNext({ ...baseParams, excludeEmailedWithin: "3_months" });

    expect(result.found).toBe(true);
    expect(result.lead?.leadId).toBe("lead-fresh");
    expect(result.lead?.email).toBe("fresh@x.com");
    expect(serveNext).toHaveBeenCalledTimes(2);
    expect(leadRecentlyEmailed).toHaveBeenCalledWith("lead-emailed", { window: "3_months", brandIds: ["brand-1"] });
    // The skipped person is NOT burnt: filed under the asking campaign (its paid pool hands them out later).
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-emailed", campaignId: "campaign-1", status: "served" }));
    // No Bonus check paid and no lead built for the skipped person.
    expect(buildFullLead).toHaveBeenCalledTimes(1);
    expect(checksForWriter).toHaveBeenCalledTimes(1);
  });

  it("every pool is asked with the window: this campaign's paid pool and released people", async () => {
    served("lead-fresh", "fresh@x.com");
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-fresh" });
    await pullNext({ ...baseParams, excludeEmailedWithin: "3_months" });
    const scope = { window: "3_months", brandIds: ["brand-1"] };
    expect(pickRetryCandidate).toHaveBeenCalledWith(expect.objectContaining({ recentlyEmailed: scope }));
    expect(claimReleasedLead).toHaveBeenCalledWith(expect.objectContaining({ recentlyEmailed: scope }));
    expect(assertRecentlyEmailedReadable).toHaveBeenCalledTimes(1);
  });

  it("stops after FRESH_SERVE_ATTEMPTS people all emailed recently: found false, recently_emailed (not exhaustion)", async () => {
    for (let i = 0; i < 5; i++) served(`lead-${i}`, `p${i}@x.com`);
    leadRecentlyEmailed.mockResolvedValue(true);
    const result = await pullNext({ ...baseParams, excludeEmailedWithin: "3_months" });
    expect(result).toEqual({ found: false, reason: "recently_emailed" });
    expect(serveNext).toHaveBeenCalledTimes(5);
    expect(buildFullLead).not.toHaveBeenCalled();
  });

  it("a copy of the sender's facts that never caught up fails the serve before anything is bought", async () => {
    assertRecentlyEmailedReadable.mockRejectedValueOnce(new Error("not caught up"));
    await expect(pullNext({ ...baseParams, excludeEmailedWithin: "3_months" })).rejects.toThrow("not caught up");
    expect(serveNext).not.toHaveBeenCalled();
    expect(pickRetryCandidate).not.toHaveBeenCalled();
  });

  it("not asked: today's serve, a recently emailed person is handed out, nothing is looked up", async () => {
    served("lead-emailed", "emailed@x.com");
    leadRecentlyEmailed.mockResolvedValue(true);
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-emailed" });
    const result = await pullNext(baseParams);
    expect(result.found).toBe(true);
    expect(result.lead?.leadId).toBe("lead-emailed");
    expect(serveNext).toHaveBeenCalledTimes(1);
    expect(leadRecentlyEmailed).not.toHaveBeenCalled();
    expect(assertRecentlyEmailedReadable).not.toHaveBeenCalled();
    expect(pickRetryCandidate).toHaveBeenCalledWith(expect.objectContaining({ recentlyEmailed: null }));
  });
});
