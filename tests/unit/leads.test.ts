import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db
const mockFindMany = vi.fn();
const mockBufferFindMany = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      servedLeads: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
      leadBuffer: {
        findMany: (...args: unknown[]) => mockBufferFindMany(...args),
      },
    },
  },
}));

const mockCheckDeliveryStatus = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => mockCheckDeliveryStatus(...args),
  isContacted: () => false,
}));

vi.mock("../../src/middleware/auth.js", () => ({
  apiKeyAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireOrgId: (_req: unknown, _res: unknown, next: () => void) => next(),
  getServiceContext: (req: any) => ({
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
    campaignId: req.campaignId,
    brandId: req.brandId,
    workflowSlug: req.workflowSlug,
    featureSlug: req.featureSlug,
  }),
}));

import request from "supertest";
import express from "express";
import leadsRouter from "../../src/routes/leads.js";
import { extractEnrichment, flattenCampaignStatus, flattenBrandStatus } from "../../src/routes/leads.js";

function createApp() {
  const app = express();
  app.use((req: any, _res, next) => {
    req.orgId = "org-1";
    req.userId = "user-1";
    req.runId = "run-1";
    next();
  });
  app.use(leadsRouter);
  return app;
}

function makeServedLead(overrides: Partial<{
  leadId: string | null;
  email: string;
  brandIds: string[];
  campaignId: string;
  metadata: unknown;
  apolloPersonId: string | null;
}> = {}) {
  return {
    id: "row-1",
    leadId: "lead-1",
    namespace: "apollo",
    email: "alice@acme.com",
    apolloPersonId: null,
    metadata: null,
    parentRunId: null,
    runId: null,
    brandIds: ["b1"],
    campaignId: "c1",
    orgId: "org-1",
    userId: null,
    servedAt: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

function makeBroadcastStatus(overrides: {
  campaign?: Record<string, unknown>;
  brand?: Record<string, unknown>;
}) {
  const defaultScoped = {
    contacted: false, sent: false, delivered: false, opened: false, clicked: false, replied: false,
    replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null,
  };
  return {
    campaign: { ...defaultScoped, ...overrides.campaign },
    brand: { ...defaultScoped, ...overrides.brand },
    global: { email: { bounced: false, unsubscribed: false } },
  };
}

// --- extractEnrichment unit tests ---

describe("extractEnrichment", () => {
  it("returns null for null metadata", () => {
    expect(extractEnrichment(null)).toBeNull();
  });

  it("returns null for undefined metadata", () => {
    expect(extractEnrichment(undefined)).toBeNull();
  });

  it("returns null for non-object metadata", () => {
    expect(extractEnrichment("string")).toBeNull();
    expect(extractEnrichment(42)).toBeNull();
  });

  it("returns null when no person identifiers exist", () => {
    expect(extractEnrichment({ organizationName: "Acme" })).toBeNull();
  });

  it("passes through ALL fields from metadata without filtering", () => {
    const metadata = {
      firstName: "Diana",
      lastName: "Prince",
      email: "diana@example.com",
      title: "CEO",
      linkedinUrl: "https://linkedin.com/in/diana",
      organizationName: "Themyscira Inc",
      organizationDomain: "themyscira.com",
      organizationIndustry: "Defense",
      organizationSize: "501-1000",
      headline: "CEO & Founder at Themyscira Inc",
      city: "Gateway City",
      state: "CA",
      country: "United States",
      organizationShortDescription: "Leading defense tech company",
      organizationFoundedYear: 2010,
      organizationRevenueUsd: "50000000",
      seniority: "founder",
      departments: ["executive"],
      photoUrl: "https://example.com/diana.jpg",
      twitterUrl: "https://twitter.com/diana",
      facebookUrl: "https://facebook.com/diana",
      organizationLogoUrl: "https://example.com/logo.png",
      organizationTotalFunding: 25000000,
      organizationLatestFundingRound: "Series C",
      organizationTechnologies: ["React", "Node.js", "PostgreSQL"],
    };

    const result = extractEnrichment(metadata);
    expect(result).not.toBeNull();
    expect(result!.firstName).toBe("Diana");
    expect(result!.lastName).toBe("Prince");
    expect(result!.title).toBe("CEO");
    expect(result!.organizationName).toBe("Themyscira Inc");
    expect(result!.headline).toBe("CEO & Founder at Themyscira Inc");
    expect(result!.organizationFoundedYear).toBe(2010);
  });

  it("works with minimal metadata (just firstName)", () => {
    const result = extractEnrichment({ firstName: "Alice" });
    expect(result).not.toBeNull();
    expect(result!.firstName).toBe("Alice");
  });

  it("passes through new Apollo coverage fields (name, personalEmails, mobilePhone, phoneNumbers, organizationId, organizationRawAddress, raw)", () => {
    const metadata = {
      firstName: "Diana",
      lastName: "Prince",
      name: "Diana Prince",
      personalEmails: ["diana@personal.com", "wonder@gmail.com"],
      mobilePhone: "+1-555-WONDER",
      phoneNumbers: [
        { rawNumber: "+1-555-WONDER", sanitizedNumber: "+15559663377", type: "mobile" },
      ],
      organizationId: "org-apollo-themyscira",
      organizationName: "Themyscira Inc",
      organizationRawAddress: "1 Paradise Island, Themyscira",
      raw: {
        first_name: "Diana",
        last_name: "Prince",
        personal_emails: ["diana@personal.com"],
        mobile_phone: "+1-555-WONDER",
        organization_id: "org-apollo-themyscira",
      },
    };

    const result = extractEnrichment(metadata);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Diana Prince");
    expect(result!.personalEmails).toEqual(["diana@personal.com", "wonder@gmail.com"]);
    expect(result!.mobilePhone).toBe("+1-555-WONDER");
    expect(result!.phoneNumbers).toEqual([
      { rawNumber: "+1-555-WONDER", sanitizedNumber: "+15559663377", type: "mobile" },
    ]);
    expect(result!.organizationId).toBe("org-apollo-themyscira");
    expect(result!.organizationRawAddress).toBe("1 Paradise Island, Themyscira");
    expect((result!.raw as Record<string, unknown>).personal_emails).toEqual(["diana@personal.com"]);
    expect((result!.raw as Record<string, unknown>).mobile_phone).toBe("+1-555-WONDER");
  });
});

// --- GET /orgs/leads with merged status ---

describe("GET /orgs/leads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockBufferFindMany.mockResolvedValue([]);
    mockCheckDeliveryStatus.mockResolvedValue({ results: [] });
  });

  it("returns leads with default status including new fields when no brandId/campaignId", async () => {
    mockFindMany.mockResolvedValue([makeServedLead()]);

    const app = createApp();
    const res = await request(app).get("/orgs/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads).toHaveLength(1);
    expect(res.body.leads[0]).toMatchObject({
      contacted: false,
      sent: false,
      delivered: false,
      opened: false,
      clicked: false,
      bounced: false,
      unsubscribed: false,
      replied: false,
      replyClassification: null,
      lastDeliveredAt: null,
      global: { bounced: false, unsubscribed: false },
      apolloPersonId: null,
      emailStatus: null,
    });
    expect(mockCheckDeliveryStatus).not.toHaveBeenCalled();
  });

  it("merges delivery status from email-gateway with campaignId", async () => {
    mockFindMany.mockResolvedValue([
      makeServedLead({ leadId: "lead-1", email: "alice@acme.com" }),
      makeServedLead({ leadId: "lead-2", email: "bob@acme.com" }),
    ]);

    mockCheckDeliveryStatus.mockResolvedValue({
      results: [
        {
          email: "alice@acme.com",
          broadcast: makeBroadcastStatus({
            campaign: { contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true, replyClassification: "positive", lastDeliveredAt: "2026-03-29T10:00:00Z" },
          }),
        },
        {
          email: "bob@acme.com",
          broadcast: makeBroadcastStatus({
            campaign: { contacted: true, bounced: true },
          }),
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/orgs/leads?campaignId=c1");
    expect(res.status).toBe(200);

    const alice = res.body.leads.find((l: any) => l.email === "alice@acme.com");
    expect(alice.contacted).toBe(true);
    expect(alice.sent).toBe(true);
    expect(alice.delivered).toBe(true);
    expect(alice.opened).toBe(true);
    expect(alice.clicked).toBe(true);
    expect(alice.replied).toBe(true);
    expect(alice.replyClassification).toBe("positive");
    expect(alice.lastDeliveredAt).toBe("2026-03-29T10:00:00Z");

    const bob = res.body.leads.find((l: any) => l.email === "bob@acme.com");
    expect(bob.contacted).toBe(true);
    expect(bob.bounced).toBe(true);
    expect(bob.replied).toBe(false);
  });

  it("uses brand-scoped flattening when only brandId is provided", async () => {
    mockFindMany.mockResolvedValue([
      makeServedLead({ leadId: "lead-1", email: "alice@acme.com" }),
    ]);

    mockCheckDeliveryStatus.mockResolvedValue({
      results: [
        {
          email: "alice@acme.com",
          broadcast: makeBroadcastStatus({
            brand: { contacted: true, delivered: true, replied: true, replyClassification: "negative", lastDeliveredAt: "2026-04-01T12:00:00Z" },
          }),
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/orgs/leads?brandId=b1");
    expect(res.status).toBe(200);

    const alice = res.body.leads[0];
    expect(alice.contacted).toBe(true);
    expect(alice.delivered).toBe(true);
    expect(alice.replied).toBe(true);
    expect(alice.replyClassification).toBe("negative");
  });

  it("includes global bounced/unsubscribed from email-gateway", async () => {
    mockFindMany.mockResolvedValue([
      makeServedLead({ leadId: "lead-1", email: "alice@acme.com" }),
    ]);

    mockCheckDeliveryStatus.mockResolvedValue({
      results: [
        {
          email: "alice@acme.com",
          broadcast: {
            campaign: { contacted: false, sent: false, delivered: false, opened: false, clicked: false, replied: false, replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null },
            brand: { contacted: false, sent: false, delivered: false, opened: false, clicked: false, replied: false, replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null },
            global: { email: { bounced: true, unsubscribed: true } },
          },
        },
      ],
    });

    const app = createApp();
    const res = await request(app).get("/orgs/leads?campaignId=c1");
    expect(res.status).toBe(200);

    const alice = res.body.leads[0];
    expect(alice.global.bounced).toBe(true);
    expect(alice.global.unsubscribed).toBe(true);
  });

  it("returns apolloPersonId and emailStatus from enrichment", async () => {
    mockFindMany.mockResolvedValue([
      makeServedLead({
        leadId: "lead-1",
        email: "alice@acme.com",
        apolloPersonId: "apollo-person-123",
        metadata: { firstName: "Alice", emailStatus: "verified" },
      }),
    ]);

    const app = createApp();
    const res = await request(app).get("/orgs/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads[0].apolloPersonId).toBe("apollo-person-123");
    expect(res.body.leads[0].emailStatus).toBe("verified");
  });

  it("groups email-gateway calls by first brandId", async () => {
    mockFindMany.mockResolvedValue([
      makeServedLead({ leadId: "lead-1", email: "alice@acme.com", brandIds: ["b1"] }),
      makeServedLead({ leadId: "lead-2", email: "bob@other.com", brandIds: ["b2"] }),
    ]);
    mockCheckDeliveryStatus.mockResolvedValue({ results: [] });

    const app = createApp();
    await request(app).get("/orgs/leads?campaignId=c1");

    expect(mockCheckDeliveryStatus).toHaveBeenCalledTimes(2);
    expect(mockCheckDeliveryStatus).toHaveBeenCalledWith("b1", "c1", expect.any(Array), expect.any(Object));
    expect(mockCheckDeliveryStatus).toHaveBeenCalledWith("b2", "c1", expect.any(Array), expect.any(Object));
  });

  it("skips email-gateway call for leads with null leadId", async () => {
    mockFindMany.mockResolvedValue([
      makeServedLead({ leadId: null, email: "orphan@acme.com" }),
      makeServedLead({ leadId: "lead-1", email: "alice@acme.com" }),
    ]);
    mockCheckDeliveryStatus.mockResolvedValue({ results: [] });

    const app = createApp();
    const res = await request(app).get("/orgs/leads?campaignId=c1");
    expect(res.body.leads).toHaveLength(2);

    const items = mockCheckDeliveryStatus.mock.calls[0][2];
    expect(items).toHaveLength(1);
    expect(items[0].email).toBe("alice@acme.com");
  });

  it("returns statusReason and statusDetails as null for served leads", async () => {
    mockFindMany.mockResolvedValue([makeServedLead()]);

    const app = createApp();
    const res = await request(app).get("/orgs/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads[0].statusReason).toBeNull();
    expect(res.body.leads[0].statusDetails).toBeNull();
  });

  it("returns statusReason and statusDetails from buffer leads", async () => {
    mockBufferFindMany.mockResolvedValue([{
      id: "buf-1",
      namespace: "apollo",
      email: "bob@acme.com",
      apolloPersonId: null,
      data: null,
      status: "skipped",
      pushRunId: null,
      brandIds: ["b1"],
      campaignId: "c1",
      orgId: "org-1",
      userId: null,
      workflowSlug: null,
      featureSlug: null,
      statusReason: "already_contacted",
      statusDetails: "Contacted via campaign c0 on 2026-03-15",
      createdAt: "2026-04-01T00:00:00Z",
    }]);

    const app = createApp();
    const res = await request(app).get("/orgs/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads[0].statusReason).toBe("already_contacted");
    expect(res.body.leads[0].statusDetails).toBe("Contacted via campaign c0 on 2026-03-15");
  });

  it("returns statusReason and statusDetails as null when buffer lead has no values", async () => {
    mockBufferFindMany.mockResolvedValue([{
      id: "buf-2",
      namespace: "apollo",
      email: "carol@acme.com",
      apolloPersonId: null,
      data: null,
      status: "buffered",
      pushRunId: null,
      brandIds: ["b1"],
      campaignId: "c1",
      orgId: "org-1",
      userId: null,
      workflowSlug: null,
      featureSlug: null,
      statusReason: null,
      statusDetails: null,
      createdAt: "2026-04-01T00:00:00Z",
    }]);

    const app = createApp();
    const res = await request(app).get("/orgs/leads");
    expect(res.status).toBe(200);
    expect(res.body.leads[0].statusReason).toBeNull();
    expect(res.body.leads[0].statusDetails).toBeNull();
  });

  it("still returns enrichment alongside status", async () => {
    const metadata = { firstName: "Alice", lastName: "Smith", email: "alice@acme.com" };
    mockFindMany.mockResolvedValue([
      makeServedLead({ leadId: "lead-1", email: "alice@acme.com", metadata }),
    ]);
    mockCheckDeliveryStatus.mockResolvedValue({ results: [] });

    const app = createApp();
    const res = await request(app).get("/orgs/leads?campaignId=c1");
    expect(res.body.leads[0].enrichment).toMatchObject({ firstName: "Alice" });
    expect(res.body.leads[0].contacted).toBe(false);
  });
});

// --- flattenCampaignStatus unit tests ---

describe("flattenCampaignStatus", () => {
  it("detects all status fields from broadcast campaign", () => {
    const result = flattenCampaignStatus({
      email: "a@b.com",
      broadcast: makeBroadcastStatus({
        campaign: { contacted: true, sent: true, delivered: true, opened: true, clicked: true, replied: true, replyClassification: "positive", lastDeliveredAt: "2026-03-29T10:00:00Z" },
      }),
    });

    expect(result.contacted).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.opened).toBe(true);
    expect(result.clicked).toBe(true);
    expect(result.replied).toBe(true);
    expect(result.replyClassification).toBe("positive");
    expect(result.lastDeliveredAt).toBe("2026-03-29T10:00:00Z");
    expect(result.global).toEqual({ bounced: false, unsubscribed: false });
  });

  it("detects transactional delivery", () => {
    const defaultScoped = {
      contacted: false, sent: false, delivered: false, opened: false, clicked: false, replied: false,
      replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null,
    };
    const result = flattenCampaignStatus({
      email: "a@b.com",
      transactional: {
        campaign: { ...defaultScoped, contacted: true, delivered: true, lastDeliveredAt: "2026-03-28T08:00:00Z" },
        brand: defaultScoped,
        global: { email: { bounced: false, unsubscribed: false } },
      },
    });

    expect(result.delivered).toBe(true);
    expect(result.contacted).toBe(true);
    expect(result.lastDeliveredAt).toBe("2026-03-28T08:00:00Z");
  });

  it("returns all false when no providers present", () => {
    const result = flattenCampaignStatus({ email: "a@b.com" });
    expect(result).toEqual({
      contacted: false, sent: false, delivered: false, opened: false, clicked: false,
      bounced: false, unsubscribed: false, replied: false, replyClassification: null, lastDeliveredAt: null,
      global: { bounced: false, unsubscribed: false },
    });
  });

  it("picks up global bounced/unsubscribed", () => {
    const result = flattenCampaignStatus({
      email: "a@b.com",
      broadcast: {
        campaign: {
          contacted: false, sent: false, delivered: false, opened: false, clicked: false,
          replied: false, replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null,
        },
        brand: {
          contacted: false, sent: false, delivered: false, opened: false, clicked: false,
          replied: false, replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null,
        },
        global: { email: { bounced: true, unsubscribed: true } },
      },
    });
    expect(result.global.bounced).toBe(true);
    expect(result.global.unsubscribed).toBe(true);
  });
});

// --- flattenBrandStatus unit tests ---

describe("flattenBrandStatus", () => {
  it("uses brand scope for cross-campaign status", () => {
    const result = flattenBrandStatus({
      email: "a@b.com",
      broadcast: makeBroadcastStatus({
        brand: { contacted: true, delivered: true, replied: true, lastDeliveredAt: "2026-03-29T10:00:00Z" },
      }),
    });

    expect(result.contacted).toBe(true);
    expect(result.delivered).toBe(true);
    expect(result.replied).toBe(true);
    expect(result.lastDeliveredAt).toBe("2026-03-29T10:00:00Z");
    expect(result.global).toEqual({ bounced: false, unsubscribed: false });
  });

  it("returns all false when no providers present", () => {
    const result = flattenBrandStatus({ email: "a@b.com" });
    expect(result).toEqual({
      contacted: false, sent: false, delivered: false, opened: false, clicked: false,
      bounced: false, unsubscribed: false, replied: false, replyClassification: null, lastDeliveredAt: null,
      global: { bounced: false, unsubscribed: false },
    });
  });
});
