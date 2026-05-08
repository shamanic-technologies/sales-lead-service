import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// --- Common ---

const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("ErrorResponse");

const AuthHeaders = [
  {
    in: "header" as const,
    name: "x-api-key",
    required: true,
    schema: { type: "string" as const },
    description: "API key for authenticating requests",
  },
  {
    in: "header" as const,
    name: "x-org-id",
    required: true,
    schema: { type: "string" as const },
    description: "Internal organization UUID from client-service",
  },
  {
    in: "header" as const,
    name: "x-user-id",
    required: true,
    schema: { type: "string" as const },
    description: "Internal user UUID from client-service",
  },
  {
    in: "header" as const,
    name: "x-run-id",
    required: true,
    schema: { type: "string" as const },
    description: "The caller's run ID (used as parentRunId when creating this service's own run)",
  },
  {
    in: "header" as const,
    name: "x-campaign-id",
    required: false,
    schema: { type: "string" as const },
    description: "Campaign identifier (auto-injected by workflow-service)",
  },
  {
    in: "header" as const,
    name: "x-brand-id",
    required: false,
    schema: { type: "string" as const },
    description: "Brand identifier(s), comma-separated for multi-brand campaigns (auto-injected by workflow-service). Example: uuid1,uuid2,uuid3",
  },
  {
    in: "header" as const,
    name: "x-workflow-slug",
    required: false,
    schema: { type: "string" as const },
    description: "Workflow slug (auto-injected by workflow-service)",
  },
  {
    in: "header" as const,
    name: "x-feature-slug",
    required: false,
    schema: { type: "string" as const },
    description: "Feature slug for tracking (propagated through the call chain)",
  },
];

// buffer/next requires x-campaign-id and x-brand-id
const BufferNextHeaders = AuthHeaders.map((h) =>
  h.name === "x-campaign-id" || h.name === "x-brand-id"
    ? { ...h, required: true }
    : h
);

// --- Health ---

const HealthResponseSchema = z
  .object({
    status: z.string(),
    service: z.string(),
  })
  .openapi("HealthResponse");

// --- Apollo Person Data (flat camelCase — matches Apollo enrichment API) ---

const EmploymentHistorySchema = z.object({
  title: z.string().nullable().optional(),
  organizationName: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  current: z.boolean().optional(),
});

const FundingEventSchema = z.object({
  id: z.string().nullable().optional(),
  date: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  investors: z.string().nullable().optional(),
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  currency: z.string().nullable().optional(),
  news_url: z.string().nullable().optional(),
});

const TechnologySchema = z.object({
  uid: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

const PhoneNumberSchema = z.object({
  rawNumber: z.string().nullable().optional(),
  sanitizedNumber: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  position: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  dncStatus: z.string().nullable().optional(),
  dncOtherInfo: z.string().nullable().optional(),
  dialerFlags: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const ApolloPersonDataSchema = z
  .object({
    // Person identifiers
    id: z.string().optional(),
    email: z.string().nullable().optional(),
    emailStatus: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    firstName: z.string(),
    lastName: z.string(),
    title: z.string().nullable().optional(),
    linkedinUrl: z.string().nullable().optional(),
    // Person details
    photoUrl: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    seniority: z.string().nullable().optional(),
    departments: z.array(z.string()).optional(),
    subdepartments: z.array(z.string()).optional(),
    functions: z.array(z.string()).optional(),
    twitterUrl: z.string().nullable().optional(),
    githubUrl: z.string().nullable().optional(),
    facebookUrl: z.string().nullable().optional(),
    personalEmails: z.array(z.string()).nullable().optional(),
    mobilePhone: z.string().nullable().optional(),
    phoneNumbers: z.array(PhoneNumberSchema).nullable().optional(),
    employmentHistory: z.array(EmploymentHistorySchema).optional(),
    // Organization details (flat, NOT nested)
    organizationId: z.string().nullable().optional(),
    organizationName: z.string(),
    organizationDomain: z.string().nullable().optional(),
    organizationIndustry: z.string().nullable().optional(),
    organizationSize: z.string().nullable().optional(),
    organizationRawAddress: z.string().nullable().optional(),
    organizationRevenueUsd: z.string().nullable().optional(),
    organizationWebsiteUrl: z.string().nullable().optional(),
    organizationLogoUrl: z.string().nullable().optional(),
    organizationShortDescription: z.string().nullable().optional(),
    organizationSeoDescription: z.string().nullable().optional(),
    organizationLinkedinUrl: z.string().nullable().optional(),
    organizationTwitterUrl: z.string().nullable().optional(),
    organizationFacebookUrl: z.string().nullable().optional(),
    organizationBlogUrl: z.string().nullable().optional(),
    organizationCrunchbaseUrl: z.string().nullable().optional(),
    organizationAngellistUrl: z.string().nullable().optional(),
    organizationFoundedYear: z.number().nullable().optional(),
    organizationPrimaryPhone: z.string().nullable().optional(),
    organizationPubliclyTradedSymbol: z.string().nullable().optional(),
    organizationPubliclyTradedExchange: z.string().nullable().optional(),
    organizationAnnualRevenuePrinted: z.string().nullable().optional(),
    organizationTotalFunding: z.string().nullable().optional(),
    organizationTotalFundingPrinted: z.string().nullable().optional(),
    organizationLatestFundingRoundDate: z.string().nullable().optional(),
    organizationLatestFundingStage: z.string().nullable().optional(),
    organizationFundingEvents: z.array(FundingEventSchema).optional(),
    organizationCity: z.string().nullable().optional(),
    organizationState: z.string().nullable().optional(),
    organizationCountry: z.string().nullable().optional(),
    organizationStreetAddress: z.string().nullable().optional(),
    organizationPostalCode: z.string().nullable().optional(),
    organizationTechnologyNames: z.array(z.string()).optional(),
    organizationCurrentTechnologies: z.array(TechnologySchema).optional(),
    organizationKeywords: z.array(z.string()).optional(),
    organizationIndustries: z.array(z.string()).optional(),
    organizationSecondaryIndustries: z.array(z.string()).optional(),
    organizationNumSuborganizations: z.number().nullable().optional(),
    organizationRetailLocationCount: z.number().nullable().optional(),
    organizationAlexaRanking: z.number().nullable().optional(),
    // Verbatim Apollo person payload (snake_case, includes any field Apollo returns)
    raw: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi("ApolloPersonData", {
    description:
      "Apollo person + organization data in flat camelCase format. " +
      "Organization fields are prefixed with 'organization' (e.g. organizationDomain, organizationName) — " +
      "there is NO nested 'organization' object.",
  });

// --- Buffer Next ---

export const BufferNextRequestSchema = z
  .object({})
  .openapi("BufferNextRequest");

const ServedLeadSchema = z.object({
  leadId: z.string().uuid(),
  email: z.string(),
  data: ApolloPersonDataSchema.nullable(),
  brandIds: z.array(z.string()),
  orgId: z.string().nullable(),
  userId: z.string().nullable(),
  apolloPersonId: z
    .string()
    .nullable()
    .optional()
    .openapi({
      description:
        "Apollo person ID from enrichment. Present when the lead was sourced or enriched via Apollo.",
      example: "5f2a3b4c5d6e7f8a9b0c1d2e",
    }),
});

const BufferNextResponseSchema = z
  .object({
    found: z.boolean(),
    lead: ServedLeadSchema.optional(),
  })
  .openapi("BufferNextResponse", {
    description:
      "Response from pulling the next lead. When found is true, lead contains the served lead with typed IDs.",
    examples: [
      {
        summary: "Apollo lead",
        value: {
          found: true,
          lead: {
            leadId: "c1d2e3f4-a5b6-7890-abcd-ef1234567890",
            email: "jane.doe@acme.com",
            data: {
              firstName: "Jane",
              lastName: "Doe",
              title: "VP of Marketing",
              organizationName: "Acme Corp",
              organizationDomain: "acme.com",
            },
            brandIds: ["brand-uuid"],
            orgId: "org-uuid",
            userId: "user-uuid",
            apolloPersonId: "5f2a3b4c5d6e7f8a9b0c1d2e",
          },
        },
      },
      {
        summary: "Buffer exhausted",
        value: {
          found: false,
        },
      },
    ],
  });

// --- Leads ---

const LeadDetailSchema = z
  .object({
    id: z.string().uuid(),
    leadId: z.string().uuid().nullable(),
    namespace: z.string(),
    email: z.string(),
    apolloPersonId: z.string().nullable().openapi({
      description: "Apollo person ID from enrichment",
    }),
    emailStatus: z.string().nullable().openapi({
      description: "Email verification status from Apollo (verified, extrapolated, etc.)",
    }),
    status: z.enum(["buffered", "skipped", "claimed", "served"]).openapi({
      description: "Lead lifecycle status. 'buffered'/'skipped'/'claimed'/'served' all live in leads_campaigns; 'served' = pulled and served to a workflow.",
    }),
    metadata: ApolloPersonDataSchema.nullable(),
    parentRunId: z.string().nullable(),
    runId: z.string().nullable(),
    brandIds: z.array(z.string()),
    campaignId: z.string(),
    orgId: z.string(),
    userId: z.string().nullable(),
    servedAt: z.string().nullable(),
    enrichment: ApolloPersonDataSchema.nullable(),
    contacted: z.boolean(),
    sent: z.boolean(),
    delivered: z.boolean(),
    opened: z.boolean(),
    clicked: z.boolean(),
    bounced: z.boolean(),
    unsubscribed: z.boolean(),
    replied: z
      .boolean()
      .openapi({ description: "Whether the lead replied (any reply, regardless of sentiment)" }),
    replyClassification: z
      .enum(["positive", "negative", "neutral"])
      .nullable()
      .openapi({
        description:
          "Classification of the most recent reply from email-gateway. " +
          "'positive' = interested or willing to meet, " +
          "'negative' = not interested, " +
          "'neutral' = ambiguous or informational. " +
          "null when no reply detected.",
      }),
    statusReason: z.string().nullable().openapi({
      description: "Why this lead was skipped or placed in its current status (e.g. 'already_contacted', 'bounced'). Only set for buffer leads.",
    }),
    statusDetails: z.string().nullable().openapi({
      description: "Human-readable details about the status reason. Only set for buffer leads.",
    }),
    lastDeliveredAt: z.string().nullable(),
    global: z.object({
      bounced: z.boolean(),
      unsubscribed: z.boolean(),
    }).openapi({
      description: "Global-scope status (across all brands/campaigns). bounced and unsubscribed are global flags.",
    }),
  })
  .openapi("LeadDetail");

const LeadsResponseSchema = z
  .object({
    leads: z.array(LeadDetailSchema),
  })
  .openapi("LeadsResponse");

// --- Stats ---

const RepliesDetailSchema = z.object({
  interested: z.number(),
  meetingBooked: z.number(),
  closed: z.number(),
  notInterested: z.number(),
  wrongPerson: z.number(),
  unsubscribe: z.number(),
  neutral: z.number(),
  autoReply: z.number(),
  outOfOffice: z.number(),
});

const ByOutreachStatusSchema = z.object({
  contacted: z.number(),
  sent: z.number(),
  delivered: z.number(),
  opened: z.number(),
  bounced: z.number(),
  clicked: z.number(),
  unsubscribed: z.number(),
  repliesPositive: z.number(),
  repliesNegative: z.number(),
  repliesNeutral: z.number(),
  repliesAutoReply: z.number(),
  repliesDetail: RepliesDetailSchema,
});

const StatsResponseSchema = z
  .object({
    totalLeads: z.number(),
    byOutreachStatus: ByOutreachStatusSchema,
    repliesDetail: RepliesDetailSchema,
    buffered: z.number(),
    skipped: z.number(),
    claimed: z.number(),
  })
  .openapi("StatsResponse");

const StatsGroupSchema = z.object({
  key: z.string(),
  totalLeads: z.number(),
  byOutreachStatus: ByOutreachStatusSchema,
  repliesDetail: RepliesDetailSchema,
  buffered: z.number(),
  skipped: z.number(),
  claimed: z.number(),
});

const StatsGroupedResponseSchema = z
  .object({
    groups: z.array(StatsGroupSchema),
  })
  .openapi("StatsGroupedResponse");


// --- Register Paths ---

registry.registerPath({
  method: "get",
  path: "/health",
  summary: "Health check",
  responses: {
    200: {
      description: "Service is healthy",
      content: { "application/json": { schema: HealthResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/buffer/next",
  summary: "Pull the next lead from the buffer",
  request: {
    params: z.object({}),
    body: {
      content: { "application/json": { schema: BufferNextRequestSchema } },
    },
  },
  parameters: BufferNextHeaders,
  responses: {
    200: {
      description: "Next lead from buffer",
      content: { "application/json": { schema: BufferNextResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/leads",
  summary: "List leads with enrichment and delivery status",
  description:
    "Returns leads from leads_campaigns. Each lead includes a 'status' field: " +
    "'served' (pulled and served), 'buffered'/'skipped'/'claimed' (still pending). " +
    "Served leads include Apollo enrichment data, apolloPersonId, emailStatus, and full delivery status " +
    "(contacted, sent, delivered, opened, clicked, bounced, unsubscribed, replied, replyClassification, lastDeliveredAt, global). " +
    "Buffer entries have delivery fields defaulted to false/null. " +
    "Delivery status is fetched from email-gateway when brandId or campaignId is provided. " +
    "With campaignId: campaign-scoped status. With brandId only: brand-scoped (cross-campaign). " +
    "Without either: status fields default to false/null.",
  parameters: [
    ...AuthHeaders,
    {
      in: "query" as const,
      name: "brandId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "campaignId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "orgId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "userId",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  responses: {
    200: {
      description: "List of served leads",
      content: { "application/json": { schema: LeadsResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/stats",
  summary: "Get lead stats by status",
  description:
    "Returns lead stats with outreach status from email-gateway. totalLeads = served leads count, byOutreachStatus = full recipientStats (contacted, sent, delivered, opened, clicked, bounced, unsubscribed, replies*), repliesDetail = granular reply breakdown, buffered/skipped = buffer counts.",
  parameters: [
    ...AuthHeaders,
    {
      in: "query" as const,
      name: "brandId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "campaignId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "orgId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "userId",
      required: false,
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "runIds",
      required: false,
      description: "Comma-separated list of run IDs",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "workflowSlug",
      required: false,
      description: "Filter by exact workflow slug (single value)",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "workflowSlugs",
      required: false,
      description:
        "Filter by multiple workflow slugs (comma-separated). Takes priority over workflowSlug.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "featureSlug",
      required: false,
      description: "Filter by exact feature slug (single value)",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "featureSlugs",
      required: false,
      description:
        "Filter by multiple feature slugs (comma-separated). Takes priority over featureSlug.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "workflowDynastySlug",
      required: false,
      description:
        "Filter by workflow dynasty slug. Resolved to all versioned slugs via workflow-service, then filtered with WHERE IN (...). Takes priority over workflowSlug.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "featureDynastySlug",
      required: false,
      description:
        "Filter by feature dynasty slug. Resolved to all versioned slugs via features-service, then filtered with WHERE IN (...). Takes priority over featureSlug.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "groupBy",
      required: false,
      description:
        "Group stats by this dimension. When set, returns { groups: [...] } instead of flat stats.",
      schema: {
        type: "string" as const,
        enum: [
          "campaignId",
          "brandId",
          "workflowSlug",
          "featureSlug",
          "workflowDynastySlug",
          "featureDynastySlug",
        ],
      },
    },
  ],
  responses: {
    200: {
      description:
        "Lead stats with outreach status. Without groupBy: flat response with totalLeads, byOutreachStatus, repliesDetail, buffered, skipped. With groupBy: grouped stats array.",
      content: {
        "application/json": {
          schema: z.union([StatsResponseSchema, StatsGroupedResponseSchema]),
        },
      },
    },
    400: {
      description: "Invalid groupBy value",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});


// --- Transfer Brand ---

const InternalApiKeyHeader = [
  {
    in: "header" as const,
    name: "x-api-key",
    required: true,
    schema: { type: "string" as const },
    description: "API key for authenticating requests",
  },
];

export const TransferBrandRequestSchema = z
  .object({
    sourceBrandId: z.string().uuid(),
    sourceOrgId: z.string().uuid(),
    targetOrgId: z.string().uuid(),
    targetBrandId: z.string().uuid().optional(),
  })
  .openapi("TransferBrandRequest");

const TransferBrandTableResultSchema = z.object({
  tableName: z.string(),
  count: z.number(),
});

const TransferBrandResponseSchema = z
  .object({
    updatedTables: z.array(TransferBrandTableResultSchema),
  })
  .openapi("TransferBrandResponse");

registry.registerPath({
  method: "post",
  path: "/internal/transfer-brand",
  summary: "Transfer a solo-brand from one org to another",
  description:
    "Updates org_id on all rows that reference exactly this one brand (solo-brand). " +
    "Co-branding rows (multiple brand IDs) are skipped. Idempotent — running twice is a no-op.",
  request: {
    body: {
      content: { "application/json": { schema: TransferBrandRequestSchema } },
    },
  },
  parameters: InternalApiKeyHeader,
  responses: {
    200: {
      description: "Transfer results per table",
      content: { "application/json": { schema: TransferBrandResponseSchema } },
    },
    400: {
      description: "Invalid request body",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "get",
  path: "/openapi.json",
  summary: "Get OpenAPI specification",
  responses: {
    200: { description: "OpenAPI JSON document" },
    404: { description: "Spec not generated" },
  },
});
