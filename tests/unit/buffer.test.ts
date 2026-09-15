import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../src/lib/people-client.js";

const serveNext = vi.fn();
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
    // person persisted into silver
    expect(upsertLeadFromPerson).toHaveBeenCalledWith(person, { enriched: true });
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
});
