import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../../src/lib/people-client.js";

const getTopAudienceId = vi.fn();
vi.mock("../../src/lib/features-client.js", () => ({
  getTopAudienceId: (...args: unknown[]) => getTopAudienceId(...args),
}));

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
const upsertContactMethod = vi.fn();
vi.mock("../../src/lib/leads-registry.js", () => ({
  upsertLeadFromPerson: (...args: unknown[]) => upsertLeadFromPerson(...args),
  recordEmploymentHistory: (...args: unknown[]) => recordEmploymentHistory(...args),
  upsertContactMethod: (...args: unknown[]) => upsertContactMethod(...args),
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
};

describe("pullNext (audience serve-next flow)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // goal is brand-owned — default the brand-service lookup to "signup".
    getCurrentGoal.mockResolvedValue("signup");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("fetches the goal from brand-service and uses it for the audience + attribution", async () => {
    getCurrentGoal.mockResolvedValueOnce("meetingBooked");
    getTopAudienceId.mockResolvedValueOnce("aud-1");
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    upsertContactMethod.mockResolvedValueOnce({ inserted: true });
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1" });

    const result = await pullNext(baseParams);

    // goal came from brand-service for THIS brand, not from a caller input
    expect(getCurrentGoal).toHaveBeenCalledWith("brand-1", "org-1", expect.any(Object));
    expect((getTopAudienceId.mock.calls[0][0] as Record<string, unknown>).goal).toBe("meetingBooked");
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ goal: "meetingBooked" }));
    expect(result.lead?.goal).toBe("meetingBooked");
  });

  it("fails loud when the brand has no goal set (brand-service throws)", async () => {
    getCurrentGoal.mockRejectedValueOnce(
      new Error("[brand-client] runtime-context failed for brand brand-1: 404 Brand not found"),
    );

    await expect(pullNext(baseParams)).rejects.toThrow(/runtime-context failed/);
    expect(getTopAudienceId).not.toHaveBeenCalled();
  });

  it("resolves the audience, serves the next person, records it, and returns FullLead", async () => {
    getTopAudienceId.mockResolvedValueOnce("aud-1");
    serveNext.mockResolvedValueOnce({ status: "served", person });
    upsertLeadFromPerson.mockResolvedValueOnce("lead-1");
    recordEmploymentHistory.mockResolvedValueOnce(undefined);
    upsertContactMethod.mockResolvedValueOnce({ inserted: true });
    buildFullLead.mockResolvedValueOnce({ leadId: "lead-1", firstName: "Sara" });

    const result = await pullNext(baseParams);

    // audience came from features top row
    const featuresArg = getTopAudienceId.mock.calls[0][0] as Record<string, unknown>;
    expect(featuresArg).toMatchObject({ featureSlug: "lead-finder-v1", brandId: "brand-1", goal: "signup" });
    // serve-next consumed for that audience id, attributed to it
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

  it("returns found=false without calling serve-next when the brand/goal has no audience", async () => {
    getTopAudienceId.mockResolvedValueOnce(null);

    const result = await pullNext(baseParams);

    expect(result).toEqual({ found: false });
    expect(serveNext).not.toHaveBeenCalled();
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("returns found=false when serve-next reports the audience exhausted", async () => {
    getTopAudienceId.mockResolvedValueOnce("aud-1");
    serveNext.mockResolvedValueOnce({ status: "exhausted", person: null });

    const result = await pullNext(baseParams);

    expect(result).toEqual({ found: false });
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });

  it("fails loud when serve-next returns status=served but no email", async () => {
    getTopAudienceId.mockResolvedValueOnce("aud-1");
    serveNext.mockResolvedValueOnce({ status: "served", person: { ...person, email: null } });

    await expect(pullNext(baseParams)).rejects.toThrow(/served without an email/);
    expect(upsertLeadFromPerson).not.toHaveBeenCalled();
  });
});
