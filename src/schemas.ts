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
  {
    in: "header" as const,
    name: "x-goal",
    required: false,
    schema: { type: "string" as const },
    description: "Active goal enum/name for the campaign activity, when explicitly tagged by the caller.",
  },
  {
    in: "header" as const,
    name: "x-active-goal-id",
    required: false,
    schema: { type: "string" as const },
    description: "Active goal identifier for the campaign activity, when explicitly tagged by the caller.",
  },
  {
    in: "header" as const,
    name: "x-brand-profile-id",
    required: false,
    schema: { type: "string" as const },
    description: "Brand profile identifier for persona-scoped attribution, when explicitly tagged by the caller.",
  },
  {
    in: "header" as const,
    name: "x-audience-id",
    required: false,
    schema: { type: "string" as const },
    description: "Audience identifier (human-service audience.id) for attribution, when explicitly tagged by the caller.",
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

// --- Canonical lead views ---
//
// Every lead-bearing endpoint returns the same canonical FullLead shape.
// Built from structured DB columns only — no Apollo raw blob, no metadata
// passthrough. Clients can rely on field names + types being stable across
// upstream provider changes.

const ContactMethodViewSchema = z
  .object({
    channel: z
      .string()
      .openapi({
        description:
          "Contact channel kind. Currently used: 'email', 'phone'. Stable identifier — case-sensitive.",
        example: "email",
      }),
    value: z
      .string()
      .openapi({
        description:
          "Contact value (the actual email address, phone number, etc.). Unique per (leadId, channel).",
        example: "sara@cascobay.com",
      }),
    status: z
      .string()
      .nullable()
      .openapi({
        description:
          "Provider-reported status of the contact value (e.g. 'verified', 'unverified', 'extrapolated' for emails). null when not classified.",
        example: "verified",
      }),
    source: z
      .string()
      .openapi({
        description:
          "Where this contact method originated (e.g. 'apollo', 'manual', 'csv-upload').",
        example: "apollo",
      }),
  })
  .openapi("ContactMethodView", {
    description:
      "One contact endpoint attached to a lead — email, phone, or any other channel. Multiple rows per lead are possible.",
    example: {
      channel: "email",
      value: "sara@cascobay.com",
      status: "verified",
      source: "apollo",
    },
  });

const FundingEventSchema = z
  .object({
    id: z
      .string()
      .nullable()
      .openapi({
        description: "Apollo-assigned identifier for the funding event.",
        example: "fund_5f2a3b4c5d6e7f8a9b0c1d2e",
      }),
    date: z
      .string()
      .nullable()
      .openapi({
        description: "ISO date (YYYY-MM-DD) of the funding event.",
        example: "2024-06-01",
      }),
    type: z
      .string()
      .nullable()
      .openapi({
        description: "Funding round type (e.g. 'Seed', 'Series A', 'Series B').",
        example: "Series A",
      }),
    investors: z
      .string()
      .nullable()
      .openapi({
        description: "Comma-separated list of investors as reported by Apollo.",
        example: "Acme VC, Foo Capital",
      }),
    amount: z
      .number()
      .nullable()
      .openapi({
        description: "Amount raised in this round, in the round's currency.",
        example: 5000000,
      }),
    currency: z
      .string()
      .nullable()
      .openapi({
        description: "ISO 4217 currency code for the amount.",
        example: "USD",
      }),
    newsUrl: z
      .string()
      .nullable()
      .openapi({
        description:
          "URL to a news article announcing this funding event. Mapped from Apollo's snake_case `news_url` to camelCase for consistency with the rest of the API surface.",
        example: "https://techcrunch.com/2024/06/01/casco-bay-series-a",
      }),
  })
  .openapi("FundingEvent", {
    description:
      "One funding round attached to an organization. All fields are nullable because Apollo's coverage is best-effort.",
    example: {
      id: "fund_5f2a3b4c5d6e7f8a9b0c1d2e",
      date: "2024-06-01",
      type: "Series A",
      investors: "Acme VC, Foo Capital",
      amount: 5000000,
      currency: "USD",
      newsUrl: "https://techcrunch.com/2024/06/01/casco-bay-series-a",
    },
  });

const OrganizationViewSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .openapi({
        description: "Internal organization UUID (lead-service registry).",
        example: "10000000-0000-0000-0000-000000000001",
      }),
    apolloOrganizationId: z
      .string()
      .nullable()
      .openapi({
        description: "Apollo organization ID — present when sourced from Apollo enrichment.",
        example: "5f2a3b4c5d6e7f8a9b0c1d2e",
      }),
    name: z
      .string()
      .nullable()
      .openapi({
        description: "Company name as registered. Use this for recipientCompany on outbound email.",
        example: "Casco Bay",
      }),
    primaryDomain: z
      .string()
      .nullable()
      .openapi({
        description: "Primary domain of the company (no protocol). Useful for domain-level deliverability or matching.",
        example: "cascobay.com",
      }),
    websiteUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Canonical company website URL (with protocol).",
        example: "https://cascobay.com",
      }),
    industry: z
      .string()
      .nullable()
      .openapi({
        description: "Primary industry classification.",
        example: "marketing",
      }),
    estimatedNumEmployees: z
      .number()
      .int()
      .nullable()
      .openapi({
        description: "Estimated employee count.",
        example: 12,
      }),
    annualRevenue: z
      .string()
      .nullable()
      .openapi({
        description:
          "Annual revenue (USD), serialized as a numeric string to avoid float precision loss for very large companies.",
        example: "1000000",
      }),
    logoUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Logo image URL.",
        example: "https://logo.clearbit.com/cascobay.com",
      }),
    shortDescription: z
      .string()
      .nullable()
      .openapi({
        description: "Short marketing-style description of the company.",
        example: "Boutique digital marketing agency in Portland, ME.",
      }),
    linkedinUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Company LinkedIn URL.",
        example: "https://linkedin.com/company/cascobay",
      }),
    twitterUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Company Twitter/X URL.",
        example: "https://twitter.com/cascobay",
      }),
    facebookUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Company Facebook URL.",
        example: "https://facebook.com/cascobay",
      }),
    blogUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Company blog URL.",
        example: "https://cascobay.com/blog",
      }),
    crunchbaseUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Crunchbase profile URL.",
        example: "https://crunchbase.com/organization/cascobay",
      }),
    foundedYear: z
      .number()
      .int()
      .nullable()
      .openapi({
        description: "Year the company was founded.",
        example: 2018,
      }),
    city: z
      .string()
      .nullable()
      .openapi({
        description: "Company HQ city.",
        example: "Portland",
      }),
    state: z
      .string()
      .nullable()
      .openapi({
        description: "Company HQ state / province (ISO subdivision when available).",
        example: "ME",
      }),
    country: z
      .string()
      .nullable()
      .openapi({
        description: "Company HQ country.",
        example: "USA",
      }),
    streetAddress: z
      .string()
      .nullable()
      .openapi({
        description: "Company HQ street address.",
        example: "123 Main St",
      }),
    postalCode: z
      .string()
      .nullable()
      .openapi({
        description: "Company HQ postal / ZIP code.",
        example: "04101",
      }),
    technologyNames: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Technologies the company is known to use (e.g. 'GA4', 'Salesforce').",
        example: ["GA4", "HubSpot"],
      }),
    industries: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "All industry classifications attached to this company.",
        example: ["marketing", "advertising"],
      }),
    secondaryIndustries: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Secondary industry classifications.",
        example: ["digital-marketing"],
      }),
    latestFundingStage: z
      .string()
      .nullable()
      .openapi({
        description:
          "Most recent funding stage label as reported by Apollo (e.g. 'seed', 'series_a', 'series_b'). null when never funded or unknown.",
        example: "series_a",
      }),
    latestFundingRoundDate: z
      .string()
      .nullable()
      .openapi({
        description: "ISO date (YYYY-MM-DD) of the most recent funding round. null when unknown.",
        example: "2024-06-01",
      }),
    totalFunding: z
      .string()
      .nullable()
      .openapi({
        description:
          "Total funding raised, in USD, serialized as a numeric string to avoid float precision loss for very large amounts.",
        example: "5000000",
      }),
    totalFundingPrinted: z
      .string()
      .nullable()
      .openapi({
        description: "Human-friendly total-funding string from Apollo (e.g. '$5M', '$1.2B').",
        example: "$5M",
      }),
    fundingEvents: z
      .array(FundingEventSchema)
      .openapi({
        description:
          "Per-round funding history. Empty array when no funding events are known. Apollo's snake_case `news_url` is mapped to camelCase `newsUrl` for API consistency.",
        example: [
          {
            id: "fund_5f2a3b4c5d6e7f8a9b0c1d2e",
            date: "2024-06-01",
            type: "Series A",
            investors: "Acme VC, Foo Capital",
            amount: 5000000,
            currency: "USD",
            newsUrl: "https://techcrunch.com/2024/06/01/casco-bay-series-a",
          },
        ],
      }),
    retailLocationCount: z
      .number()
      .int()
      .nullable()
      .openapi({
        description: "Number of physical retail locations the organization operates.",
        example: 3,
      }),
    publiclyTradedSymbol: z
      .string()
      .nullable()
      .openapi({
        description:
          "Stock ticker symbol when the company is publicly traded. null for private companies.",
        example: "AAPL",
      }),
    publiclyTradedExchange: z
      .string()
      .nullable()
      .openapi({
        description:
          "Stock exchange where the company is listed (e.g. 'NASDAQ', 'NYSE'). null for private companies.",
        example: "NASDAQ",
      }),
    primaryPhone: z
      .string()
      .nullable()
      .openapi({
        description: "Primary phone number for the company (E.164 when available).",
        example: "+15555550100",
      }),
    seoDescription: z
      .string()
      .nullable()
      .openapi({
        description:
          "Long-form SEO meta description scraped from the company's website. Distinct from `shortDescription` (which is editorial / Apollo-curated).",
        example: "Casco Bay is a boutique digital marketing agency based in Portland, Maine.",
      }),
    angellistUrl: z
      .string()
      .nullable()
      .openapi({
        description: "AngelList / Wellfound profile URL.",
        example: "https://angel.co/cascobay",
      }),
    numSuborganizations: z
      .number()
      .int()
      .nullable()
      .openapi({
        description: "Count of subsidiaries / sub-organizations associated with this company.",
        example: 0,
      }),
    alexaRanking: z
      .number()
      .int()
      .nullable()
      .openapi({
        description: "Alexa global website rank (smaller = more popular). null when unranked.",
        example: 250000,
      }),
    keywords: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Free-form keywords that describe the company (Apollo-curated).",
        example: ["marketing", "branding", "digital"],
      }),
  })
  .openapi("OrganizationView", {
    description:
      "Snapshot of the lead's CURRENT employer organization, joined from leads_organizations where current=true. " +
      "All fields are nullable because organization enrichment is best-effort. " +
      "null at the parent level means the lead has no current employment record.",
    example: {
      id: "10000000-0000-0000-0000-000000000001",
      apolloOrganizationId: "5f2a3b4c5d6e7f8a9b0c1d2e",
      name: "Casco Bay",
      primaryDomain: "cascobay.com",
      websiteUrl: "https://cascobay.com",
      industry: "marketing",
      estimatedNumEmployees: 12,
      annualRevenue: "1000000",
      logoUrl: "https://logo.clearbit.com/cascobay.com",
      shortDescription: "Boutique digital marketing agency in Portland, ME.",
      linkedinUrl: "https://linkedin.com/company/cascobay",
      twitterUrl: null,
      facebookUrl: null,
      blogUrl: null,
      crunchbaseUrl: null,
      foundedYear: 2018,
      city: "Portland",
      state: "ME",
      country: "USA",
      streetAddress: null,
      postalCode: "04101",
      technologyNames: ["GA4", "HubSpot"],
      industries: ["marketing", "advertising"],
      secondaryIndustries: null,
      latestFundingStage: "series_a",
      latestFundingRoundDate: "2024-06-01",
      totalFunding: "5000000",
      totalFundingPrinted: "$5M",
      fundingEvents: [
        {
          id: "fund_5f2a3b4c5d6e7f8a9b0c1d2e",
          date: "2024-06-01",
          type: "Series A",
          investors: "Acme VC, Foo Capital",
          amount: 5000000,
          currency: "USD",
          newsUrl: "https://techcrunch.com/2024/06/01/casco-bay-series-a",
        },
      ],
      retailLocationCount: null,
      publiclyTradedSymbol: null,
      publiclyTradedExchange: null,
      primaryPhone: "+15555550100",
      seoDescription: "Casco Bay is a boutique digital marketing agency based in Portland, Maine.",
      angellistUrl: null,
      numSuborganizations: 0,
      alexaRanking: 250000,
      keywords: ["marketing", "branding", "digital"],
    },
  });

const EmploymentEntryViewSchema = z
  .object({
    organizationId: z
      .string()
      .uuid()
      .openapi({
        description: "Internal organization UUID for this employment row.",
        example: "10000000-0000-0000-0000-000000000001",
      }),
    organizationName: z
      .string()
      .nullable()
      .openapi({
        description: "Organization name at time of join. May differ from current name if company was renamed.",
        example: "Casco Bay",
      }),
    title: z
      .string()
      .nullable()
      .openapi({
        description: "Role title held during this employment.",
        example: "Founder",
      }),
    startDate: z
      .string()
      .nullable()
      .openapi({
        description: "ISO date (YYYY-MM-DD) when this employment started. null when unknown.",
        example: "2018-01-01",
      }),
    endDate: z
      .string()
      .nullable()
      .openapi({
        description: "ISO date (YYYY-MM-DD) when this employment ended. null when current or unknown.",
        example: null,
      }),
    current: z
      .boolean()
      .openapi({
        description: "True when this is the lead's current employment.",
        example: true,
      }),
    description: z
      .string()
      .nullable()
      .openapi({
        description: "Free-form description of the role.",
        example: "Leads strategy and operations.",
      }),
  })
  .openapi("EmploymentEntryView", {
    description:
      "One employment row from the lead's career history. All rows from leads_organizations are returned (past + current).",
    example: {
      organizationId: "10000000-0000-0000-0000-000000000001",
      organizationName: "Casco Bay",
      title: "Founder",
      startDate: "2018-01-01",
      endDate: null,
      current: true,
      description: "Leads strategy and operations.",
    },
  });

export const FullLeadSchema = z
  .object({
    leadId: z
      .string()
      .uuid()
      .openapi({
        description: "Internal lead UUID (lead-service registry). Stable across enrichment refreshes.",
        example: "00000000-0000-0000-0000-000000000001",
      }),
    apolloPersonId: z
      .string()
      .nullable()
      .openapi({
        description: "Apollo person ID — present when the lead was sourced or enriched via Apollo.",
        example: "5f2a3b4c5d6e7f8a9b0c1d2e",
      }),
    firstName: z
      .string()
      .openapi({
        description:
          "Lead's first name. Required — lead-service refuses to register a lead without one. " +
          "Use this for recipientFirstName on outbound email.",
        example: "Sara",
      }),
    lastName: z
      .string()
      .openapi({
        description:
          "Lead's last name. Required. Use this for recipientLastName on outbound email.",
        example: "Freshley",
      }),
    name: z
      .string()
      .nullable()
      .openapi({
        description: "Full display name as provided by source (often 'firstName lastName' but not always).",
        example: "Sara Freshley",
      }),
    headline: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's professional headline / current role line (e.g. LinkedIn-style headline).",
        example: "Founder at Casco Bay",
      }),
    linkedinUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's LinkedIn profile URL.",
        example: "https://linkedin.com/in/sara-freshley",
      }),
    photoUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's profile photo URL.",
        example: "https://media.licdn.com/photo.jpg",
      }),
    city: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's city.",
        example: "Portland",
      }),
    state: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's state / province.",
        example: "ME",
      }),
    country: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's country.",
        example: "USA",
      }),
    seniority: z
      .string()
      .nullable()
      .openapi({
        description: "Seniority bucket from enrichment (e.g. 'founder', 'director', 'vp').",
        example: "founder",
      }),
    departments: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Department classifications.",
        example: ["c_suite"],
      }),
    subdepartments: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Subdepartment classifications.",
        example: ["founders"],
      }),
    functions: z
      .array(z.string())
      .nullable()
      .openapi({
        description: "Job function classifications.",
        example: ["entrepreneurship"],
      }),
    twitterUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's Twitter / X profile URL.",
        example: "https://twitter.com/sara",
      }),
    githubUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's GitHub profile URL.",
        example: "https://github.com/sara",
      }),
    facebookUrl: z
      .string()
      .nullable()
      .openapi({
        description: "Lead's Facebook profile URL.",
        example: "https://facebook.com/sara",
      }),
    enrichedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "ISO 8601 timestamp of last successful enrichment. null when the lead was registered without enrichment.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    currentTitle: z
      .string()
      .nullable()
      .openapi({
        description:
          "Lead's current role title — derived from the leads_organizations row where current=true. " +
          "Mirrors `employmentHistory[].title` for the current entry; surfaced top-level for convenient template binding " +
          "(e.g. `recipientTitle` on outbound email). null when the lead has no current employment row or the row has no title.",
        example: "Founder",
      }),
    organization: OrganizationViewSchema.nullable(),
    contacts: z
      .array(ContactMethodViewSchema)
      .openapi({
        description: "All contact methods attached to this lead — email, phone, etc. May be empty.",
        example: [
          { channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
        ],
      }),
    employmentHistory: z
      .array(EmploymentEntryViewSchema)
      .openapi({
        description:
          "Full employment history (current + past). Returned in insertion order; check the `current` flag to find the present role.",
        example: [
          {
            organizationId: "10000000-0000-0000-0000-000000000001",
            organizationName: "Casco Bay",
            title: "Founder",
            startDate: "2018-01-01",
            endDate: null,
            current: true,
            description: null,
          },
        ],
      }),
  })
  .openapi("FullLead", {
    description:
      "Canonical lead representation returned by every lead-bearing endpoint. Built entirely from structured columns — there is no `metadata` or `raw` Apollo passthrough. Field names are stable regardless of upstream enrichment provider.",
    example: {
      leadId: "00000000-0000-0000-0000-000000000001",
      apolloPersonId: "5f2a3b4c5d6e7f8a9b0c1d2e",
      firstName: "Sara",
      lastName: "Freshley",
      name: "Sara Freshley",
      headline: "Founder at Casco Bay",
      linkedinUrl: "https://linkedin.com/in/sara-freshley",
      photoUrl: null,
      city: "Portland",
      state: "ME",
      country: "USA",
      seniority: "founder",
      departments: ["c_suite"],
      subdepartments: ["founders"],
      functions: ["entrepreneurship"],
      twitterUrl: null,
      githubUrl: null,
      facebookUrl: null,
      enrichedAt: "2026-01-01T00:00:00.000Z",
      currentTitle: "Founder",
      organization: {
        id: "10000000-0000-0000-0000-000000000001",
        apolloOrganizationId: "5f2a3b4c5d6e7f8a9b0c1d2e",
        name: "Casco Bay",
        primaryDomain: "cascobay.com",
        websiteUrl: "https://cascobay.com",
        industry: "marketing",
        estimatedNumEmployees: 12,
        annualRevenue: "1000000",
        logoUrl: "https://logo.clearbit.com/cascobay.com",
        shortDescription: "Boutique digital marketing agency in Portland, ME.",
        linkedinUrl: "https://linkedin.com/company/cascobay",
        twitterUrl: null,
        facebookUrl: null,
        blogUrl: null,
        crunchbaseUrl: null,
        foundedYear: 2018,
        city: "Portland",
        state: "ME",
        country: "USA",
        streetAddress: null,
        postalCode: "04101",
        technologyNames: ["GA4", "HubSpot"],
        industries: ["marketing", "advertising"],
        secondaryIndustries: null,
        latestFundingStage: "series_a",
        latestFundingRoundDate: "2024-06-01",
        totalFunding: "5000000",
        totalFundingPrinted: "$5M",
        fundingEvents: [
          {
            id: "fund_5f2a3b4c5d6e7f8a9b0c1d2e",
            date: "2024-06-01",
            type: "Series A",
            investors: "Acme VC, Foo Capital",
            amount: 5000000,
            currency: "USD",
            newsUrl: "https://techcrunch.com/2024/06/01/casco-bay-series-a",
          },
        ],
        retailLocationCount: null,
        publiclyTradedSymbol: null,
        publiclyTradedExchange: null,
        primaryPhone: "+15555550100",
        seoDescription: "Casco Bay is a boutique digital marketing agency based in Portland, Maine.",
        angellistUrl: null,
        numSuborganizations: 0,
        alexaRanking: 250000,
        keywords: ["marketing", "branding", "digital"],
      },
      contacts: [
        { channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
      ],
      employmentHistory: [
        {
          organizationId: "10000000-0000-0000-0000-000000000001",
          organizationName: "Casco Bay",
          title: "Founder",
          startDate: "2018-01-01",
          endDate: null,
          current: true,
          description: null,
        },
      ],
    },
  });

// --- Buffer Next ---

export const BufferNextRequestSchema = z
  .object({})
  .openapi("BufferNextRequest", {
    description:
      "Empty body. The brand, feature, goal, and run identity are read from headers; lead-service resolves the audience (features-service) and serves the next person (human-service). No filters and no provider are accepted — human-service owns both.",
  });

const ServedLeadSchema = z
  .object({
    leadId: z
      .string()
      .uuid()
      .openapi({
        description:
          "Internal lead UUID. Same as data.leadId — kept at the top level for backwards compatibility with workflow scripts that read it directly.",
        example: "00000000-0000-0000-0000-000000000001",
      }),
    email: z
      .string()
      .openapi({
        description:
          "The email address selected for outreach. Always populated when found=true. Same address appears in data.contacts for the 'email' channel.",
        example: "sara@cascobay.com",
      }),
    data: FullLeadSchema,
    brandIds: z
      .array(z.string())
      .openapi({
        description: "Brand UUIDs this lead was buffered for (echoed back from x-brand-id header).",
        example: ["20000000-0000-0000-0000-000000000001"],
      }),
    orgId: z
      .string()
      .nullable()
      .openapi({
        description: "Internal organization UUID owning the campaign.",
        example: "30000000-0000-0000-0000-000000000001",
      }),
    userId: z
      .string()
      .nullable()
      .openapi({
        description: "Internal user UUID who triggered the campaign run.",
        example: "40000000-0000-0000-0000-000000000001",
      }),
    apolloPersonId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Apollo person ID — same value as data.apolloPersonId.",
        example: "5f2a3b4c5d6e7f8a9b0c1d2e",
      }),
    goal: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Explicit active goal tag for this served lead. null means unattributed.",
        example: "signup",
      }),
    activeGoalId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Explicit active goal ID tag for this served lead. null means unattributed.",
        example: "goal_123",
      }),
    brandProfileId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Explicit brand profile ID tag for this served lead. null means unattributed.",
        example: "brand_profile_123",
      }),
    audienceId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Audience ID (human-service audience.id) this served lead is attributed to. null means unattributed.",
        example: "audience_123",
      }),
  })
  .openapi("ServedLead", {
    description:
      "A single lead served from the campaign buffer. The full lead payload lives under `data` (FullLead shape).",
  });

export const BufferNextResponseSchema = z
  .object({
    found: z
      .boolean()
      .openapi({
        description: "True when a lead was claimed and returned. False when no lead can be served right now.",
        example: true,
      }),
    lead: ServedLeadSchema.optional(),
    reason: z
      .enum(["credit_insufficient"])
      .optional()
      .openapi({
        description:
          "Optional reason when found=false. credit_insufficient means the org has no available platform credits, so no paid enrichment/search/LLM action was performed.",
        example: "credit_insufficient",
      }),
  })
  .openapi("BufferNextResponse", {
    description:
      "Response from POST /orgs/buffer/next. When found is true, lead contains the served lead with full canonical FullLead payload under `lead.data`.",
    examples: [
      {
        summary: "Apollo lead",
        value: {
          found: true,
          lead: {
            leadId: "00000000-0000-0000-0000-000000000001",
            email: "sara@cascobay.com",
            data: {
              leadId: "00000000-0000-0000-0000-000000000001",
              apolloPersonId: "5f2a3b4c5d6e7f8a9b0c1d2e",
              firstName: "Sara",
              lastName: "Freshley",
              name: "Sara Freshley",
              headline: "Founder at Casco Bay",
              linkedinUrl: "https://linkedin.com/in/sara-freshley",
              photoUrl: null,
              city: "Portland",
              state: "ME",
              country: "USA",
              seniority: "founder",
              departments: ["c_suite"],
              subdepartments: null,
              functions: null,
              twitterUrl: null,
              githubUrl: null,
              facebookUrl: null,
              enrichedAt: "2026-01-01T00:00:00.000Z",
              currentTitle: "Founder",
              organization: {
                id: "10000000-0000-0000-0000-000000000001",
                apolloOrganizationId: "5f2a3b4c5d6e7f8a9b0c1d2e",
                name: "Casco Bay",
                primaryDomain: "cascobay.com",
                websiteUrl: "https://cascobay.com",
                industry: "marketing",
                estimatedNumEmployees: 12,
                annualRevenue: "1000000",
                logoUrl: null,
                shortDescription: null,
                linkedinUrl: null,
                twitterUrl: null,
                facebookUrl: null,
                blogUrl: null,
                crunchbaseUrl: null,
                foundedYear: 2018,
                city: "Portland",
                state: "ME",
                country: "USA",
                streetAddress: null,
                postalCode: null,
                technologyNames: ["GA4"],
                industries: ["marketing"],
                secondaryIndustries: null,
                latestFundingStage: "series_a",
                latestFundingRoundDate: "2024-06-01",
                totalFunding: "5000000",
                totalFundingPrinted: "$5M",
                fundingEvents: [],
                retailLocationCount: null,
                publiclyTradedSymbol: null,
                publiclyTradedExchange: null,
                primaryPhone: null,
                seoDescription: null,
                angellistUrl: null,
                numSuborganizations: null,
                alexaRanking: null,
                keywords: null,
              },
              contacts: [
                { channel: "email", value: "sara@cascobay.com", status: "verified", source: "apollo" },
              ],
              employmentHistory: [
                {
                  organizationId: "10000000-0000-0000-0000-000000000001",
                  organizationName: "Casco Bay",
                  title: "Founder",
                  startDate: "2018-01-01",
                  endDate: null,
                  current: true,
                  description: null,
                },
              ],
            },
            brandIds: ["20000000-0000-0000-0000-000000000001"],
            orgId: "30000000-0000-0000-0000-000000000001",
            userId: "40000000-0000-0000-0000-000000000001",
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
      {
        summary: "Insufficient credits",
        value: {
          found: false,
          reason: "credit_insufficient",
        },
      },
    ],
  });

// --- Leads ---

const LeadDetailSchema = z
  .object({
    id: z
      .string()
      .uuid()
      .openapi({
        description: "leads_campaigns row UUID (per-campaign per-lead lifecycle row, NOT the lead itself).",
        example: "50000000-0000-0000-0000-000000000001",
      }),
    leadId: z
      .string()
      .uuid()
      .nullable()
      .openapi({
        description: "Internal lead UUID. Null only when the row references a lead that was deleted.",
        example: "00000000-0000-0000-0000-000000000001",
      }),
    namespace: z
      .string()
      .openapi({
        description: "Namespace this lead was sourced from. Currently always 'apollo'.",
        example: "apollo",
      }),
    email: z
      .string()
      .openapi({
        description: "The email address tied to this leads_campaigns row.",
        example: "sara@cascobay.com",
      }),
    status: z
      .enum(["buffered", "skipped", "claimed", "served"])
      .openapi({
        description:
          "Lead lifecycle status in this campaign. 'buffered'/'skipped'/'claimed'/'served' all live in leads_campaigns; 'served' = pulled and served to a workflow.",
        example: "served",
      }),
    statusReason: z
      .string()
      .nullable()
      .openapi({
        description:
          "Why this lead is in its current status (e.g. 'already_contacted', 'bounced'). Set for skipped/buffered leads.",
        example: "already_contacted",
      }),
    statusDetails: z
      .string()
      .nullable()
      .openapi({
        description: "Human-readable details about the status reason.",
        example: "Lead was contacted in campaign abc-123 on 2026-01-01.",
      }),
    parentRunId: z
      .string()
      .nullable()
      .openapi({
        description: "Run ID of the workflow that pulled / processed this lead.",
        example: "run-uuid",
      }),
    runId: z
      .string()
      .nullable()
      .openapi({
        description: "Run ID for the campaign-tick that produced this lead.",
        example: "run-uuid",
      }),
    brandIds: z
      .array(z.string())
      .openapi({
        description: "Brand UUIDs this lead was buffered for.",
        example: ["20000000-0000-0000-0000-000000000001"],
      }),
    campaignId: z
      .string()
      .openapi({
        description: "Campaign ID owning this leads_campaigns row.",
        example: "60000000-0000-0000-0000-000000000001",
      }),
    orgId: z
      .string()
      .openapi({
        description: "Internal organization UUID.",
        example: "30000000-0000-0000-0000-000000000001",
      }),
    userId: z
      .string()
      .nullable()
      .openapi({
        description: "Internal user UUID who triggered the campaign run.",
        example: "40000000-0000-0000-0000-000000000001",
      }),
    workflowSlug: z
      .string()
      .nullable()
      .openapi({
        description: "Workflow slug that processed this lead (e.g. 'sales-cold-email-outreach-helium').",
        example: "sales-cold-email-outreach-helium",
      }),
    featureSlug: z
      .string()
      .nullable()
      .openapi({
        description: "Feature slug for tracking.",
        example: "outreach",
      }),
    goal: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Explicit active goal tag stored on the leads_campaigns row. null means unattributed.",
        example: "signup",
      }),
    activeGoalId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Explicit active goal ID stored on the leads_campaigns row. null means unattributed.",
        example: "goal_123",
      }),
    brandProfileId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Explicit brand profile ID stored on the leads_campaigns row. null means unattributed.",
        example: "brand_profile_123",
      }),
    audienceId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Audience ID (human-service audience.id) stored on the leads_campaigns row. null means unattributed.",
        example: "audience_123",
      }),
    servedAt: z
      .string()
      .nullable()
      .openapi({
        description: "ISO timestamp when this lead was served. null for buffered/skipped/claimed rows.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    apolloPersonId: z
      .string()
      .nullable()
      .openapi({
        description: "Apollo person ID — convenience copy of lead.apolloPersonId.",
        example: "5f2a3b4c5d6e7f8a9b0c1d2e",
      }),
    emailStatus: z
      .string()
      .nullable()
      .openapi({
        description: "Email verification status from Apollo (verified, unverified, extrapolated, etc.).",
        example: "verified",
      }),
    lead: FullLeadSchema.nullable(),
    contacted: z
      .boolean()
      .openapi({
        description: "Lead has been contacted at least once in this scope (campaign or brand depending on query).",
        example: true,
      }),
    sent: z
      .boolean()
      .openapi({
        description: "An email send has been attempted.",
        example: true,
      }),
    delivered: z
      .boolean()
      .openapi({
        description: "Provider confirmed delivery.",
        example: true,
      }),
    opened: z
      .boolean()
      .openapi({
        description: "Lead has opened at least one email.",
        example: false,
      }),
    clicked: z
      .boolean()
      .openapi({
        description: "Lead has clicked at least one tracked link.",
        example: false,
      }),
    bounced: z
      .boolean()
      .openapi({
        description: "Email bounced.",
        example: false,
      }),
    unsubscribed: z
      .boolean()
      .openapi({
        description: "Lead unsubscribed in this scope.",
        example: false,
      }),
    replied: z
      .boolean()
      .openapi({
        description: "Whether the lead replied (any reply, regardless of sentiment).",
        example: false,
      }),
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
        example: null,
      }),
    lastDeliveredAt: z
      .string()
      .nullable()
      .openapi({
        description: "ISO timestamp of the last delivered message in this scope.",
        example: "2026-01-02T00:00:00.000Z",
      }),
    firstClickedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of a click in this scope; " +
          "null if the lead never clicked in scope. Scoped identically to `clicked` " +
          "(brand-scoped when brandId is passed, campaign-scoped when campaignId is passed).",
        example: "2026-01-02T00:00:00.000Z",
      }),
    firstContactedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of a contacted event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status. " +
          "For building the per-lead event timeline.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    firstSentAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of a sent event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    firstDeliveredAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of a delivered event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    firstOpenedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of an opened event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    firstRepliedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of a replied event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    firstBouncedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of a bounced event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    firstUnsubscribedAt: z
      .string()
      .nullable()
      .openapi({
        description:
          "First-occurrence (MIN) ISO 8601 timestamp of an unsubscribed event in this scope; " +
          "null if it never happened in scope. Passed through from email-gateway status.",
        example: "2026-01-01T00:00:00.000Z",
      }),
    global: z
      .object({
        bounced: z.boolean().openapi({ description: "Lead has bounced anywhere across the platform.", example: false }),
        unsubscribed: z.boolean().openapi({ description: "Lead has unsubscribed anywhere across the platform.", example: false }),
      })
      .openapi({
        description: "Global-scope status (across all brands/campaigns). bounced and unsubscribed are global flags.",
      }),
  })
  .openapi("LeadDetail", {
    description:
      "One leads_campaigns row enriched with the full canonical lead payload (FullLead) and delivery status from email-gateway.",
  });

const LeadsResponseSchema = z
  .object({
    leads: z.array(LeadDetailSchema).openapi({
      description: "All leads_campaigns rows matching the query, with full canonical lead payload + delivery overlay.",
    }),
  })
  .openapi("LeadsResponse", {
    description: "Response shape for GET /orgs/leads.",
  });

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
  description:
    "Claims and returns the next available lead from the campaign buffer. " +
    "Response contains the full canonical lead payload (FullLead) under `lead.data` — " +
    "use `data.firstName`, `data.lastName`, `data.organization.name` for outbound recipient fields.",
  request: {
    params: z.object({}),
    body: {
      content: { "application/json": { schema: BufferNextRequestSchema } },
    },
  },
  parameters: BufferNextHeaders,
  responses: {
    200: {
      description: "Next lead from buffer (or found=false when exhausted)",
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
  summary: "List leads with full enrichment and delivery status",
  description:
    "Returns leads_campaigns rows. Each row includes the full canonical lead payload (FullLead — see schema) under `lead`, " +
    "plus delivery status (contacted, sent, delivered, opened, clicked, bounced, unsubscribed, replied, replyClassification, lastDeliveredAt, firstClickedAt, global). " +
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
    {
      in: "query" as const,
      name: "workflowSlug",
      required: false,
      description:
        "Restrict returned leads to those whose leads_campaigns row has workflow_slug = <value>. " +
        "When absent, behavior + response shape are unchanged.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "view",
      required: false,
      description:
        "Per-lead payload size. `basic` returns a slim `lead` object: " +
        "firstName, lastName, name, headline, linkedinUrl, photoUrl, apolloPersonId, " +
        "seniority, departments, functions, currentTitle, city, state, country " +
        "+ organization {id, name, logoUrl, primaryDomain, websiteUrl, industry, industries, " +
        "estimatedNumEmployees, annualRevenue, foundedYear, shortDescription, city, state, country}. " +
        "Field names/types are identical to the full FullLead/OrganizationView. " +
        "Still drops the heavy stuff (employmentHistory, subdepartments, technologyNames, " +
        "secondaryIndustries, funding events) so basic stays ~10x smaller than full. " +
        "Absent or any other value => the full FullLead payload (default, " +
        "backward-compatible). Use `basic` for list views.",
      schema: { type: "string" as const, enum: ["basic", "full"] },
    },
  ],
  responses: {
    200: {
      description: "List of leads with full canonical payload + delivery overlay",
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
    "Returns lead stats with outreach status from email-gateway. totalLeads = served leads count, byOutreachStatus = full recipientStats (contacted, sent, delivered, opened, clicked, bounced, unsubscribed, replies*), repliesDetail = granular reply breakdown, buffered/skipped = buffer counts. " +
    "When filtering or grouping by goal/profile/persona attribution fields, lead-service joins explicit leads_campaigns tags to recipient-level email-gateway evidence. Untagged rows stay unattributed and do not produce persona/profile groups.",
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
      name: "goal",
      required: false,
      description: "Filter stats to rows explicitly tagged with this active goal.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "activeGoalId",
      required: false,
      description: "Filter stats to rows explicitly tagged with this active goal ID.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "brandProfileId",
      required: false,
      description: "Filter stats to rows explicitly tagged with this brand profile ID.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "audienceId",
      required: false,
      description: "Filter stats to rows explicitly tagged with this audience ID.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "groupBy",
      required: false,
      description:
        "Group stats by this dimension. When set, returns { groups: [...] } instead of flat stats. Attribution groupings are explicit-only: null attribution rows are omitted, not assigned to an unknown bucket.",
      schema: {
        type: "string" as const,
        enum: [
          "campaignId",
          "brandId",
          "workflowSlug",
          "featureSlug",
          "workflowDynastySlug",
          "featureDynastySlug",
          "goal",
          "activeGoalId",
          "brandProfileId",
          "audienceId",
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
  {
    in: "header" as const,
    name: "x-run-id",
    required: true,
    schema: { type: "string" as const },
    description: "Idempotency key — replaying with the same x-run-id returns the cached response",
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

// --- Feature memberships (internal) ---

const FeatureMembershipApiKeyHeader = [
  {
    in: "header" as const,
    name: "x-api-key",
    required: true,
    schema: { type: "string" as const },
    description: "API key for authenticating requests",
  },
];

const FeatureMembershipSchema = z
  .object({
    orgId: z
      .string()
      .openapi({
        description: "Internal organization UUID owning the leads.",
        example: "30000000-0000-0000-0000-000000000001",
      }),
    brandId: z
      .string()
      .openapi({
        description: "Brand UUID (unnested from leads_campaigns.brand_ids).",
        example: "20000000-0000-0000-0000-000000000001",
      }),
    workflowSlug: z
      .string()
      .openapi({
        description: "Workflow slug that produced leads for this (org, brand) under the requested feature.",
        example: "sales-cold-email-outreach-lithium",
      }),
  })
  .openapi("FeatureMembership", {
    description:
      "One distinct (org, brand, workflow) combination that has leads for a requested feature.",
  });

const FeatureMembershipsResponseSchema = z
  .object({
    memberships: z.array(FeatureMembershipSchema).openapi({
      description:
        "Distinct (orgId, brandId, workflowSlug) tuples from leads_campaigns whose feature_slug matches the requested feature(s). Empty array when no matches.",
    }),
  })
  .openapi("FeatureMembershipsResponse", {
    description: "Response shape for GET /internal/feature-memberships.",
  });

registry.registerPath({
  method: "get",
  path: "/internal/feature-memberships",
  summary: "List distinct (org, brand, workflow) combinations that have leads for a feature",
  description:
    "Returns the DISTINCT (orgId, brandId, workflowSlug) tuples from leads_campaigns whose feature_slug matches the requested feature(s). " +
    "featureSlugs is comma-separated and matched exactly (feature slugs are not versioned). brandId is unnested from brand_ids[]. " +
    "Rows with a null workflow_slug are excluded. Empty array when no matches. Auth: x-api-key only.",
  parameters: [
    ...FeatureMembershipApiKeyHeader,
    {
      in: "query" as const,
      name: "featureSlugs",
      required: true,
      description: "Comma-separated list of feature slugs to resolve memberships for.",
      schema: { type: "string" as const },
    },
  ],
  responses: {
    200: {
      description: "Distinct (org, brand, workflow) memberships for the requested feature(s)",
      content: { "application/json": { schema: FeatureMembershipsResponseSchema } },
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
