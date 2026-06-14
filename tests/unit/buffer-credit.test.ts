import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  count: () => ({ op: "count" }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
}));

const sql = vi.fn();
const findLead = vi.fn();
const selectLimit = vi.fn();
const updateSet = vi.fn();
const updateWhere = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      leads: {
        findFirst: (...args: unknown[]) => findLead(...args),
      },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: (...args: unknown[]) => selectLimit(...args),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        updateSet(...args);
        return {
          where: (...whereArgs: unknown[]) => updateWhere(...whereArgs),
        };
      },
    }),
  },
  sql: (...args: unknown[]) => sql(...args),
}));

vi.mock("../../src/db/schema.js", () => ({
  leads: { id: "leads.id" },
  leadsCampaigns: {
    id: "leads_campaigns.id",
    status: "leads_campaigns.status",
    campaignId: "leads_campaigns.campaign_id",
    orgId: "leads_campaigns.org_id",
  },
  leadsOrganizations: { leadId: "lo.lead_id", organizationId: "lo.org_id", current: "lo.current" },
  organizations: { id: "org.id", primaryDomain: "org.primary_domain" },
  leadContactMethods: {},
}));

const resolveEmail = vi.fn();
vi.mock("../../src/lib/people-client.js", () => ({
  peopleSearch: vi.fn(),
  resolveEmail: (...args: unknown[]) => resolveEmail(...args),
  isPeopleCreditInsufficientError: (error: unknown) =>
    error instanceof Error &&
    error.message.includes("402") &&
    error.message.includes("credit_insufficient"),
}));

const getPrimaryEmail = vi.fn();
const upsertContactMethod = vi.fn();
vi.mock("../../src/lib/leads-registry.js", () => ({
  getPrimaryEmail: (...args: unknown[]) => getPrimaryEmail(...args),
  leadHasEmail: vi.fn(),
  recordEmploymentHistory: vi.fn(),
  upsertContactMethod: (...args: unknown[]) => upsertContactMethod(...args),
  upsertLeadFromPerson: vi.fn(),
}));

const checkContacted = vi.fn();
vi.mock("../../src/lib/dedup.js", () => ({
  checkContacted: (...args: unknown[]) => checkContacted(...args),
  checkRaceWindow: vi.fn(),
  isAlreadyServedForBrand: vi.fn(async () => ({ blocked: false })),
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLead: vi.fn(),
}));

vi.mock("../../src/lib/strategy-generator.js", () => ({
  advanceStrategyOrGenerate: vi.fn(),
  getCurrentStrategy: vi.fn(),
  persistApifyOffset: vi.fn(),
}));

vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: vi.fn(),
}));

vi.mock("../../src/lib/brand-client.js", () => ({
  extractBrandFields: vi.fn(),
}));

import { pullNext } from "../../src/lib/buffer.js";

describe("pullNext credit handling", () => {
  beforeEach(() => {
    sql.mockReset();
    findLead.mockReset();
    selectLimit.mockReset();
    updateSet.mockReset();
    updateWhere.mockReset();
    resolveEmail.mockReset();
    getPrimaryEmail.mockReset();
    upsertContactMethod.mockReset();
    checkContacted.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns found=false and releases the claim quietly on gateway credit_insufficient", async () => {
    sql.mockResolvedValueOnce([{ id: "lead-campaign-1", lead_id: "lead-1" }]);
    findLead.mockResolvedValueOnce({
      id: "lead-1",
      apolloPersonId: "apollo-person-1",
      firstName: "Sara",
      lastName: "Lee",
      enrichedAt: null,
    });
    selectLimit.mockResolvedValueOnce([{ domain: "cascobay.com" }]);
    getPrimaryEmail.mockResolvedValueOnce(null);
    resolveEmail.mockRejectedValueOnce(
      new Error(
        'People gateway call failed: 402 - {"type":"credit_insufficient","error":"Insufficient credits"}',
      ),
    );

    const result = await pullNext({
      orgId: "org-1",
      campaignId: "campaign-1",
      brandIds: ["brand-1"],
      provider: "apollo",
      runId: "run-1",
      userId: "user-1",
    });

    expect(result).toEqual({ found: false, reason: "credit_insufficient" });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "buffered" }),
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("released claimed lead"),
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("apollo: resolves by providerPersonId even when org domain is missing", async () => {
    sql.mockResolvedValue([{ id: "lead-campaign-1", lead_id: "lead-1" }]);
    findLead.mockResolvedValueOnce({
      id: "lead-1",
      apolloPersonId: "apollo-person-1",
      firstName: "Sara",
      lastName: "Lee",
      enrichedAt: null,
    });
    selectLimit.mockResolvedValueOnce([]); // getCurrentOrgDomain -> null
    getPrimaryEmail.mockResolvedValue(null);
    resolveEmail.mockResolvedValue({
      provider: "apollo",
      person: { email: "sara@cascobay.com", emailStatus: "verified" },
    });
    upsertContactMethod.mockResolvedValue({ inserted: true });
    checkContacted.mockResolvedValue(new Map());

    const result = await pullNext({
      orgId: "org-1",
      campaignId: "campaign-1",
      brandIds: ["brand-1"],
      provider: "apollo",
      runId: "run-1",
      userId: "user-1",
    });

    expect(result.found).toBe(true);
    expect(resolveEmail).toHaveBeenCalledTimes(1);
    const body = resolveEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ provider: "apollo", providerPersonId: "apollo-person-1" });
    expect(body.firstName).toBeUndefined();
    expect(body.domain).toBeUndefined();
  });

  it("apify: resolves by name + domain, never sends a providerPersonId", async () => {
    sql.mockResolvedValue([{ id: "lead-campaign-1", lead_id: "lead-1" }]);
    findLead.mockResolvedValueOnce({
      id: "lead-1",
      apolloPersonId: null,
      firstName: "Sara",
      lastName: "Lee",
      enrichedAt: null,
    });
    selectLimit.mockResolvedValueOnce([{ domain: "cascobay.com" }]);
    getPrimaryEmail.mockResolvedValue(null);
    resolveEmail.mockResolvedValue({
      provider: "apify",
      person: { email: "sara@cascobay.com", emailStatus: "verified" },
    });
    upsertContactMethod.mockResolvedValue({ inserted: true });
    checkContacted.mockResolvedValue(new Map());

    const result = await pullNext({
      orgId: "org-1",
      campaignId: "campaign-1",
      brandIds: ["brand-1"],
      provider: "apify",
      runId: "run-1",
      userId: "user-1",
    });

    expect(result.found).toBe(true);
    expect(resolveEmail).toHaveBeenCalledTimes(1);
    const body = resolveEmail.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: "apify",
      firstName: "Sara",
      lastName: "Lee",
      domain: "cascobay.com",
    });
    expect(body.providerPersonId).toBeUndefined();
  });
});
