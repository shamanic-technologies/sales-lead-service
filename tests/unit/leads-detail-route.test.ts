import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// The detail read addresses ONE membership row by its own id. The `sql` mock below answers the
// by-id lookup only for a row whose id AND org match the predicate, so a handler that checked the
// org after the fact (or not at all) fails here.
interface SqlNode {
  __sql: true;
  strings: readonly string[];
  values: unknown[];
}

let storedRows: Array<Record<string, unknown>> = [];
let lookups: Array<{ id: unknown; orgId: unknown }> = [];

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join(" ");
    const node: SqlNode = { __sql: true, strings, values };
    if (!/WHERE lc\.id =/.test(text)) return node;
    return {
      then: (resolve: (rows: unknown[]) => void) => {
        // Bind-faithful: postgres.js throws ERR_INVALID_ARG_TYPE on a raw Date param, and a plain
        // mock would let a handler that binds one ship green. See CLAUDE.md.
        for (const v of values) {
          if (v instanceof Date) {
            throw new TypeError('The "string" argument must be of type string. Received an instance of Date');
          }
        }
        const [id, orgId] = values;
        lookups.push({ id, orgId });
        const row = storedRows.find((r) => r.id === id && r.org_id === orgId);
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

describe("GET /orgs/leads/:id — one lead's full record", () => {
  it("answers with ONE record, not a list", async () => {
    const res = await get(`/orgs/leads/${ROW_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.leads).toBeUndefined();
    expect(Array.isArray(res.body.leadDetail)).toBe(false);
    expect(res.body.leadDetail.id).toBe(ROW_ID);
  });

  it("reads exactly the one lead, never the population around it", async () => {
    await get(`/orgs/leads/${ROW_ID}`);
    expect(lookups).toEqual([{ id: ROW_ID, orgId: ORG }]);
    expect(buildFullLeadsBatchMock).toHaveBeenCalledWith([LEAD_ID]);
  });

  it("carries everything the full list projection carries for that lead", async () => {
    resolveAudiencesForBrandMock.mockResolvedValue({
      byAudienceId: { "audience-1": { id: "audience-1", name: "Founders", avatarUrl: null } },
      byEmail: {},
    });
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: "person@example.com",
          broadcast: {
            brand: {
              contacted: true, sent: true, delivered: true, opened: true, clicked: false,
              replied: false, replyClassification: null, bounced: false, unsubscribed: false,
              sentCount: 2, lastDeliveredAt: "2026-01-03T00:00:00.000Z",
              firstContactedAt: "2026-01-02T00:00:00.000Z", firstSentAt: "2026-01-02T00:00:00.000Z",
              firstDeliveredAt: "2026-01-02T00:00:00.000Z", firstOpenedAt: "2026-01-02T06:00:00.000Z",
              firstClickedAt: null, firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
            },
            global: { email: { bounced: false, unsubscribed: false } },
          },
        },
      ],
    });

    const res = await get(`/orgs/leads/${ROW_ID}?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    const d = res.body.leadDetail;

    // Identity + lifecycle
    expect(d).toMatchObject({
      id: ROW_ID,
      leadId: LEAD_ID,
      namespace: "apollo",
      email: "person@example.com",
      emailStatus: "verified",
      apolloPersonId: "apollo-person-1",
      parentRunId: "run-parent",
      runId: "run-1",
      brandIds: [BRAND],
      campaignId: "campaign-live",
      orgId: ORG,
      userId: USER,
      workflowSlug: "find-leads",
      featureSlug: "leads",
      goal: "signup",
      activeGoalId: "goal-1",
      brandProfileId: "profile-1",
      audienceId: "audience-1",
      status: "served",
      servedAt: "2026-01-02T03:04:05.000Z",
    });
    // The heavy payload a detail panel exists to show
    expect(d.lead).toEqual(FULL_LEAD);
    // The resolved audience card
    expect(d.audience).toEqual({ id: "audience-1", name: "Founders", avatarUrl: null });
    // The delivery overlay
    expect(d).toMatchObject({
      contacted: true, sent: true, delivered: true, opened: true, clicked: false,
      sentCount: 2, firstOpenedAt: "2026-01-02T06:00:00.000Z",
      global: { bounced: false, unsubscribed: false },
    });
  });

  it("emits the SAME object the full list emits for the same row", async () => {
    // Same mocks, same row: the two routes share one serializer, so the detail record and the list
    // element must be indistinguishable — a field on one and not the other is a panel that changes
    // shape depending on how it was loaded.
    const detail = (await get(`/orgs/leads/${ROW_ID}?brandId=${BRAND}`)).body.leadDetail;
    expect(Object.keys(detail).sort()).toEqual(
      [
        "activeGoalId", "apolloPersonId", "audience", "audienceId", "bounced", "brandIds",
        "brandProfileId", "campaignId", "clicked", "closedDeal", "contacted", "delivered", "email", "emailStatus",
        "featureSlug", "firstBouncedAt", "firstClickedAt", "firstContactedAt", "firstDeliveredAt",
        "firstOpenedAt", "firstRepliedAt", "firstSentAt", "firstUnsubscribedAt", "global", "goal",
        "id", "lastDeliveredAt", "lead", "leadId", "namespace", "offer", "opened", "orgId", "parentRunId",
        "replied", "replyClassification", "runId", "sent", "sentCount", "servedAt", "sources", "standing", "status",
        "statusDetails", "statusReason", "unsubscribed", "userId", "workflowSlug",
      ].sort(),
    );
  });

  it("carries EVERY source that found the person, the serving one flagged, named by the catalogue", async () => {
    loadOriginNamesByListMock.mockResolvedValue(
      new Map([
        ["apollo_search", { slug: "sourcing-apollo-cold-filters", name: "Apollo Cold Filters" }],
        ["linkedin_engagement", { slug: "sourcing-linkedin-engagement-signals", name: "LinkedIn Engagement Signals" }],
      ]),
    );
    resolveBrandMembershipsByEmailMock.mockResolvedValue(
      new Map([
        [
          "person@example.com",
          [
            { audienceId: "aud-signal", offerId: null, list: "linkedin_engagement", provenance: "found_taken" },
            { audienceId: "audience-1", offerId: "offer-1", list: "apollo_search", provenance: "served" },
          ],
        ],
      ]),
    );
    resolveAudiencesForBrandMock.mockResolvedValue({
      byAudienceId: { "audience-1": { id: "audience-1", name: "Founders", avatarUrl: null } },
      byEmail: {},
    });

    const res = await get(`/orgs/leads/${ROW_ID}?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    // Asked once, for the lead's brand, by the lead's email.
    expect(resolveBrandMembershipsByEmailMock).toHaveBeenLastCalledWith(BRAND, ["person@example.com"], expect.objectContaining({ orgId: ORG }));
    // The serving audience stays THE audience; the sources sit beside it.
    expect(res.body.leadDetail.audience).toEqual({ id: "audience-1", name: "Founders", avatarUrl: null });
    expect(res.body.leadDetail.sources).toEqual([
      { audienceId: "audience-1", offerId: "offer-1", list: "apollo_search", origin: { slug: "sourcing-apollo-cold-filters", name: "Apollo Cold Filters" }, servedLead: true },
      { audienceId: "aud-signal", offerId: null, list: "linkedin_engagement", origin: { slug: "sourcing-linkedin-engagement-signals", name: "LinkedIn Engagement Signals" }, servedLead: false },
    ]);
  });

  it("fails loud when the memberships cannot be read, never an empty source list", async () => {
    resolveBrandMembershipsByEmailMock.mockRejectedValueOnce(new Error("human-service down"));
    const res = await get(`/orgs/leads/${ROW_ID}?brandId=${BRAND}`);
    expect(res.status).toBe(500);
  });

  it("cannot be used to read a lead in another org", async () => {
    const res = await get(`/orgs/leads/${ROW_ID}`, OTHER_ORG);
    expect(res.status).toBe(404);
    // The org is part of the lookup predicate, so a foreign row is indistinguishable from absent.
    expect(lookups).toEqual([{ id: ROW_ID, orgId: OTHER_ORG }]);
  });

  it("cannot be used to read a lead outside the brand the caller scoped to", async () => {
    const res = await get(`/orgs/leads/${ROW_ID}?brandId=some-other-brand`);
    expect(res.status).toBe(404);
  });

  it("404s on a lead that does not exist", async () => {
    storedRows = [];
    const res = await get(`/orgs/leads/${ROW_ID}`);
    expect(res.status).toBe(404);
  });

  it("400s on an id that is not one this endpoint issues", async () => {
    const res = await get("/orgs/leads/not-a-uuid");
    expect(res.status).toBe(400);
    expect(lookups).toEqual([]);
  });

  it("reads a campaign-scoped overlay for the whole campaign identity", async () => {
    resolveCampaignFamilyMock.mockResolvedValue(["campaign-live", "campaign-stopped"]);
    checkDeliveryStatusMock.mockResolvedValue({
      results: [
        {
          email: "person@example.com",
          broadcast: {
            byCampaign: {
              // The evidence lives under the STOPPED ancestor: asking for the live id alone would
              // report a paid-for, contacted person as never contacted.
              "campaign-stopped": {
                contacted: true, sent: true, delivered: true, opened: false, clicked: false,
                replied: false, replyClassification: null, bounced: false, unsubscribed: false,
                sentCount: 1, lastDeliveredAt: null, firstContactedAt: "2026-01-02T00:00:00.000Z",
                firstSentAt: null, firstDeliveredAt: null, firstOpenedAt: null, firstClickedAt: null,
                firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
              },
            },
            global: { email: { bounced: false, unsubscribed: false } },
          },
        },
      ],
    });

    const res = await get(`/orgs/leads/${ROW_ID}?campaignId=campaign-live`);
    expect(res.status).toBe(200);
    expect(res.body.leadDetail.contacted).toBe(true);
    expect(res.body.leadDetail.sentCount).toBe(1);
    // A multi-member identity asks email-gateway in BRAND mode and reads the members out of
    // byCampaign, so no single campaign id is sent.
    expect(checkDeliveryStatusMock.mock.calls[0][1]).toBeUndefined();
  });

  it("does not fetch delivery evidence for a row that was never served", async () => {
    storedRows = [storedRow({ status: "buffered" })];
    const res = await get(`/orgs/leads/${ROW_ID}?brandId=${BRAND}`);
    expect(res.status).toBe(200);
    expect(checkDeliveryStatusMock).not.toHaveBeenCalled();
    expect(res.body.leadDetail.contacted).toBe(false);
  });

  it("fails loud when the record cannot be built", async () => {
    buildFullLeadsBatchMock.mockRejectedValue(new Error("hydration exploded"));
    const res = await get(`/orgs/leads/${ROW_ID}`);
    expect(res.status).toBe(500);
  });
});
