import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  count: () => ({ op: "count" }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
}));

const sql = vi.fn();
const findLead = vi.fn();
const updateSet = vi.fn();
const updateWhere = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      leads: {
        findFirst: (...args: unknown[]) => findLead(...args),
      },
    },
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
  leadContactMethods: {},
}));

const apolloEnrich = vi.fn();
vi.mock("../../src/lib/apollo-client.js", () => ({
  apolloFetchPage: vi.fn(),
  apolloEnrich: (...args: unknown[]) => apolloEnrich(...args),
  isApolloCreditInsufficientError: (error: unknown) =>
    error instanceof Error &&
    error.message.includes("402") &&
    error.message.includes("credit_insufficient"),
}));

const getPrimaryEmail = vi.fn();
vi.mock("../../src/lib/leads-registry.js", () => ({
  getPrimaryEmail: (...args: unknown[]) => getPrimaryEmail(...args),
  leadHasEmail: vi.fn(),
  recordEmploymentHistory: vi.fn(),
  upsertContactMethod: vi.fn(),
  upsertLeadFromPerson: vi.fn(),
}));

vi.mock("../../src/lib/dedup.js", () => ({
  checkContacted: vi.fn(),
  checkRaceWindow: vi.fn(),
  isAlreadyServedForBrand: vi.fn(async () => ({ blocked: false })),
}));

vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLead: vi.fn(),
}));

vi.mock("../../src/lib/strategy-generator.js", () => ({
  advanceStrategyOrGenerate: vi.fn(),
  getCurrentStrategy: vi.fn(),
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
    updateSet.mockReset();
    updateWhere.mockReset();
    apolloEnrich.mockReset();
    getPrimaryEmail.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns found=false and releases the claim quietly on Apollo credit_insufficient", async () => {
    sql.mockResolvedValueOnce([{ id: "lead-campaign-1", lead_id: "lead-1" }]);
    findLead.mockResolvedValueOnce({
      id: "lead-1",
      apolloPersonId: "apollo-person-1",
      enrichedAt: null,
    });
    getPrimaryEmail.mockResolvedValueOnce(null);
    apolloEnrich.mockRejectedValueOnce(
      new Error(
        'Apollo service call failed: 402 - {"type":"credit_insufficient","error":"Insufficient credits"}',
      ),
    );

    const result = await pullNext({
      orgId: "org-1",
      campaignId: "campaign-1",
      brandIds: ["brand-1"],
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
});
