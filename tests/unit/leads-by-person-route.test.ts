import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// The by-person read (LEAD-BY-PERSON-CAMPAIGN-1014) addresses ONE membership row by (person,
// campaign, org). The `sql` mock answers the lookup only for a row whose lead_id, campaign_id AND
// org match the predicate, so a handler that checked the org after the fact (or not at all) fails.
interface SqlNode {
  __sql: true;
  strings: readonly string[];
  values: unknown[];
}

let storedRows: Array<Record<string, unknown>> = [];
let lookups: Array<{ leadId: unknown; campaignId: unknown; orgId: unknown }> = [];

// What sits above the lead (company marks and status, the human's opt-out): none here (level-tags.ts).
vi.mock("../../src/lib/level-tags.js", () => ({
  loadLevelTags: async () => ({ companyKeyOf: new Map(), companyMarks: new Map(), companyStatus: new Map(), humanOptOuts: new Set(), humanFacts: new Map() }),
}));

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join(" ");
    const node: SqlNode = { __sql: true, strings, values };
    if (!/WHERE lc\.lead_id =/.test(text)) return node;
    return {
      then: (resolve: (rows: unknown[]) => void) => {
        // Bind-faithful: postgres.js throws ERR_INVALID_ARG_TYPE on a raw Date param, and a plain
        // mock would let a handler that binds one ship green. See CLAUDE.md.
        for (const v of values) {
          if (v instanceof Date) {
            throw new TypeError('The "string" argument must be of type string. Received an instance of Date');
          }
        }
        const [leadId, campaignId, orgId] = values;
        lookups.push({ leadId, campaignId, orgId });
        const row = storedRows.find(
          (r) => r.lead_id === leadId && r.campaign_id === campaignId && r.org_id === orgId,
        );
        return Promise.resolve(row ? [row] : []).then(resolve);
      },
    };
  },
}));

const buildFullLeadsBatchMock = vi.fn();
vi.mock("../../src/lib/lead-shape.js", () => ({
  buildFullLeadsBatch: (ids: string[]) => buildFullLeadsBatchMock(ids),
}));

const checkDeliveryStatusMock = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatusMock(...args),
}));

const resolveAudiencesForBrandMock = vi.fn();
const resolveBrandMembershipsByEmailMock = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));
vi.mock("../../src/lib/audience-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/audience-client.js")>()),
  resolveAudiencesForBrand: (...args: unknown[]) => resolveAudiencesForBrandMock(...args),
  resolveBrandMembershipsByEmail: (...args: unknown[]) => resolveBrandMembershipsByEmailMock(...args),
}));
vi.mock("../../src/lib/sourcing-origin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sourcing-origin.js")>()),
  loadOriginNamesByList: () => loadOriginNamesByListMock(),
}));
const loadOriginNamesByListMock = vi.hoisted(() => vi.fn().mockResolvedValue(new Map()));

const resolveCampaignFamilyMock = vi.fn();
vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (...args: unknown[]) => resolveCampaignFamilyMock(...args),
}));

vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config.js", () => ({ LEAD_SERVICE_API_KEY: "test-api-key" }));

const ORG = "30000000-0000-0000-0000-000000000001";
const OTHER_ORG = "30000000-0000-0000-0000-0000000000ff";
const USER = "40000000-0000-0000-0000-000000000001";
const ROW_ID = "10000000-0000-0000-0000-000000000001";
const LEAD_ID = "20000000-0000-0000-0000-000000000001";
const BRAND = "brand-1";

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    lead_id: LEAD_ID,
    campaign_id: "campaign-live",
    org_id: ORG,
    user_id: USER,
    brand_ids: [BRAND],
    status: "served",
    status_reason: null,
    status_details: null,
    parent_run_id: "run-parent",
    run_id: "run-1",
    // A raw timestamp STRING, not a Date: postgres.js hands timestamptz back either way and a Date
    // fixture would pass a handler that throws `is not a function` in production.
    served_at: "2026-01-02 03:04:05+00",
    workflow_slug: "find-leads",
    feature_slug: "leads",
    goal: "signup",
    active_goal_id: "goal-1",
    brand_profile_id: "profile-1",
    audience_id: "audience-1",
    created_at: "2026-01-01 00:00:00+00",
    lead_apollo_person_id: "apollo-person-1",
    lead_human_id: null,
    lead_company_id: null,
    ...overrides,
  };
}

const FULL_LEAD = {
  leadId: LEAD_ID,
  contacts: [{ channel: "email", value: "person@example.com", status: "verified" }],
  employmentHistory: [{ organizationName: "Acme", current: true }],
  organization: { id: "org-acme", name: "Acme" },
};

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/leads.js");
  app = express();
  app.use(express.json());
  app.use(route);
}, 30_000);

beforeEach(() => {
  storedRows = [storedRow()];
  lookups = [];
  buildFullLeadsBatchMock.mockReset().mockImplementation((ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, FULL_LEAD]))),
  );
  checkDeliveryStatusMock.mockReset().mockResolvedValue({ results: [] });
  resolveAudiencesForBrandMock
    .mockReset()
    .mockResolvedValue({ byAudienceId: {}, byEmail: {} });
  resolveCampaignFamilyMock.mockReset().mockResolvedValue(null);
});

function get(path: string, org: string = ORG) {
  return request(app)
    .get(path)
    .set("x-api-key", "test-api-key")
    .set("x-org-id", org)
    .set("x-user-id", USER);
}

const CAMPAIGN = "campaign-live";
const path = (lead: string = LEAD_ID, campaign: string = CAMPAIGN) =>
  `/orgs/campaigns/${campaign}/leads/by-lead/${lead}`;

describe("GET /orgs/campaigns/:campaignId/leads/by-lead/:leadId — a person's lead on a campaign", () => {
  it("found: answers the person's one row on the campaign, same body as the by-row read", async () => {
    const res = await get(path());
    expect(res.status).toBe(200);
    expect(res.body.leadDetail).toMatchObject({ id: ROW_ID, leadId: LEAD_ID, email: "person@example.com" });
    expect(lookups).toEqual([{ leadId: LEAD_ID, campaignId: CAMPAIGN, orgId: ORG }]);
    expect(buildFullLeadsBatchMock).toHaveBeenCalledWith([LEAD_ID]);
  });

  it("reads delivery evidence scoped to the path campaign (status, replies)", async () => {
    await get(path());
    expect(resolveCampaignFamilyMock).toHaveBeenCalledWith(CAMPAIGN, expect.objectContaining({ orgId: ORG }));
    expect(checkDeliveryStatusMock).toHaveBeenCalledTimes(1);
    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBe(CAMPAIGN);
  });

  it("not found: a person with no row on that campaign is a 404 lead_not_on_campaign", async () => {
    const res = await get(path(LEAD_ID, "another-campaign"));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("lead_not_on_campaign");
    expect(buildFullLeadsBatchMock).not.toHaveBeenCalled();
  });

  it("another org's lead is not served: the same 404 as none", async () => {
    const res = await get(path(), OTHER_ORG);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("lead_not_on_campaign");
    expect(lookups).toEqual([{ leadId: LEAD_ID, campaignId: CAMPAIGN, orgId: OTHER_ORG }]);
    expect(buildFullLeadsBatchMock).not.toHaveBeenCalled();
  });

  it("a brand scope the row is not part of is a 404", async () => {
    const res = await get(`${path()}?brandId=other-brand`);
    expect(res.status).toBe(404);
  });

  it("a non-uuid leadId is a 400, and nothing is read", async () => {
    const res = await get(path("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(lookups).toEqual([]);
  });

  it("refuses a campaignId query beside the path campaign", async () => {
    const res = await get(`${path()}?campaignId=x`);
    expect(res.status).toBe(400);
    expect(lookups).toEqual([]);
  });

  it("a database failure is a 500, never a hung socket", async () => {
    buildFullLeadsBatchMock.mockRejectedValue(new Error("db down"));
    const res = await get(path());
    expect(res.status).toBe(500);
  });
});
