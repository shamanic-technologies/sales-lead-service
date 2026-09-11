import { z } from "zod";
import {
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
// The published `reason` enum IS the empty-serve vocabulary — read it from the one module
// that declares it, so the contract cannot drift from what the serve path actually returns.
import { SERVE_EMPTY_REASONS } from "./lib/serve-reasons.js";
import {
  LEAD_STANDING_SIGNALS,
  LEAD_STANDING_STATES,
  LEAD_STANDING_UNRESOLVED_REASONS,
} from "./lib/lead-standing.js";
import { FUNNEL_KEYS } from "./lib/funnel-steps.js";


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
    description: "Feature slug for tracking (propagated through the call path)",
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
    timezone: z
      .string()
      .nullable()
      .openapi({
        description:
          "Recipient's IANA timezone (e.g. 'America/New_York'), resolved upstream from the lead's location. " +
          "Forward this to the send path so cold email is scheduled in the recipient's local business hours " +
          "(email-gateway-service → instantly-service). null when upstream provides none — the send path falls back to a safe default.",
        example: "America/New_York",
      }),
    businessLanguages: z
      .array(z.string())
      .nullable()
      .openapi({
        description:
          "Language(s) this lead plausibly conducts business in, as ISO 639-1 codes (e.g. 'de', 'fr', 'it'). " +
          "ORDERED, most plausible first — the ordering is a guarantee, so a consumer may select by position " +
          "(index 0 = the single most plausible business language). Produced and owned by human-service; " +
          "lead-service carries it through unchanged and never derives it. An EMPTY array means UNKNOWN — the " +
          "producer had no usable signal and deliberately does not fabricate one, which is distinct from ['en'] " +
          "(= known to be English). null means the lead predates this field being carried, and is equally not a guess.",
        example: ["de", "en"],
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
      timezone: "America/New_York",
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
      .enum(SERVE_EMPTY_REASONS)
      .optional()
      .openapi({
        description:
          "Why the answer is empty. Always present when found=false; absent when a lead was served. " +
          "ONLY `audience_exhausted` is evidence that a population ran out — human-service walked the " +
          "audience this service was told to serve and reported nobody left. Every other value states " +
          "that no exhaustion was observed: `no_audience` means the caller sent no x-audience-id, so " +
          "this service (which never picks audiences) looked at nobody; `serve_timed_out` means the " +
          "serve budget expired before the look finished; `audience_not_serveable` means the named " +
          "audience has no committed provider yet, so its population is unknown rather than empty; " +
          "`credit_insufficient` means the org has no platform credit, so no paid enrichment/search/LLM " +
          "action was performed. Decide whether outreach may stop by testing for `audience_exhausted` " +
          "specifically — never by excluding known-benign values, so a reason added later defaults to " +
          "not-exhaustion.",
        example: "audience_exhausted",
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
              timezone: "America/New_York",
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

/**
 * Where one lead stands on the campaign it was served under — the SERVED answer to "is this
 * person still a live prospect", so a consumer renders a value instead of deriving one of its own.
 */
const ClosedDealSchema = z
  .object({
    occurredAt: z.string().nullable().openapi({
      description:
        "When the deal closed, ISO-8601 — the date the person stating it gave, not the date they " +
        "typed it. Null only when genuinely undated; never fabricated.",
      example: "2026-08-19T14:30:00.000Z",
    }),
    valueCents: z.number().int().nullable().openapi({
      description:
        "What the deal was worth, in cents. A sale stated from now on always carries one (the " +
        "write refuses a sale with no value); null means nobody said, NOT zero.",
      example: 490000,
    }),
    costCents: z.number().int().nullable().openapi({
      description:
        "What the CUSTOMER states closing it cost THEM, in cents. 0 is a stated zero; null means " +
        "nobody was ever asked. Never platform spend and never billed.",
      example: 12000,
    }),
    causedByOutreach: z.boolean().nullable().openapi({
      description:
        "WHOSE win it was. true — the customer states OUR outreach caused this deal. false — they " +
        "state something else of theirs did (a referral, a conference, their existing pipeline, " +
        "another agency): the deal is REAL, it stays among the brand's own closes and in every " +
        "count, it is simply not one to compute the return on our outreach from. null — NOBODY WAS " +
        "ASKED, which is what every deal stated before this existed reads as, and what a " +
        "tracker-reported one always reads as (a page-load tag cannot know why somebody bought). " +
        "Null is never read as either answer.",
      example: true,
    }),
    source: z.enum(["tracker", "manual"]).openapi({
      description: "manual — a human stated the deal; tracker — the website tag reported it.",
    }),
  })
  .openapi("LeadClosedDeal", {
    description:
      "The deal on this lead, when somebody has stated one — what it was worth, what closing it " +
      "cost the customer, and whose win it was. Derived on read from the same statements the " +
      "standing is, so withdrawing or restating one moves it with no write.",
  });

const LeadStandingSchema = z
  .object({
    state: z.enum(LEAD_STANDING_STATES as unknown as [string, ...string[]]).openapi({
      description:
        "Where this person stands on THIS campaign, decided by lead-service and by nobody else. " +
        "`sales_interest` = they reached the step this campaign's sales funnel is entered by (a " +
        "visit on a visit-led funnel, a positive reply on a conversation-led one) or a later step " +
        "of it. `customer` = the funnel's last step (the sale) is reached. `opted_out` = the person " +
        "asked not to be contacted (an unsubscribe, at this scope or globally); it is their own " +
        "act, it is legally binding, and NOTHING overrides it — not a click, not a stated sale. " +
        "`disqualified` = a commercial judgement of OURS: we realised they are not our target at " +
        "all (the wrong contact, or gone from the role), or somebody stated they never will buy. " +
        "The two are separate states, never folded together, because a board draws them as two " +
        "columns with different copy and different moves and has to be able to count them apart. " +
        "A prospect who simply DECLINES " +
        "is not disqualified: that is a judgement about the moment, they stay reachable and the " +
        "lead stays recyclable, so they read as `engaged` with `signal: \"negative_reply\"`. " +
        "`engaged` = something " +
        "happened that is not the step this campaign sells. `contacted` = written to, nothing " +
        "since — INCLUDING a lead whose mail bounced, which is a failure of delivery rather than " +
        "an opinion about the person, and is named by `signal: \"bounced\"` rather than used as a " +
        "verdict. `not_contacted` = never written to. `unresolved` = a signal could not be resolved " +
        "and is stated as such rather than defaulted — read `reason`. A consumer needs to know " +
        "none of the reply kinds or funnel step names to use this.",
      example: "sales_interest",
    }),
    signal: z.enum(LEAD_STANDING_SIGNALS as unknown as [string, ...string[]]).openapi({
      description:
        "Which single piece of evidence decided the state. `unsubscribed` is the prospect's own " +
        "act and never shares a state with a commercial judgement of ours — it decides " +
        "`opted_out`, which is its own countable, pageable standing rather than a shade of " +
        "`disqualified`. `disqualifying_reply` = the " +
        "delivery layer reports this person as permanently out (the wrong contact, or gone from " +
        "the role). `negative_reply` = they declined; that leaves them in play.",
      example: "measured_visit",
    }),
    origin: z
      .enum(["stated", "implied", "measured"])
      .nullable()
      .openapi({
        description:
          "Who said it: `stated` = a person stated it (or the website tracker reported it), " +
          "`implied` = the campaign's funnel implies it from another statement, `measured` = the " +
          "delivery layer measured it. null when nothing decided the state.",
        example: "measured",
      }),
    reason: z
      .enum(LEAD_STANDING_UNRESOLVED_REASONS as unknown as [string, ...string[]])
      .nullable()
      .openapi({
        description:
          "Why the state is `unresolved`, and null for every other state. `delivery_not_queried` " +
          "= the read named no brand or campaign, so the delivery layer was never asked. " +
          "`campaign_service_unavailable` / `campaign_unknown` / `funnel_unstated` = the " +
          "campaign's sales funnel could not be resolved, so there is no telling whether a click " +
          "is the step it sells. `statements_unreadable` = the hand-stated statements could not " +
          "be read. `reply_disqualification_unknown` = the reply reads as negative and the " +
          "provider serves no disqualification reading for it (a provider without reply " +
          "tracking, or a payload older than the field), so whether this is a decline about the " +
          "moment or a permanent fact about the person cannot be told apart here. Never a " +
          "plausible default.",
        example: null,
      }),
    funnelKey: z
      .enum(FUNNEL_KEYS as unknown as [string, ...string[]])
      .nullable()
      .openapi({
        description:
          "The sales funnel this campaign sells, as campaign-service states it. Never inferred " +
          "from the brand or from a goal; null when it could not be resolved.",
        example: "form_magnet",
      }),
    entryStep: z
      .string()
      .nullable()
      .openapi({
        description:
          "The step somebody takes to get ONTO this campaign's funnel, in the funnel vocabulary " +
          "brand-service publishes: `website_visit`, `conversation_reply` or `ad_click`. This is " +
          "what `sales_interest` means for this campaign.",
        example: "website_visit",
      }),
    entryMeasure: z
      .enum(["delivery_click", "positive_reply"])
      .nullable()
      .openapi({
        description:
          "Which signal that entry step is read off: `delivery_click` = a click on the email we " +
          "sent, `positive_reply` = a reply the delivery layer classified as positive. null when " +
          "this service holds no signal for it at all (an ad click), which is why " +
          "`reachedEntryStep` is null on ads-led funnels rather than false.",
        example: "delivery_click",
      }),
    reachedEntryStep: z
      .boolean()
      .nullable()
      .openapi({
        description:
          "Whether this person got onto the campaign's funnel. Answered separately from `state` " +
          "because both can be true at once: somebody who clicked and then unsubscribed reached " +
          "the entry step AND is disqualified. null — never false — when the signal for it cannot " +
          "be resolved.",
        example: true,
      }),
    deepestStep: z
      .string()
      .nullable()
      .openapi({
        description:
          "The deepest step of this campaign's funnel known to have been reached, in this " +
          "service's outcome vocabulary. null when no step is known reached.",
        example: null,
      }),
    at: z
      .string()
      .nullable()
      .openapi({
        description: "When the deciding statement was made, when a statement decided the state.",
        example: null,
      }),
  })
  .openapi("LeadStanding", {
    description:
      "The single served answer to 'where does this lead stand on this campaign'. Additive: every " +
      "raw delivery fact (contacted, clicked, replied, replyClassification, unsubscribed, …) stays " +
      "on the row beside it, unchanged, and a consumer that ignores this field keeps working.",
  });


/** The offer card a campaign names — same shape as `offer` on a lead row. */
const OfferCardSchema = z.object({
  id: z.string().openapi({ description: "Offer UUID (brand-service offer.offerId).", example: "0ffe0000-0000-4000-8000-000000000001" }),
  name: z.string().nullable().openapi({ description: "Offer display name, from brand-service.", example: "Fractional CFO retainer" }),
});

/**
 * The delivery evidence of ONE campaign — the same fields the row carries at top level, answering
 * for that campaign alone instead of for the brand.
 */
const LeadCampaignDeliverySchema = z.object({
  contacted: z.boolean(),
  sent: z.boolean(),
  delivered: z.boolean(),
  opened: z.boolean(),
  clicked: z.boolean(),
  bounced: z.boolean(),
  unsubscribed: z.boolean(),
  replied: z.boolean(),
  replyClassification: z.enum(["positive", "negative", "neutral"]).nullable(),
  disqualified: z.boolean().optional().openapi({
    description:
      "Tri-state: true = the provider reports this person as permanently out, false = it looked " +
      "and says no, ABSENT = nobody can tell us. Never collapsed to a boolean.",
  }),
  sentCount: z.number(),
  lastDeliveredAt: z.string().nullable(),
  firstContactedAt: z.string().nullable(),
  firstSentAt: z.string().nullable(),
  firstDeliveredAt: z.string().nullable(),
  firstOpenedAt: z.string().nullable(),
  firstClickedAt: z.string().nullable(),
  firstRepliedAt: z.string().nullable(),
  firstBouncedAt: z.string().nullable(),
  firstUnsubscribedAt: z.string().nullable(),
  global: z.object({ bounced: z.boolean(), unsubscribed: z.boolean() }),
}).openapi("LeadCampaignDelivery", {
  description:
    "Delivery evidence scoped to ONE campaign identity. Deliberately WITHOUT the brand-contacted " +
    "widening the campaign-scoped read applies: re-applying it here would restamp brand-wide " +
    "evidence onto every card, which is what these cards exist to stop.",
});

/**
 * One campaign card under a person: what that campaign is, and what happened IN IT.
 */
const LeadCampaignEvidenceSchema = z
  .object({
    id: z.string().uuid().openapi({
      description:
        "The leads_campaigns row this card speaks for — addressable at GET /orgs/leads/{id}.",
      example: "50000000-0000-0000-0000-000000000002",
    }),
    campaignId: z.string().openapi({
      description: "The campaign row that membership names.",
      example: "60000000-0000-0000-0000-000000000002",
    }),
    campaignIds: z.array(z.string()).openapi({
      description:
        "Every stored campaign id whose evidence this card reads — the campaign IDENTITY's " +
        "members (org, brand, sales funnel, acquisition channel), restricted to the read's own " +
        "campaign scope when it has one. `[campaignId]` when the identity could not be resolved.",
      example: ["60000000-0000-0000-0000-000000000002"],
    }),
    status: z.enum(["buffered", "skipped", "claimed", "served"]).openapi({
      description: "Lifecycle status of this person in this campaign.",
      example: "served",
    }),
    servedAt: z.string().nullable().openapi({
      description: "When this person was served to this campaign.",
      example: "2026-01-01T00:00:00.000Z",
    }),
    audienceId: z.string().nullable().openapi({
      description: "The audience tagged on this membership row, when it carries one.",
      example: null,
    }),
    offer: OfferCardSchema.nullable().openapi({
      description: "The offer this campaign sells — the same card the row's `offer` names.",
    }),
    standing: LeadStandingSchema.openapi({
      description:
        "Where this person stands ON THIS CAMPAIGN, resolved exactly as the row-level standing " +
        "is. A card whose delivery evidence the provider cannot speak to reads `unresolved` with " +
        "`reason: \"delivery_not_queried\"` unless a hand statement decides it — never " +
        "`not_contacted`.",
    }),
    delivery: LeadCampaignDeliverySchema.nullable().openapi({
      description:
        "The delivery evidence for THIS campaign alone, read out of the per-campaign breakdown " +
        "email-gateway returns in brand mode. **null means the provider reports none for this " +
        "campaign — 'we cannot tell', NOT 'nothing happened'.** An all-false status is never " +
        "substituted for it, because the two are different facts.",
    }),
  })
  .openapi("LeadCampaignEvidence", {
    description:
      "One campaign of a person, with the delivery evidence of that campaign alone. The row's own " +
      "top-level delivery fields stay the BRAND-wide roll-up; these cards are the per-campaign " +
      "answer beside them, so a consumer can tell 'this campaign reached them' from 'some " +
      "campaign of this brand did' without aggregating anything itself.",
  });

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
    offer: z
      .object({
        id: z
          .string()
          .openapi({
            description: "Offer UUID (brand-service offer.offerId).",
            example: "0ffe0000-0000-4000-8000-000000000001",
          }),
        name: z
          .string()
          .nullable()
          .openapi({
            description:
              "Offer display name, from brand-service. null when the campaign names an offer " +
              "brand-service does not list back (a deleted offer, or a brand that could not be " +
              "reached) — the id is still true, so it is stated rather than dropping the offer.",
            example: "Fractional CFO retainer",
          }),
      })
      .nullable()
      .openapi({
        description:
          "The OFFER this lead belongs to — brand-service's proposition level, between the brand " +
          "and the campaign. Resolved server-side as the offer named by the campaign the lead was " +
          "served under (`campaignId` above, the attribution frozen on the leads_campaigns row), " +
          "with its name read from brand-service. null when that campaign names no offer, and also " +
          "when the resolution was unavailable (logged loudly server-side) — never inferred from " +
          "the lead's brand, its funnel or a sibling campaign. Present on every lead in both views.",
      }),
    audienceId: z
      .string()
      .nullable()
      .optional()
      .openapi({
        description: "Audience ID (human-service audience.id) stored on the leads_campaigns row. null means unattributed.",
        example: "audience_123",
      }),
    audience: z
      .object({
        id: z.string().openapi({ description: "Audience UUID (human-service audience.id).", example: "audience_123" }),
        name: z.string().openapi({ description: "Audience display name.", example: "US SaaS founders" }),
        avatarUrl: z
          .string()
          .nullable()
          .openapi({ description: "Audience avatar URL. null when the audience has no avatar yet.", example: "https://cdn.example.com/aud.png" }),
      })
      .nullable()
      .openapi({
        description:
          "The lead's ACTIVE audience for this brand, resolved server-side by human-service " +
          "(by tagged audience_id and/or by email → active-audience membership, brand-correct). " +
          "null when the lead belongs to no active audience for the brand. Present on every lead in both views.",
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
    standing: LeadStandingSchema.openapi({
      description:
        "Where this lead stands on the campaign it was served under, decided here so that two " +
        "surfaces cannot say different things about the same person. Derived on read from the " +
        "delivery evidence below plus the hand-stated step statements this service owns; nothing " +
        "is stored, so a retracted or withdrawn statement moves it with no write.",
    }),
    closedDeal: ClosedDealSchema.nullable().openapi({
      description:
        "The deal on this lead — worth, cost to the customer, and WHOSE win it was — or null when " +
        "nobody has stated one. It is here so a table can render a column per lead over pages of " +
        "rows without a request per lead, and so a consumer can hold the deals our outreach caused " +
        "apart from the ones the brand closed some other way. Present at every scope this read " +
        "supports. Derived on read: nothing is stored, so withdrawing or restating the statement " +
        "moves it with no write.",
    }),
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
    sentCount: z
      .number()
      .openapi({
        description:
          "Count of emails actually sent to this lead in the outreach sequence " +
          "(initial + follow-ups), summed across providers. Passed through from " +
          "email-gateway delivery status, scoped identically to `sent` " +
          "(brand-scoped when brandId is passed, campaign-scoped when campaignId is passed). " +
          "0 when no send has occurred (or the source count is absent).",
        example: 2,
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
    campaigns: z
      .array(LeadCampaignEvidenceSchema)
      .optional()
      .openapi({
        description:
          "This person's campaigns within the read's scope, each card stating what happened IN " +
          "THAT CAMPAIGN. Present ONLY when the caller passes `?include=campaigns`; absent " +
          "otherwise, so every existing consumer's response is byte-identical. " +
          "This exists because a brand-scoped read answers one row per PERSON and its top-level " +
          "delivery fields are the BRAND-wide roll-up — 56,809 people in production sit in more " +
          "than one campaign of one brand, so nesting campaign cards under a person without this " +
          "would print byte-identical evidence under every card. Both facts are served at once: " +
          "the brand-wide roll-up stays exactly where it was (the leads table's status badge, its " +
          "tabs, the triage board and the covered-lead count all read it), and these cards answer " +
          "the per-campaign question beside it. A card whose `delivery` is null means the provider " +
          "reports no evidence for that campaign — 'we cannot tell', never 'no'.",
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
      description:
        "The leads_campaigns rows matching the query, with full canonical lead payload + delivery overlay. " +
        "Without `limit` this is every matching row; with `limit` it is at most that many, in " +
        "(created_at, id) ascending order.",
    }),
    nextCursor: z.string().nullable().openapi({
      description:
        "Where to resume the walk: pass it back as `?cursor=` to get the rows strictly after the " +
        "last one in this response. null means this response reached the end of the population — " +
        "always null for an unbounded read (no `limit`).",
    }),
    total: z.number().int().optional().openapi({
      description:
        "How many leads match this read's filter IN TOTAL — the number the page is a window onto, " +
        "so a consumer can page rather than hold the population. Present whenever the caller named " +
        "a bound (`limit` / `offset` / `cursor`) or a filter (`q` / `bucket` / `sort`); ABSENT on " +
        "an unbounded, unfiltered read, whose response is unchanged byte for byte. Counted over " +
        "the same relation the rows come from, so the two can never describe different populations.",
      example: 12945,
    }),
  })
  .openapi("LeadsResponse", {
    description: "Response shape for GET /orgs/leads.",
  });

const LeadDetailResponseSchema = z
  .object({
    leadDetail: LeadDetailSchema.openapi({
      description:
        "The one lead the caller named, byte-equal to the element GET /orgs/leads emits for the " +
        "same row — a detail panel renders from it alone.",
    }),
  })
  .openapi("LeadDetailResponse", {
    description:
      "Response shape for GET /orgs/leads/{id}. One record, not a list: a consumer asking for one " +
      "lead should not be constructing a list query.",
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
    "plus delivery status (contacted, sent, sentCount, delivered, opened, clicked, bounced, unsubscribed, replied, replyClassification, lastDeliveredAt, firstClickedAt, global). " +
    "Delivery status is fetched from email-gateway when brandId or campaignId is provided. " +
    "With campaignId: campaign-scoped status. With brandId only: brand-scoped (cross-campaign). " +
    "Without either: status fields default to false/null. " +
    "By default the response carries the ACTIONABLE population only — `buffered`, `claimed` and " +
    "`served` — and NOT `skipped`; use the `status` parameter to ask for a different set. " +
    "The response is UNBOUNDED unless the caller names a `limit`: without one it carries every " +
    "matching row (what the staff console and features-service want). With `limit` it carries at " +
    "most that many rows plus a `nextCursor` to walk the rest with. Rows come back in " +
    "(created_at, id) ascending order, which is a total order, so a `limit` + `cursor` walk visits " +
    "every row exactly once — no gaps, no repeats.",
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
      name: "include",
      required: false,
      description:
        "Comma-separated extras. The only value is `campaigns`: nest this person's campaigns " +
        "(within the read's scope) under each row, each card carrying the delivery evidence and " +
        "standing OF THAT CAMPAIGN ALONE. Absent means today's response byte for byte; an unknown " +
        "value is a 400, never silently dropped. A card's `delivery: null` means the provider " +
        "reports no evidence for that campaign — 'we cannot tell', not 'no'.",
      schema: { type: "string" as const, example: "campaigns" },
    },
    {
      in: "query" as const,
      name: "offerId",
      required: false,
      description:
        "Restrict returned leads to ONE offer — brand-service's proposition level, between the " +
        "brand and the campaign. A lead's offer is the offer named by the campaign it was served " +
        "under: the membership row's `campaign_id` is a frozen attribution, and campaign-service " +
        "records which offer each campaign sells, so this resolves to every campaign in the org " +
        "naming that offer and filters on the same `campaign_id` a campaignId read filters on. " +
        "Delivery status is offer-scoped (the union over those campaigns), the same way a " +
        "campaign identity's is. " +
        "MUTUALLY EXCLUSIVE with `campaignId` — a campaign already sells exactly one offer, so " +
        "naming both is a 400 rather than one silently winning. " +
        "An offer no campaign sells yet returns an empty list, never the brand's leads. " +
        "If campaign-service cannot say which campaigns sell it, the read is refused with a 502 — " +
        "never widened to the brand. " +
        "When absent, behavior + response shape are unchanged.",
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
    {
      in: "query" as const,
      name: "status",
      required: false,
      description:
        "Which lifecycle statuses to return, as a comma-separated list of " +
        "`buffered`, `skipped`, `claimed`, `served` — or `all` for every one of them. " +
        "ABSENT => `buffered,claimed,served`: the population a caller can act on. " +
        "`skipped` rows are excluded by default because they were never served, so they carry no " +
        "delivery evidence (every engagement field on them is false/null by construction) and no " +
        "engagement-bucketed view can reach them — while being ~82% of the rows for a large brand. " +
        "Pass `all` (or name `skipped` explicitly) to get them back. " +
        "An unknown value is a 400, never a silent fallback.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "limit",
      required: false,
      description:
        "Maximum number of leads to return. ABSENT => unbounded: every matching row, which is what " +
        "the staff console and features-service read. Present => at most that many rows, and a " +
        "`nextCursor` when more may follow. There is no server-imposed ceiling; the caller decides " +
        "how much it can hold. A value that is not a positive integer is a 400.",
      schema: { type: "integer" as const, minimum: 1 },
    },
    {
      in: "query" as const,
      name: "cursor",
      required: false,
      description:
        "Resume position, taken verbatim from a previous response's `nextCursor`. Returns the rows " +
        "strictly after it in (created_at, id) order, so a walk sees every row exactly once even " +
        "while new leads are being written. Mutually exclusive with `offset`; naming both is a 400, " +
        "as is a cursor this endpoint did not issue.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "offset",
      required: false,
      description:
        "Positional start over the same (created_at, id) order — the positional form of the walk. " +
        "Rows are appended in that order, so an offset walk is stable against new leads, but a row " +
        "leaving the filtered set mid-walk shifts it; `cursor` cannot drift that way and is the " +
        "one to prefer. Mutually exclusive with `cursor`. A negative or non-integer value is a 400.",
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      in: "query" as const,
      name: "q",
      required: false,
      description:
        "Free-text search over the person's name, their job title, their email address and their " +
        "company's name — evaluated over the WHOLE matching population, not over a page. Words are " +
        "split on whitespace and EVERY word must match at least one of those fields, so two words " +
        "narrow rather than widen. Case-insensitive substring matching; `%` and `_` are matched " +
        "literally. `total` on the response is the number of matches. Blank, longer than 200 " +
        "characters, or more than 8 words is a 400 — never a silently ignored search.",
      schema: { type: "string" as const, example: "jane acme" },
    },
    {
      in: "query" as const,
      name: "bucket",
      required: false,
      description:
        "Restrict the read to ONE engagement bucket: `contacted`, `website_visit`, " +
        "`positive_reply`, `signup`, `meeting_booked`, `meeting_attended`, `form_submission`, " +
        "`sale`. Buckets are the tabs a leads page offers, and they are NOT exclusive — somebody " +
        "who bought was also contacted, and appears under both. `contacted` / `website_visit` / " +
        "`positive_reply` come from the delivery evidence at this read's scope (a website visit is " +
        "a measured click OR a hand-stated visit, unioned per person, never summed); the five " +
        "outcomes come from this service's live, attributed conversion ledger, tracker-reported " +
        "and hand-stated alike, withdrawn statements excluded. `total` is then the bucket's size. " +
        "GET /orgs/leads/bucket-counts answers every bucket's count without returning any rows. " +
        "An unknown value is a 400.",
      schema: { type: "string" as const, enum: [
        "contacted", "website_visit", "positive_reply", "signup", "meeting_booked",
        "meeting_attended", "form_submission", "sale",
      ] },
    },
    {
      in: "query" as const,
      name: "standing",
      required: false,
      description:
        "Restrict the read to one or SEVERAL standing states, comma-separated, read as ONE set: " +
        "`unresolved`, `not_contacted`, `contacted`, `engaged`, `sales_interest`, `customer`, " +
        "`disqualified`, `opted_out` (e.g. `standing=not_contacted,contacted,engaged`). A triage " +
        "board's COLUMN is not always one standing — five columns over eight states means two " +
        "columns hold two states each — and a column must page as one thing: one order, one " +
        "`total` (the size of the whole named set), one walkable cursor. Naming several here gives " +
        "exactly that; naming one behaves exactly as before. An opt-out is the prospect's own act " +
        "and `disqualified` is a commercial judgement of ours, so they stay two states and each " +
        "pages on its own. This is the `standing.state` " +
        "every row already carries — where the lead stands on the funnel ITS campaign sells, " +
        "decided by this service and rendered by everyone else. Unlike a `bucket` it IS a " +
        "partition: a lead has exactly one standing, so it is what a triage board draws a column " +
        "per. Naming a `bucket` too narrows to the rows satisfying both. `total` is then the " +
        "column's size, and GET /orgs/leads/standing-counts answers every column's size without " +
        "returning any rows (a consumer adds the counts of a column that holds two). An unknown " +
        "value is a 400, and so is an empty one — a set is never silently widened or narrowed. A " +
        "standing that cannot be resolved for this scope is a 502 — never a differently-filtered " +
        "list answered with a 200.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "sort",
      required: false,
      description:
        "The order rows come back in. ABSENT (or `created`) => `(created_at, id)` ascending, " +
        "exactly as this endpoint has always answered. `activity` => newest first on the timestamp " +
        "that proves each lead's most advanced status: an outcome by when it was recorded, a reply " +
        "by the reply, a click by the click, an open by the open, a send by the send, and down to " +
        "the moment the lead was served. Ties break on the row id, so both orders are TOTAL and a " +
        "`limit` + `cursor` walk visits every row exactly once — no gaps, no repeats. An unknown " +
        "value is a 400.",
      schema: { type: "string" as const, enum: ["created", "activity"] },
    },
    {
      in: "query" as const,
      name: "format",
      required: false,
      description:
        "ABSENT (or `json`) => the JSON response documented here. `csv` => the whole matching set " +
        "as a downloadable file (text/csv, Content-Disposition attachment), streamed, honouring " +
        "every scope, `status`, `q` and `bucket` — so an export is exactly what the page is " +
        "showing, without paging through it in the browser. The file is written to be READ: its " +
        "columns are headed in the words the Leads page uses (First name, Email status, Title, " +
        "Company domain, Contacted, Website visit, Reply sentiment, First replied at, ...), a " +
        "person suppressed across the whole org reads under `Bounced (any brand)` / " +
        "`Unsubscribed (any brand)` beside this brand's own `Bounced` / `Unsubscribed`, a " +
        "yes/no fact reads as `Yes`/`No`, and an instant reads as `YYYY-MM-DD HH:MM:SS` (UTC), " +
        "which every spreadsheet parses as a date. The facts are the slim projection flattened " +
        "(person, company, email, lifecycle, standing, delivery evidence) minus the internal row, " +
        "lead and campaign identifiers, which are join keys rather than something a customer " +
        "reads. The JSON response is untouched by any of this. `limit` and `cursor` are " +
        "irrelevant to a file. An unknown value is a 400.",
      schema: { type: "string" as const, enum: ["json", "csv"] },
    },
  ],
  responses: {
    200: {
      description: "List of leads with full canonical payload + delivery overlay",
      content: { "application/json": { schema: LeadsResponseSchema } },
    },
    400: {
      description:
        "Invalid `status`, `limit`, `cursor`, `offset`, `q`, `bucket`, `standing`, `sort` or " +
        "`format` value, or `offerId` and `campaignId` both named",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    502: {
      description:
        "`offerId` was named and campaign-service could not say which campaigns sell it — the read is refused rather than widened to the brand",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const LeadBucketCountsResponseSchema = z
  .object({
    total: z.number().int().openapi({
      description:
        "The whole scoped population — every lead the same list read would return for this scope, " +
        "including the people who carry no evidence at all and are therefore in no bucket. Bucket " +
        "membership is not exclusive and the counts do NOT sum to this.",
      example: 12945,
    }),
    counts: z
      .object({
        contacted: z.number().int(),
        website_visit: z.number().int(),
        positive_reply: z.number().int(),
        signup: z.number().int(),
        meeting_booked: z.number().int(),
        meeting_attended: z.number().int(),
        form_submission: z.number().int(),
        sale: z.number().int(),
      })
      .openapi({
        description:
          "How many people are in each engagement bucket. Every key is ALWAYS present — a bucket " +
          "nobody is in is 0, never absent. A consumer shows whichever of the five outcomes its " +
          "brand's funnel prices; this read does not decide that, because a brand can run several " +
          "funnels at once.",
      }),
  })
  .openapi("LeadBucketCountsResponse", {
    description: "Response shape for GET /orgs/leads/bucket-counts. Counts only — never any rows.",
  });

registry.registerPath({
  method: "get",
  path: "/orgs/leads/bucket-counts",
  summary: "Count the leads in each engagement bucket, without returning any of them",
  description:
    "Answers how many leads fall in each engagement bucket for a scope, and NO lead rows. A leads " +
    "page labels a tab per bucket and states its population; doing that by taking every lead and " +
    "counting them in the browser costs 44 MB and about 6.6s for one production brand, on a tab " +
    "that re-reads every 15 seconds and is far too large for the browser to cache — so the page " +
    "cold-loads on every visit. A count is a number, and a number should not cost a population. " +
    "Takes the SAME scope vocabulary as GET /orgs/leads, meaning the same thing: `brandId`, " +
    "`campaignId` (resolved to the whole campaign identity), `offerId`, `status` and `q`. The set " +
    "counted is therefore exactly the set `GET /orgs/leads` returns for those parameters, so a " +
    "tab's count and what the tab shows cannot disagree. " +
    "email-gateway unreachable is a 502 — never a count of zero.",
  parameters: [
    ...AuthHeaders,
    { in: "query" as const, name: "brandId", required: false, schema: { type: "string" as const } },
    { in: "query" as const, name: "campaignId", required: false, schema: { type: "string" as const } },
    {
      in: "query" as const,
      name: "offerId",
      required: false,
      description:
        "Restrict the counted population to one offer, exactly as on the list. Mutually exclusive " +
        "with `campaignId`. An offer no campaign sells yet counts zero, never the brand.",
      schema: { type: "string" as const },
    },
    { in: "query" as const, name: "orgId", required: false, schema: { type: "string" as const } },
    { in: "query" as const, name: "userId", required: false, schema: { type: "string" as const } },
    { in: "query" as const, name: "workflowSlug", required: false, schema: { type: "string" as const } },
    {
      in: "query" as const,
      name: "status",
      required: false,
      description:
        "Which lifecycle statuses to count, same vocabulary and same default as the list: absent " +
        "means `buffered,claimed,served`, the population a caller can act on.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "q",
      required: false,
      description:
        "Count within a free-text search, same fields and same rules as on the list — so the tab " +
        "counts follow the search box.",
      schema: { type: "string" as const },
    },
  ],
  responses: {
    200: {
      description: "How many leads are in each bucket, plus the scoped population",
      content: { "application/json": { schema: LeadBucketCountsResponseSchema } },
    },
    400: {
      description: "Invalid `status` or `q` value, or `offerId` and `campaignId` both named",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    502: {
      description:
        "The delivery evidence these counts are counted from could not be read — refused rather than answered with zeros",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const LeadStandingCountsResponseSchema = z
  .object({
    total: z.number().int().openapi({
      description:
        "The whole scoped population — every lead the same list read would return for this scope. " +
        "A standing is a PARTITION (one per lead), so the counts below SUM to this exactly.",
      example: 2052,
    }),
    counts: z
      .object({
        unresolved: z.number().int(),
        not_contacted: z.number().int(),
        contacted: z.number().int(),
        engaged: z.number().int(),
        sales_interest: z.number().int(),
        customer: z.number().int(),
        disqualified: z.number().int(),
        opted_out: z.number().int(),
      })
      .openapi({
        description:
          "How many leads stand in each state. Every key is ALWAYS present — a state nobody is in " +
          "is 0, never absent, so a consumer can draw a column per state without guessing. " +
          "`unresolved` is counted like any other: it is a stated non-answer (the campaign states " +
          "no funnel, campaign-service could not be reached, the read named no scope so the " +
          "delivery layer was never asked), and dropping it would make the columns fail to add up " +
          "to the population they say they are showing. `opted_out` and `disqualified` are two " +
          "separate keys — the prospect's own act versus a commercial judgement of ours — so each " +
          "of those columns can state its own size and be paged on its own via " +
          "`GET /orgs/leads?standing=opted_out` / `?standing=disqualified`.",
      }),
  })
  .openapi("LeadStandingCountsResponse", {
    description: "Response shape for GET /orgs/leads/standing-counts. Counts only — never any rows.",
  });

registry.registerPath({
  method: "get",
  path: "/orgs/leads/standing-counts",
  summary: "Count the leads in each standing state, without returning any of them",
  description:
    "Answers how many leads stand in each standing state for a scope, and NO lead rows. A triage " +
    "board draws one column per standing — still in play, sales interest, disqualified, opted out, " +
    "and the unresolved case — and states each column's size; doing that from a bounded page of " +
    "leads sorted in the browser makes every number on the screen describe a different population " +
    "(one production campaign: 2,052 leads in scope, 200 fetched, so the page reads '200 leads' " +
    "and '19 sales interests' directly beneath its own heading, which correctly reads '2,052 " +
    "leads'). A count is a number, and a number should not cost a population. " +
    "Takes the SAME scope vocabulary as GET /orgs/leads, meaning the same thing: `brandId`, " +
    "`campaignId` (resolved to the whole campaign identity), `offerId`, `status` and `q`, with the " +
    "same lifecycle default (`buffered,claimed,served`). The set counted is exactly the set " +
    "`GET /orgs/leads?standing=<state>` returns for those parameters, so a column's stated size " +
    "and what the column shows cannot disagree — and a board column holding SEVERAL standings adds " +
    "their counts here and draws them with one `?standing=a,b` read, which pages as one column. " +
    "Standing is a PARTITION — one per lead — so the " +
    "counts sum to `total` exactly, and `opted_out` (the prospect's own act) is counted apart " +
    "from `disqualified` (a commercial judgement of ours) so a board can size and page each of " +
    "those two columns on its own. " +
    "Standing is funnel-aware and per campaign — deliberately NOT the engagement-bucket " +
    "vocabulary, which asks what happened to somebody rather than where they stand; see " +
    "GET /orgs/leads/bucket-counts for that. " +
    "email-gateway unreachable, or a standing that cannot be resolved, is a 502 — never zeros.",
  parameters: [
    ...AuthHeaders,
    { in: "query" as const, name: "brandId", required: false, schema: { type: "string" as const } },
    { in: "query" as const, name: "campaignId", required: false, schema: { type: "string" as const } },
    {
      in: "query" as const,
      name: "offerId",
      required: false,
      description:
        "Restrict the counted population to one offer, exactly as on the list. Mutually exclusive " +
        "with `campaignId`. An offer no campaign sells yet counts zero, never the brand.",
      schema: { type: "string" as const },
    },
    { in: "query" as const, name: "orgId", required: false, schema: { type: "string" as const } },
    { in: "query" as const, name: "userId", required: false, schema: { type: "string" as const } },
    { in: "query" as const, name: "workflowSlug", required: false, schema: { type: "string" as const } },
    {
      in: "query" as const,
      name: "status",
      required: false,
      description:
        "Which lifecycle statuses to count, same vocabulary and same default as the list: absent " +
        "means `buffered,claimed,served`, the population a caller can act on.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "q",
      required: false,
      description:
        "Count within a free-text search, same fields and same rules as on the list — so the " +
        "column counts follow the search box.",
      schema: { type: "string" as const },
    },
  ],
  responses: {
    200: {
      description: "How many leads stand in each state, plus the scoped population",
      content: { "application/json": { schema: LeadStandingCountsResponseSchema } },
    },
    400: {
      description: "Invalid `status` or `q` value, or `offerId` and `campaignId` both named",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    502: {
      description:
        "The delivery evidence, or the funnel each campaign sells, could not be read — refused rather than answered with zeros",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/leads/{id}",
  summary: "Read ONE lead's full record",
  description:
    "Returns the full record of a single lead — the same object GET /orgs/leads emits for that row " +
    "(full canonical FullLead payload under `lead`, active audience, lifecycle fields and the " +
    "delivery overlay), wrapped as `{ leadDetail }` rather than a one-element list. " +
    "This is what a table + detail-panel surface reads: take the slim list for the table, then ask " +
    "for depth one row at a time, instead of holding the full projection for a whole brand " +
    "(~57k rows / >100 MB on the largest one) so that one panel can work. " +
    "`id` is the `id` field of a list row (the leads_campaigns membership row), so a caller needs " +
    "nothing it did not already receive from the list. Scoped like the list is: the read is " +
    "org-scoped and a lead outside the caller's org is a 404, indistinguishable from one that does " +
    "not exist. `brandId` / `campaignId` mean exactly what they mean on the list — which scope the " +
    "delivery overlay answers for — so passing back whatever the table listed with makes the panel " +
    "agree with the row.",
  parameters: [
    ...AuthHeaders,
    {
      in: "path" as const,
      name: "id",
      required: true,
      description: "The `id` of a lead as returned by GET /orgs/leads. A non-uuid value is a 400.",
      schema: { type: "string" as const, format: "uuid" },
    },
    {
      in: "query" as const,
      name: "include",
      required: false,
      description:
        "Comma-separated extras. The only value is `campaigns`: nest this person's campaigns " +
        "(within the read's scope) under each row, each card carrying the delivery evidence and " +
        "standing OF THAT CAMPAIGN ALONE. Absent means today's response byte for byte; an unknown " +
        "value is a 400, never silently dropped. A card's `delivery: null` means the provider " +
        "reports no evidence for that campaign — 'we cannot tell', not 'no'.",
      schema: { type: "string" as const, example: "campaigns" },
    },
    {
      in: "query" as const,
      name: "brandId",
      required: false,
      description:
        "Scope for the delivery overlay, same as on the list. A lead that does not belong to this " +
        "brand is a 404. Absent (and no campaignId) => the overlay fields default to false/null.",
      schema: { type: "string" as const },
    },
    {
      in: "query" as const,
      name: "campaignId",
      required: false,
      description:
        "Campaign scope for the delivery overlay, same as on the list — resolved to the whole " +
        "campaign IDENTITY, so evidence recorded under a stopped ancestor still counts.",
      schema: { type: "string" as const },
    },
  ],
  responses: {
    200: {
      description: "The lead's full record",
      content: { "application/json": { schema: LeadDetailResponseSchema } },
    },
    400: {
      description: "`id` is not a uuid",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Unauthorized" },
    404: {
      description: "No such lead in this caller's org (or brand, when brandId is given)",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
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

// --- Conversion tracking (beta) ---

const ConversionIngestRequestSchema = z
  .object({
    event: z
      .enum(["signup", "meeting_booked", "form_submission", "sale", "purchase", "ping"])
      .openapi({
        description:
          "The conversion that happened on the client's website. \"sale\" is the terminal " +
          "\"a customer paid\" signal (carries a revenue value in valueCents). The legacy spelling " +
          "\"purchase\" is still accepted and normalized to \"sale\" so already-configured " +
          "integrations keep firing. The special value \"ping\" is a liveness heartbeat the on-page " +
          "tag fires on page-load — it is NOT a conversion (no attribution, not counted, excluded " +
          "from eventTypesSeen), it only proves the tag is alive.",
        example: "sale",
      }),
    email: z.string().optional().openapi({ example: "jane@acme.com" }),
    phone: z.string().optional().openapi({ example: "+1 (415) 555-0142" }),
    firstName: z.string().optional().openapi({ example: "Jane" }),
    lastName: z.string().optional().openapi({ example: "Doe" }),
    companyUrl: z.string().optional().openapi({ example: "https://acme.com" }),
    dedupeKey: z.string().optional().openapi({
      description:
        "Client-supplied idempotency key. When present, uniqueness is per (brand, dedupeKey). " +
        "When absent, dedupe is per (brand, event, email-or-phone, calendar-day).",
    }),
    valueCents: z.number().int().optional().openapi({
      description:
        "Optional conversion value in cents — the revenue attached to the event (primarily the " +
        "\"sale\" terminal signal).",
      example: 4900,
    }),
  })
  .openapi("ConversionIngestRequest", {
    description: "A conversion event reported by a client's website pixel.",
  });

const ConversionIngestResponseSchema = z
  .object({ received: z.boolean().openapi({ example: true }) })
  .openapi("ConversionIngestResponse", {
    description:
      "Always { received: true } on success. The match/attribution result is NEVER leaked to the public caller.",
  });

const ConversionTokenResponseSchema = z
  .object({
    token: z.string().openapi({
      description:
        "Publishable write-key for this brand. Returned in FULL (it is embedded in a client-side pixel, so not a secret). Can only WRITE conversion events for its one brand.",
      example: "pk_conv_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
    }),
    ingestUrl: z.string().openapi({
      description: "Full public URL a third party hits for POST /public/conversions.",
      example: "https://api.distribute.you/public/conversions",
    }),
    status: z.enum(["not_set_up", "live_waiting", "live"]).openapi({
      description:
        "Tracker liveness, DERIVED from received signals (never self-attested). " +
        "not_set_up — nothing received yet; live_waiting — a ping proves the tag is alive but " +
        "no real conversion yet; live — at least one real conversion received.",
      example: "live_waiting",
    }),
    lastEventAt: z.string().nullable().openapi({
      description:
        "ISO-8601 timestamp of the last REAL conversion event (signup/meeting_booked/form_submission/sale), or null.",
      example: "2026-07-06T12:00:00.000Z",
    }),
    lastPingAt: z.string().nullable().openapi({
      description: "ISO-8601 timestamp of the last liveness ping, or null.",
      example: "2026-07-06T11:59:00.000Z",
    }),
    eventTypesSeen: z.array(z.string()).openapi({
      description:
        "Distinct REAL conversion event types actually received. Always EXCLUDES \"ping\".",
      example: ["signup"],
    }),
  })
  .openapi("ConversionTokenResponse", {
    description:
      "The brand's publishable conversion write-key, the public ingest URL, and a derived " +
      "liveness overlay (status + last event/ping timestamps + event types seen).",
  });

const ConversionTokenHeader = [
  {
    in: "header" as const,
    name: "x-conversion-token",
    required: false,
    schema: { type: "string" as const },
    description:
      "Brand publishable write-token. Alternatively pass it as `Authorization: Bearer <token>`.",
  },
];

const BrandIdPathParam = z.object({
  brandId: z.string().openapi({
    param: { name: "brandId", in: "path" },
    example: "20000000-0000-0000-0000-000000000001",
  }),
});

registry.registerPath({
  method: "post",
  path: "/public/conversions",
  summary: "Ingest a conversion event from a client's website (token-auth, public)",
  description:
    "Called directly by the CLIENT's website code (token-auth, NO Clerk). Authenticates the brand " +
    "publishable token, records the conversion, and attributes it to a lead we emailed for that brand " +
    "via a confidence-tiered match waterfall (email/phone → deterministic; domain+lastName → strong; " +
    "name-only → probabilistic, auto-attributed to the top candidate). Only strong-ambiguous " +
    "(domain+lastName with >1 candidate) is held for review. NEVER leaks the match result — " +
    "always { received: true } " +
    "on success. Dedupe: per (brand, dedupeKey) when supplied, else per (brand, event, email-or-phone, day). " +
    "The special event \"ping\" is a liveness heartbeat: it stamps the brand's last-ping time and returns " +
    "{ received: true } WITHOUT running attribution, storing a conversion, or counting toward stats.",
  request: {
    body: {
      content: { "application/json": { schema: ConversionIngestRequestSchema } },
    },
  },
  parameters: ConversionTokenHeader,
  responses: {
    200: {
      description: "Event received (match result intentionally not disclosed)",
      content: { "application/json": { schema: ConversionIngestResponseSchema } },
    },
    400: {
      description: "Missing or invalid event",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: { description: "Missing or invalid conversion token" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/brands/{brandId}/conversion-token",
  summary: "Get-or-create the brand's publishable conversion write-token",
  description:
    "Returns the brand's publishable conversion token (creating it on first call) plus the public ingest URL. " +
    "The token is returned in full — it is a publishable write-key, not a secret.",
  request: { params: BrandIdPathParam },
  parameters: AuthHeaders,
  responses: {
    200: {
      description: "The brand's conversion token and ingest URL",
      content: { "application/json": { schema: ConversionTokenResponseSchema } },
    },
    400: { description: "Missing x-org-id" },
    401: { description: "Unauthorized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/orgs/brands/{brandId}/conversion-token/rotate",
  summary: "Rotate the brand's publishable conversion write-token",
  description:
    "Replaces the brand's token with a fresh one and invalidates the old token (it immediately 401s on ingest). " +
    "Rotation is the abuse remedy for a leaked publishable key.",
  request: { params: BrandIdPathParam },
  parameters: AuthHeaders,
  responses: {
    200: {
      description: "The new conversion token and ingest URL",
      content: { "application/json": { schema: ConversionTokenResponseSchema } },
    },
    400: { description: "Missing x-org-id" },
    401: { description: "Unauthorized" },
  },
});

const StepCountsSchema = z.object({
  signup: z.number().int().openapi({ example: 12 }),
  meeting_booked: z.number().int().openapi({ example: 3 }),
  meeting_attended: z.number().int().openapi({ example: 2 }),
  form_submission: z.number().int().openapi({ example: 7 }),
  sale: z.number().int().openapi({ example: 2 }),
  website_visit: z.number().int().openapi({
    description:
      "Website visits known ONLY by hand: a visit stated for a lead whose click the delivery " +
      "layer already measured is NOT counted here, so this number can be ADDED to the measured " +
      "click count without counting anybody twice. Nothing about what the delivery layer " +
      "measures changes.",
    example: 1,
  }),
  purchase: z.number().int().openapi({ example: 2 }),
});

const ConversionCountsResponseSchema = z
  .object({
    counts: StepCountsSchema.openapi({
      description:
        "Count of REAL, deduped, attributed outcomes per step, BOTH sources together — what every " +
        "existing consumer reads, unchanged. All five canonical keys (signup, meeting_booked, " +
        "meeting_attended, form_submission, sale) are ALWAYS present (0 when none). " +
        "\"meeting_attended\" is statable by hand only (a page-load tag cannot observe somebody " +
        "showing up) and counts exactly like the four the tracker reports. The terminal event was " +
        "renamed \"purchase\" → \"sale\"; a legacy \"purchase\" key mirroring \"sale\" is also " +
        "returned for the migration window (drop once consumers read \"sale\"). Excludes the " +
        "\"ping\" liveness heartbeat, needs_review, and unmatched events. A \"never\" statement is " +
        "NOT an outcome and is counted by nothing here.",
    }),
    bySource: z
      .object({ tracker: StepCountsSchema, manual: StepCountsSchema })
      .openapi({
        description:
          "The SAME rows, split by who said so: tracker — reported by the client's website; " +
          "manual — stated by a human about a lead named by id. For every key, " +
          "tracker + manual === counts. This is how a hand-stated outcome stays distinguishable " +
          "from a tracker-reported one after the fact without changing what either counts toward.",
      }),
    byCause: z
      .object({
        outreach: StepCountsSchema,
        other: StepCountsSchema,
        unstated: StepCountsSchema,
      })
      .openapi({
        description:
          "The SAME rows, split by WHOSE WIN each outcome was. A brand contacts people through us " +
          "AND through everything else it already does — referrals, conferences, an existing " +
          "pipeline, another agency — so some of the people we email go on to buy for reasons that " +
          "have nothing to do with us. outreach — the customer states our outreach caused it. " +
          "other — they state something else of theirs did; the outcome is REAL, it stays in " +
          "`counts` and among the brand's own, it is simply not one to compute OUR return on. " +
          "unstated — NOBODY WAS ASKED: every outcome stated before this field existed and every " +
          "tracker-reported one (a page-load tag cannot know why somebody bought). `unstated` is " +
          "never folded into either answer. For every key, outreach + other + unstated === counts. " +
          "This is deliberately NOT the attributed / needs_review / unmatched vocabulary, which " +
          "answers whether we managed to identify WHO somebody was.",
      }),
  })
  .openapi("ConversionCountsResponse", {
    description:
      "Per-brand real conversion counts by event type, for features-service to compute real " +
      "signups / cost-per-signup.",
  });

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/conversion-counts",
  summary: "Real conversion counts per event type for a brand (internal, service-auth)",
  description:
    "INTERNAL (service-auth: x-api-key — same tier as other /internal/* routes, NO Clerk). Returns the " +
    "per-event-type COUNT of REAL, attributed conversions for the brand. Each count is deduped (rows are " +
    "deduped at write via the (brand_id, dedupe_signature) partial unique index) and filtered to " +
    "attribution_status = 'attributed' (credited to a lead we emailed for the brand; excludes needs_review " +
    "and unmatched). The \"ping\" liveness heartbeat never lands in conversion_events, so it is excluded. " +
    "All six step keys are ALWAYS present (0 when none received), including \"meeting_attended\" and " +
    "\"website_visit\", which are statable by hand only. \"website_visit\" counts the visits known ONLY " +
    "by hand: a visit stated for a lead whose click the delivery layer already measured is left out, so " +
    "this number can be added to the measured click count without counting anybody twice (email-gateway " +
    "unreachable → 502, never a guessed count). `bySource` splits the same " +
    "rows into tracker-reported and hand-stated (tracker + manual === counts, per key), and `byCause` " +
    "splits them by WHOSE win each was: outreach (the customer states ours caused it), other (they " +
    "state something else of theirs did — a real outcome, counted here like any other, simply not one " +
    "to compute OUR return on) and unstated (nobody was asked; every outcome predating the field and " +
    "every tracker-reported one). outreach + other + unstated === counts, per key. A \"never\" " +
    "statement is not an outcome and is counted by nothing here. A brand with zero conversions returns " +
    "all-zero counts (200, never 404).",
  request: { params: BrandIdPathParam },
  parameters: FeatureMembershipApiKeyHeader,
  responses: {
    200: {
      description: "Per-event-type real conversion counts for the brand",
      content: { "application/json": { schema: ConversionCountsResponseSchema } },
    },
    401: { description: "Unauthorized" },
  },
});

const ConversionCountsByDaySchema = z
  .object({
    byDay: z
      .object({
        signup: z.record(z.string(), z.number().int()),
        meeting_booked: z.record(z.string(), z.number().int()),
        meeting_attended: z.record(z.string(), z.number().int()),
        form_submission: z.record(z.string(), z.number().int()),
        sale: z.record(z.string(), z.number().int()),
        website_visit: z.record(z.string(), z.number().int()),
        purchase: z.record(z.string(), z.number().int()),
      })
      .openapi({
        description:
          "Per event type, a map of UTC calendar day (YYYY-MM-DD) -> count of REAL, deduped, " +
          "attributed conversions received that day. Days are bucketed by received_at AT TIME ZONE " +
          "'UTC' (matching the ingest dedupe UTC-day convention). A day key appears only when its " +
          "count > 0. All four canonical event keys (…, sale) are ALWAYS present (empty object when " +
          "none), plus a legacy \"purchase\" key mirroring \"sale\" for the rename migration window. " +
          "Excludes the \"ping\" liveness heartbeat, needs_review, and unmatched events — the SAME set " +
          "as /conversion-counts, just placed on the day each conversion occurred.",
        example: {
          signup: { "2026-07-08": 2, "2026-07-09": 1 },
          meeting_booked: {},
          meeting_attended: {},
          form_submission: { "2026-07-09": 3 },
          sale: {},
          purchase: {},
        },
      }),
    undated: z
      .object({
        signup: z.number().int(),
        meeting_booked: z.number().int(),
        meeting_attended: z.number().int(),
        form_submission: z.number().int(),
        sale: z.number().int(),
        purchase: z.number().int(),
      })
      .openapi({
        description:
          "Per event type, the count of attributed conversions whose day genuinely cannot be " +
          "determined (received_at IS NULL) — counted explicitly, NEVER dropped and NEVER assigned a " +
          "fabricated date. received_at is NOT NULL DEFAULT now() today, so this is 0 in practice, but " +
          "the field is always present so the contract stays honest. The legacy \"purchase\" key " +
          "mirrors \"sale\" for the rename migration window. Reconciliation: for every event, " +
          "sum(byDay[event] values) + undated[event] === the /conversion-counts total for that event.",
        example: {
          signup: 0,
          meeting_booked: 0,
          meeting_attended: 0,
          form_submission: 0,
          sale: 0,
          purchase: 0,
        },
      }),
  })
  .openapi("ConversionCountsByDayResponse", {
    description:
      "Per-brand real conversion counts broken down by the calendar day each conversion was received " +
      "(plus an explicit undated bucket), so features-service can draw a truthful per-day observed " +
      "series instead of a projection. Reconciles exactly to /conversion-counts totals.",
  });

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/conversion-counts-by-day",
  summary: "Real conversion counts per event type broken down by calendar day for a brand (internal, service-auth)",
  description:
    "INTERNAL (service-auth: x-api-key — same tier as conversion-counts, NO Clerk). Returns the SAME set of " +
    "REAL, attributed, deduped-at-write conversions as /conversion-counts, but broken down by the UTC " +
    "calendar day each conversion was received — so features-service can render a truthful per-day observed " +
    "series (today AND past days) instead of a clicks × rate projection. byDay[event] maps YYYY-MM-DD -> " +
    "count (day key present only when > 0); undated[event] counts conversions with no determinable day " +
    "(received_at IS NULL — 0 in practice, but always present and never fabricated). All four event keys are " +
    "ALWAYS present. For every event, sum(byDay values) + undated === the /conversion-counts total. A brand " +
    "with zero attributed conversions returns all-empty byDay + all-zero undated (200, never 404).",
  request: { params: BrandIdPathParam },
  parameters: FeatureMembershipApiKeyHeader,
  responses: {
    200: {
      description: "Per-event-type real conversion counts broken down by calendar day for the brand",
      content: { "application/json": { schema: ConversionCountsByDaySchema } },
    },
    401: { description: "Unauthorized" },
  },
});

const ConvertedLeadEmailsResponseSchema = z
  .object({
    event: z
      .enum(["signup", "meeting_booked", "form_submission", "sale"])
      .openapi({
        description:
          "The CANONICAL conversion event type the emails were filtered to. A legacy \"purchase\" " +
          "query is normalized to and echoed as \"sale\".",
        example: "form_submission",
      }),
    emails: z
      .array(z.string())
      .openapi({
        description:
          "Deduped, lowercased canonical emails of the leads-we-emailed that have >=1 attributed " +
          "conversion of `event` for this brand. This is the emails-we-served join key (the matched " +
          "lead's PRIMARY email), NOT the raw email a visitor typed on the client's site. Intersect it " +
          "with each audience's email membership (also email-keyed) to get a per-audience conversion " +
          "count. Empty array when the brand has no attributed conversions of `event`.",
        example: ["jane@acme.com", "bob@globex.com"],
      }),
  })
  .openapi("ConvertedLeadEmailsResponse", {
    description:
      "Per-brand set of matched-lead canonical emails with an attributed conversion of a given event " +
      "type, so features-service can attribute conversions to audiences by email-membership intersection.",
  });

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/converted-lead-emails",
  summary: "Matched-lead canonical emails with an attributed conversion of a given type (internal, service-auth)",
  description:
    "INTERNAL (service-auth: x-api-key — same tier as conversion-counts, NO Clerk). Returns the SET of " +
    "matched-lead canonical emails (the emails-we-served identity) that have at least one REAL, attributed " +
    "conversion of the `event` type for the brand. features-service intersects this set with each audience's " +
    "email membership (which it already resolves by email) to count conversions per audience. Only " +
    "attribution_status = 'attributed' rows count (the SAME set conversion-counts uses; excludes needs_review " +
    "+ unmatched). The returned identity is the matched lead's PRIMARY email (earliest email contact method), " +
    "NOT the raw email a visitor typed. Emails are lowercased + DISTINCT. `event` is required and must be one " +
    "of signup | meeting_booked | form_submission | sale (the legacy \"purchase\" spelling is also accepted " +
    "and normalized to \"sale\"; missing/invalid → 400). A brand with zero attributed conversions of `event` " +
    "returns an empty array (200, never 404).",
  request: { params: BrandIdPathParam },
  parameters: [
    ...FeatureMembershipApiKeyHeader,
    {
      in: "query" as const,
      name: "event",
      required: true,
      schema: {
        type: "string" as const,
        enum: [
          "signup",
          "meeting_booked",
          "meeting_attended",
          "form_submission",
          "sale",
          "website_visit",
          "purchase",
        ],
      },
      description:
        "Conversion event type to filter to. Required. Canonical: signup | meeting_booked | " +
        "form_submission | sale. The legacy \"purchase\" spelling is accepted (normalized to \"sale\").",
    },
  ],
  responses: {
    200: {
      description: "The set of matched-lead canonical emails with an attributed conversion of `event`",
      content: { "application/json": { schema: ConvertedLeadEmailsResponseSchema } },
    },
    400: { description: "Invalid or missing event" },
    401: { description: "Unauthorized" },
  },
});

const ConvertedLeadOutcomeSchema = z
  .object({
    leadId: z.string().nullable().openapi({
      description: "The matched lead this outcome is credited to.",
    }),
    email: z.string().nullable().openapi({
      description:
        "The matched lead's canonical (primary) email, lowercased — the SAME join key " +
        "/converted-lead-emails returns. Null when the lead has no email contact method; the row " +
        "is still returned, so this read never disagrees with the counts about how many outcomes exist.",
      example: "jane@acme.com",
    }),
    campaignId: z.string().nullable().openapi({
      description:
        "The campaign the outcome is attributable to, so the per-campaign / per-workflow / per-offer " +
        "grains can move and not only the brand total. Always present on a hand-stated outcome (the " +
        "statement is made on a lead row, which belongs to a campaign). Null on a tracker-reported one: " +
        "a page-load tag knows the brand and nothing else, and a guess would be worse than a null.",
    }),
    occurredAt: z.string().nullable().openapi({
      description:
        "When the outcome actually happened, ISO-8601 — a hand-stated fact carries the date the person " +
        "gave, not the date they typed it. Null only when genuinely undated (the same rows " +
        "/conversion-counts-by-day reports as `undated`); never fabricated.",
      example: "2026-08-19T14:30:00.000Z",
    }),
    valueCents: z.number().int().nullable().openapi({
      description:
        "What the outcome was worth, in cents, when somebody stated it. Null means nobody said — NOT " +
        "zero — so a consumer falls back to its own average for those rows and only those. A \"sale\" " +
        "stated from now on always carries one: the write refuses a sale with no value.",
      example: 490000,
    }),
    costCents: z.number().int().nullable().openapi({
      description:
        "What the CUSTOMER states this leg cost THEM, in cents — the meeting they ran, the call they " +
        "took, their time valued however they chose. The platform automates the first link of a sales " +
        "funnel and the customer performs the rest, so a cost of acquisition that omits this counts only " +
        "the link we billed for. It is NEVER platform spend: nothing here was charged to the " +
        "organisation, no platform cost was declared for it, and it is absent from their billing. 0 is " +
        "a STATED zero; null means nobody was ever asked (a tracker-reported outcome knows nothing " +
        "about a customer's spend, and so does every statement made before the cost became mandatory). " +
        "The whole per-step picture, \"never\" legs included, is /internal/brands/{brandId}/step-costs.",
      example: 12000,
    }),
    causedByOutreach: z.boolean().nullable().openapi({
      description:
        "WHOSE win it was. true — the customer states OUR outreach caused this outcome. false — " +
        "they state something else of theirs did (a referral, a conference, their existing " +
        "pipeline, another agency): the outcome is REAL and is counted everywhere the others are, " +
        "it is simply not one to compute the return on our outreach from, so a consumer leaves its " +
        "value out of that figure and keeps it in the brand's own total. null — NOBODY WAS ASKED: " +
        "every outcome stated before this field existed, and every tracker-reported one, because a " +
        "page-load tag observes a page load and cannot know why somebody bought. Null is never read " +
        "as either answer. Deliberately NOT the attributed / needs_review / unmatched vocabulary, " +
        "which answers whether we managed to identify who somebody was.",
      example: true,
    }),
    source: z.enum(["tracker", "manual"]).openapi({
      description: "manual — a human stated it; tracker — the website tag reported it.",
    }),
  })
  .openapi("ConvertedLeadOutcome");

const ConvertedLeadsResponseSchema = z
  .object({
    event: z
      .enum([
        "signup",
        "meeting_booked",
        "meeting_attended",
        "form_submission",
        "sale",
        "website_visit",
      ])
      .openapi({
      description:
        "The CANONICAL step the outcomes were filtered to. A legacy \"purchase\" query is normalized " +
        "to and echoed as \"sale\".",
      example: "sale",
    }),
    outcomes: z.array(ConvertedLeadOutcomeSchema).openapi({
      description:
        "One row per attributed outcome of `event` for the brand, newest first. Exactly the set " +
        "/conversion-counts counts: `outcomes.length` equals that total, and bucketing `occurredAt` by " +
        "UTC calendar day reproduces /conversion-counts-by-day row for row, `null` landing in `undated`. " +
        "Empty when the brand has no attributed outcome of `event`.",
    }),
  })
  .openapi("ConvertedLeadsResponse", {
    description:
      "Per-brand, per-step outcomes carrying WHEN each happened, WHICH campaign it is attributable to " +
      "and HOW MUCH it was worth — so a consumer values a lead by what somebody observed instead of " +
      "projecting declared rates through it.",
  });

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/converted-leads",
  summary: "Attributed outcomes of a step for a brand, with date, campaign and value (internal, service-auth)",
  description:
    "INTERNAL (service-auth: x-api-key — same tier as conversion-counts, NO Clerk). Every attributed " +
    "outcome of `event` for the brand, ONE ROW PER OUTCOME, carrying when it happened, which campaign it " +
    "is attributable to and what it was worth — the three things /converted-lead-emails cannot say, and " +
    "without which an observed outcome cannot be charted over time, cannot move any grain below the brand, " +
    "and gets priced at the brand's average lifetime revenue. Exactly the same set /conversion-counts and " +
    "/conversion-counts-by-day count (deduped at write, attribution_status = 'attributed'), so the reads " +
    "reconcile row for row — a lead with no email is returned with a null email rather than dropped. " +
    "Each row also carries `causedByOutreach`: true (the customer states our outreach caused it), false " +
    "(they state something else of theirs did — a real outcome, in every count, simply not one to " +
    "compute OUR return on) or null (nobody was asked). " +
    "`event` is required, one of signup | meeting_booked | meeting_attended | form_submission | sale " +
    "(legacy \"purchase\" accepted, normalized to \"sale\"); missing/invalid → 400. A brand with no " +
    "attributed outcome of `event` returns an empty array (200, never 404).",
  request: { params: BrandIdPathParam },
  parameters: [
    ...FeatureMembershipApiKeyHeader,
    {
      in: "query" as const,
      name: "event",
      required: true,
      schema: {
        type: "string" as const,
        enum: [
          "signup",
          "meeting_booked",
          "meeting_attended",
          "form_submission",
          "sale",
          "website_visit",
          "purchase",
        ],
      },
      description:
        "Step to filter to. Required. Canonical: signup | meeting_booked | meeting_attended | " +
        "form_submission | sale. The legacy \"purchase\" spelling is accepted (normalized to \"sale\").",
    },
  ],
  responses: {
    200: {
      description: "The attributed outcomes of `event` for the brand, newest first",
      content: { "application/json": { schema: ConvertedLeadsResponseSchema } },
    },
    400: { description: "Invalid or missing event" },
    401: { description: "Unauthorized" },
  },
});

// --- Hand-stated step outcomes ---

const StepStatementOrgHeaders = [
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
    required: false,
    schema: { type: "string" as const },
    description:
      "Internal user UUID of the person making the statement. Stored verbatim as statedByUserId so a statement can be traced back to whoever made it.",
  },
  {
    in: "header" as const,
    name: "x-brand-id",
    required: false,
    schema: { type: "string" as const },
    description:
      "Brand scope. Same meaning as ?brandId=: which of the row's brands the statement is about. A brand the row is not part of answers 404, exactly as an absent row does.",
  },
];

const LeadRowIdPathParam = z.object({
  id: z.string().openapi({
    param: { name: "id", in: "path" },
    description:
      "The `id` a list row already carries (the leads_campaigns membership row) — so a caller states an outcome for a lead it has already resolved without re-supplying any identity field.",
    example: "40000000-0000-0000-0000-000000000001",
  }),
});

const STEP_ENUM = [
  "signup",
  "meeting_booked",
  "meeting_attended",
  "form_submission",
  "sale",
  "website_visit",
  "purchase",
] as const;

const FUNNEL_KEY_ENUM = [
  "sales_meetings_from_conversation",
  "sales_meetings_from_website",
  "website_purchases",
  "form_magnet",
  "sales_from_conversation",
  "sales_meetings_from_ads",
  "lead_forms_from_ads",
] as const;

const FunnelFieldsSchema = {
  funnelKey: z.enum(FUNNEL_KEY_ENUM).openapi({
    description:
      "The sales funnel this lead's CAMPAIGN states it sells through, read from campaign-service and never inferred. It is what gives the steps an order: \"before\" and \"after\" mean nothing without knowing which funnel the lead is on.",
    example: "sales_meetings_from_conversation",
  }),
  funnelSteps: z.array(z.enum(STEP_ENUM)).openapi({
    description:
      "That funnel's steps, IN ORDER, expressed in this service's step vocabulary. A step of the vocabulary that is not on this funnel is constrained by nothing: no funnel rule reaches it.",
    example: ["meeting_booked", "meeting_attended", "sale"],
  }),
};

const StepStatementRequestSchema = z
  .object({
    step: z.enum(STEP_ENUM).openapi({
      description:
        "The funnel step being stated. \"meeting_attended\" and \"website_visit\" exist here and nowhere in the tracker: attendance happens off the client's website, and a visit is measured by the delivery layer as a click, so for both only a human can state what those signals missed. A hand-stated visit ADDS to the measured one and never suppresses it: a lead carrying both is counted once, because the hand-stated row is left out of the counts. The legacy spelling \"purchase\" is accepted and normalized to \"sale\".",
      example: "meeting_booked",
    }),
    kind: z.enum(["outcome", "never"]).openapi({
      description:
        "outcome — this happened; it is written to the conversion ledger every consumer already counts, so the brand's counts move on the next read. never — this will NOT happen; it is NOT an outcome, nothing counts it anywhere, and it exists so a consumer can tell a lead that is DEAD at a step from one still PENDING.",
      example: "outcome",
    }),
    valueCents: z.number().int().optional().openapi({
      description:
        "What the outcome was worth, in cents. REQUIRED on a \"sale\" outcome and optional on every other step: a won deal is the one place estimating has no excuse, because with no value every downstream money figure prices it at the brand's average lifetime revenue, which describes no real customer. Stating it early on an unusually large lead, long before it closes, is exactly why the other steps keep it optional. Rejected with 400 on a \"never\" statement rather than silently dropped.",
      example: 490000,
    }),
    costCents: z.number().int().openapi({
      description:
        "What this step cost YOU, in cents — MANDATORY on every statement, outcome and \"never\" " +
        "alike. The platform automates the first link of a sales funnel and you perform the rest (you " +
        "run the meeting, you close the deal), so you are the only one who can say what that leg cost; " +
        "without it a funnel's cost of acquisition counts only the link we billed for and every return " +
        "shown for it is too good. You choose what goes in: zero, your time valued however you like, " +
        "real expenses. ZERO IS A LEGITIMATE ANSWER and reads back as a stated zero — leaving the field " +
        "out is a 400 (code cost_required), never a zero, because an absent cost and a stated zero must " +
        "stay distinguishable. Negative is a 400. THIS MONEY IS YOURS: it is recorded because you told " +
        "us, it is never charged to you, and it never enters the platform's own spend ledger or your " +
        "billing. A \"never\" carries one too — a meeting that was run and went nowhere still cost what " +
        "it cost.",
      example: 12000,
    }),
    causedByOutreach: z.boolean().optional().openapi({
      description:
        "WHOSE win it was — did OUR outreach cause this, or something else you already do? true — " +
        "ours. false — yours (a referral, a conference, your existing pipeline, another agency): " +
        "the outcome is REAL, it is recorded and counted among your own exactly like any other, and " +
        "stating it honestly costs you nothing; it simply stops it inflating the return we report " +
        "on our own outreach. LEAVING IT OUT IS NOT \"NOT US\": an absent answer is recorded as " +
        "\"nobody was asked\" and stays distinguishable from both answers forever, which is why " +
        "every statement made before this existed reads as unstated rather than silently acquiring " +
        "an answer nobody gave. Optional on every step; rejected with 400 on a \"never\" statement " +
        "(nothing happened, so nothing caused it). A restatement REPLACES the statement, so " +
        "restating without naming a cause returns it to unstated.",
      example: true,
    }),
    note: z.string().optional().openapi({
      description: "Free text the person stating the fact wrote, stored verbatim.",
      example: "Closed on the call, contract signed 2026-08-19.",
    }),
    occurredAt: z.string().optional().openapi({
      description:
        "ISO-8601 timestamp of WHEN the outcome happened, for a fact stated after the fact — it is what the by-day series buckets on. Unparseable values are a 400, never silently replaced by now().",
      example: "2026-08-19T14:30:00.000Z",
    }),
  })
  .openapi("LeadStepStatementRequest", {
    description: "A statement a human makes about one step of one lead's campaign funnel.",
  });

const StepStatementSchema = z.object({
  id: z.string(),
  leadCampaignId: z.string(),
  leadId: z.string(),
  campaignId: z.string().openapi({
    description:
      "The campaign the statement was made on — the row's own campaign, so an outcome stated from a campaign screen is attributable to that campaign and not only to the brand.",
  }),
  brandId: z.string(),
  step: z.enum(STEP_ENUM),
  kind: z.enum(["outcome", "never"]),
  source: z.enum(["tracker", "manual"]),
  valueCents: z.number().int().nullable(),
  costCents: z.number().int().nullable().openapi({
    description:
      "What the author stated this step cost them, in cents, echoed back. 0 is a stated zero. Never " +
      "charged, never part of the platform's spend ledger.",
  }),
  causedByOutreach: z.boolean().nullable().openapi({
    description:
      "WHOSE win it was, echoed back. true — our outreach caused it; false — something else of the " +
      "customer's did (a real outcome either way); null — nobody was asked, which is neither " +
      "answer. Always null on a \"never\" statement: nothing happened, so nothing caused it.",
  }),
  note: z.string().nullable(),
  statedByUserId: z.string().nullable(),
  statedAt: z.string().nullable(),
});

const StepStatementResponseSchema = z
  .object({
    statement: StepStatementSchema,
    ...FunnelFieldsSchema,
    retractedNever: z.boolean().optional().openapi({
      description:
        "True when this outcome superseded at least one earlier \"never\" — for the same step (the person did the thing after all) or for a step BEFORE it on the funnel (a lead that paid necessarily got through the steps that lead to paying). The two cannot both stand, and this is the only direction that can be true — stating \"never\" for a step that already happened, or that a later step on the funnel says already happened, is a 409.",
    }),
    retractedNeverSteps: z.array(z.enum(STEP_ENUM)).optional().openapi({
      description:
        "WHICH \"never\" statements this outcome superseded. They are marked retracted and kept, never deleted: what a person actually stated has to survive being superseded, and every read filters retracted statements out.",
      example: ["meeting_booked", "meeting_attended"],
    }),
  })
  .openapi("LeadStepStatementResponse", { description: "The statement as recorded." });

registry.registerPath({
  method: "post",
  path: "/orgs/leads/{id}/step-statements",
  summary: "State by hand what happened to one lead at one funnel step (or that it never will)",
  description:
    "Organisation-authenticated (the customer dashboard and the staff console are both org-authenticated; " +
    "the publishable website-tracker token is deliberately NOT a door to this — it is write-only, " +
    "brand-scoped and meant for a third party's page). The lead is named by the `id` a list row already " +
    "carries, so nothing about the person is re-supplied and nothing is matched or guessed — which is what " +
    "repairs, for hand-stated facts, the ~90% unmatched rate the tracker's identity waterfall carries. " +
    "kind=outcome writes to the conversion ledger tagged source=manual, so the brand's outcome counts move " +
    "on the next read with no consumer change, and restating the same step corrects the first statement " +
    "instead of counting twice. kind=never writes to a separate store that NO count reads, so a \"never\" " +
    "can never move an outcome count; it is what lets a consumer separate a lead that is dead at a step " +
    "from one still pending. A \"sale\" outcome MUST carry valueCents (400 otherwise) — a won deal states " +
    "what it was worth instead of being priced at the brand average; every other step keeps it optional. " +
    "`causedByOutreach` states WHOSE win it was — ours, or something else the customer already does " +
    "(a referral, a conference, their own pipeline). A deal they say we did not cause is still a real " +
    "deal, recorded and counted among their own; saying so simply keeps it out of the return we report " +
    "on our own outreach. It is optional, and leaving it out records \"nobody was asked\" rather than " +
    "\"not us\", so a statement made before this existed never silently acquires an answer.",
  request: {
    params: LeadRowIdPathParam,
    body: { content: { "application/json": { schema: StepStatementRequestSchema } } },
  },
  parameters: StepStatementOrgHeaders,
  responses: {
    201: {
      description: "The statement as recorded",
      content: { "application/json": { schema: StepStatementResponseSchema } },
    },
    400: {
      description:
        "Invalid id, step, kind, occurredAt; valueCents or causedByOutreach on a \"never\"; a \"sale\" " +
        "outcome with no valueCents; a missing costCents (code cost_required — absent is a refusal, " +
        "never a zero); or a negative costCents",
    },
    401: { description: "Unauthorized" },
    404: { description: "No such lead row for this org (or for the requested brand scope)" },
    409: {
      description:
        "Cannot state \"never\" for a step that already has an outcome, or that a LATER step of the campaign's funnel says already happened (code step_already_happened); or the campaign states no sales funnel, so its steps have no order (code funnel_unstated / campaign_unknown)",
    },
    500: { description: "Internal server error" },
    502: {
      description:
        "campaign-service could not say which funnel the campaign sells through (code campaign_service_unavailable) — no answer is returned rather than one built on a funnel nobody stated",
    },
  },
});

const StepStateSchema = z
  .object({
    step: z.enum(STEP_ENUM),
    state: z.enum(["outcome", "never", "pending"]).openapi({
      description:
        "outcome — it happened, either because somebody stated it or because a LATER step of this campaign's funnel did; never — it will not happen, either stated or implied by an EARLIER step of the funnel being never; pending — neither has been stated and no funnel rule reaches it. Nothing counts a \"never\", however it arose.",
    }),
    origin: z.enum(["stated", "implied"]).nullable().openapi({
      description:
        "Whether a PERSON stated this step or the FUNNEL implies it. Null exactly when the step is pending. An implied step is not a statement somebody made: it carries no author, no note and no date, and it moves automatically when the statement that implied it is retracted or superseded.",
    }),
    impliedBy: z.enum(STEP_ENUM).nullable().openapi({
      description:
        "The STATED step this one follows from — a later outcome for an implied outcome, an earlier \"never\" for an implied never. Null when nothing implies it.",
    }),
    statedState: z.enum(["outcome", "never"]).nullable().openapi({
      description:
        "What a person actually stated about THIS step, whatever the funnel concluded — so a real statement is never lost to satisfy the funnel. A \"never\" contradicted by a later outcome reads state=outcome, origin=implied, statedState=never.",
    }),
    inFunnel: z.boolean().openapi({
      description:
        "Whether this step is part of the lead's funnel. A step outside it reads from statements alone: no funnel rule reaches it.",
    }),
    stepIndex: z.number().int().nullable().openapi({
      description: "Where the step sits on the funnel, or null when the funnel does not contain it.",
    }),
    source: z.enum(["tracker", "manual"]).nullable().openapi({
      description:
        "Who said so. Null on a pending step (nobody has said anything) and on an implied one (nobody stated it).",
    }),
    valueCents: z.number().int().nullable(),
    causedByOutreach: z.boolean().nullable().openapi({
      description:
        "WHOSE win it was: true — the customer states our outreach caused it; false — they state " +
        "something else of theirs did (still a real outcome, counted everywhere the others are); " +
        "null — NOBODY WAS ASKED, which is neither answer and is what every statement made before " +
        "this existed reads as. Null on a pending step, on an IMPLIED one (nobody stated it, so " +
        "nobody stated its cause), on a \"never\" (nothing happened, so nothing caused it) and on a " +
        "tracker-reported outcome (a page-load tag cannot know why somebody bought).",
    }),
    costCents: z.number().int().nullable().openapi({
      description:
        "What the CUSTOMER stated getting through this step cost them, in cents. 0 is a stated zero. " +
        "Null on a pending step (nobody said anything), on an IMPLIED one (nobody stated it, so nobody " +
        "stated its cost either), on a tracker-reported outcome (a page-load tag knows nothing about a " +
        "customer's spend) and on a statement made before the cost became mandatory. Never platform " +
        "spend and never billed.",
      example: 12000,
    }),
    note: z.string().nullable(),
    statedByUserId: z.string().nullable(),
    at: z.string().nullable(),
  })
  .openapi("LeadStepState");

const StepStatementsListSchema = z
  .object({
    leadCampaignId: z.string(),
    leadId: z.string(),
    campaignId: z.string(),
    brandId: z.string(),
    ...FunnelFieldsSchema,
    steps: z.array(StepStateSchema).openapi({
      description:
        "One entry per step of the outcome vocabulary, ALWAYS all of them, in a fixed order: signup, meeting_booked, form_submission, sale, meeting_attended, website_visit. Each carries the funnel's two rules already applied — a \"never\" makes every LATER step of `funnelSteps` never, an outcome makes every EARLIER one reached — with `origin` telling a stated step from an implied one. The website visit additionally reads as an outcome with source=tracker when the delivery layer already measured a click for this lead, so the panel never invites somebody to state a fact the system already holds.",
    }),
  })
  .openapi("LeadStepStatementsResponse", {
    description: "What is known about every step of this lead's funnel.",
  });

registry.registerPath({
  method: "get",
  path: "/orgs/leads/{id}/step-statements",
  summary: "Everything known about every funnel step of one lead",
  description:
    "The read behind the panel a statement is made from: one entry per step, always all of them, each " +
    "either an outcome (with the source that reported or stated it), a \"never\", or pending. A " +
    "tracker-reported outcome is attributed to the person at brand grain, a hand-stated one to the exact " +
    "row it was stated on; both are returned here. A funnel is ORDERED, so the answer respects it: a " +
    "\"never\" makes every LATER step of that campaign's funnel read as never, and an outcome makes every " +
    "EARLIER one read as reached — `origin` tells a step a person STATED from one the funnel IMPLIES, and " +
    "`statedState` keeps what somebody really said readable even where the funnel concluded otherwise. The " +
    "step order is per FUNNEL (`funnelKey` + `funnelSteps`), read from campaign-service and never guessed: a " +
    "campaign that states no funnel is a 409, not a made-up order.",
  request: { params: LeadRowIdPathParam },
  parameters: StepStatementOrgHeaders,
  responses: {
    200: {
      description: "Per-step state for this lead",
      content: { "application/json": { schema: StepStatementsListSchema } },
    },
    400: { description: "id is not a uuid" },
    401: { description: "Unauthorized" },
    404: { description: "No such lead row for this org (or for the requested brand scope)" },
    409: {
      description:
        "The campaign states no sales funnel this service has a funnel for, so its steps have no order (code funnel_unstated / campaign_unknown)",
    },
    500: { description: "Internal server error" },
    502: {
      description:
        "campaign-service could not say which funnel the campaign sells through (code campaign_service_unavailable)",
    },
  },
});

const StepStatementWithdrawalResponseSchema = z
  .object({
    leadCampaignId: z.string(),
    leadId: z.string(),
    campaignId: z.string(),
    brandId: z.string(),
    step: z.enum(STEP_ENUM),
    kind: z.enum(["outcome", "never"]).optional().openapi({
      description:
        "Which statement was taken back. Absent when nothing was written (the statement had already been withdrawn).",
    }),
    withdrawn: z.boolean().openapi({
      description: "True when this call is what withdrew the statement.",
    }),
    alreadyWithdrawn: z.boolean().openapi({
      description:
        "True when the statement was already withdrawn, so nothing was written. Withdrawing twice is a success, not an error.",
    }),
    withdrawnByUserId: z.string().nullable().optional(),
    restoredNeverSteps: z.array(z.enum(STEP_ENUM)).openapi({
      description:
        "The \"never\" statements that stand again. Withdrawing an OUTCOME un-retracts the \"never\"s that outcome had superseded: they were only set aside because of a statement that no longer stands. A \"never\" somebody withdrew on its own account is left alone — that was their decision, not a consequence of this one.",
      example: ["meeting_booked"],
    }),
    ...FunnelFieldsSchema,
    steps: z.array(StepStateSchema).openapi({
      description:
        "Every step of this lead's funnel RE-DERIVED after the withdrawal, so a caller never guesses what its withdrawal did. The funnel's rules are computed on read, so a step that only read as reached — or as dead — because of the withdrawn statement falls back to whatever the remaining statements imply.",
    }),
  })
  .openapi("LeadStepStatementWithdrawalResponse", {
    description: "The statement taken back, and what every step reads as now.",
  });

registry.registerPath({
  method: "delete",
  path: "/orgs/leads/{id}/step-statements/{step}",
  summary: "Withdraw a statement somebody made by hand about one funnel step of one lead",
  description:
    "Organisation-authenticated, same tier as the write. A statement made by mistake — wrong lead, wrong " +
    "step, a misread reply — is TAKEN BACK, so the step reads exactly as it did before anybody spoke. It " +
    "is not a third kind of statement and there is nothing new to count: it is the ABSENCE of one, so the " +
    "brand's outcome counts drop the outcome on the next read and the cost the customer stated for that " +
    "leg stops counting as their spend. NOTHING IS DELETED — what somebody stated and the fact they later " +
    "withdrew it both stay readable, the same posture a retraction already takes. Withdrawing an outcome " +
    "also un-retracts the \"never\"s that outcome had superseded. ONLY A STATEMENT A PERSON MADE IS " +
    "WITHDRAWABLE: a tracker-reported or delivery-measured outcome is a 409 code=not_a_statement, and a " +
    "step nobody stated (however the funnel makes it READ) is a 409 code=nothing_stated — both " +
    "distinguishable from a 500 by their code. Idempotent: withdrawing what is already withdrawn answers " +
    "200 with alreadyWithdrawn=true and writes nothing.",
  request: {
    params: LeadRowIdPathParam.extend({
      step: z.enum(STEP_ENUM).openapi({
        param: { name: "step", in: "path" },
        description:
          "The funnel step whose statement is being withdrawn. The legacy spelling \"purchase\" folds to \"sale\"; anything else is a 400.",
        example: "meeting_booked",
      }),
    }),
  },
  parameters: StepStatementOrgHeaders,
  responses: {
    200: {
      description:
        "The statement was withdrawn (or was already withdrawn), with every step re-derived",
      content: { "application/json": { schema: StepStatementWithdrawalResponseSchema } },
    },
    400: { description: "id is not a uuid, or step is not one of the funnel steps" },
    401: { description: "Unauthorized" },
    404: { description: "No such lead row for this org (or for the requested brand scope)" },
    409: {
      description:
        "Nothing a person stated to withdraw: the step was reported by the tracker or measured by the delivery layer (code not_a_statement), or nobody stated it and it only READS as reached or dead because the funnel implies it from a statement on another step (code nothing_stated). Also the campaign stating no sales funnel (code funnel_unstated / campaign_unknown).",
    },
    500: { description: "Internal server error" },
    502: {
      description:
        "campaign-service could not say which funnel the campaign sells through (code campaign_service_unavailable), or email-gateway could not say whether the visit was already measured",
    },
  },
});

const StepCountsShape = z.object({
  signup: z.number().int(),
  meeting_booked: z.number().int(),
  meeting_attended: z.number().int(),
  form_submission: z.number().int(),
  sale: z.number().int(),
  website_visit: z.number().int(),
});

const StepEmailsShape = z.object({
  signup: z.array(z.string()),
  meeting_booked: z.array(z.string()),
  meeting_attended: z.array(z.string()),
  form_submission: z.array(z.string()),
  sale: z.array(z.string()),
  website_visit: z.array(z.string()),
});

const StepDisqualificationsResponseSchema = z
  .object({
    counts: z
      .object({
        signup: z.number().int(),
        meeting_booked: z.number().int(),
        meeting_attended: z.number().int(),
        form_submission: z.number().int(),
        sale: z.number().int(),
        website_visit: z.number().int(),
      })
      .openapi({
        description:
          "Per step, how many DISTINCT people a human has stated will never reach it. These are not outcomes and are counted as outcomes by nothing — the number exists so a consumer can shrink a still-pending population to the one that can still convert.",
        example: {
          signup: 0,
          meeting_booked: 4,
          meeting_attended: 1,
          form_submission: 0,
          sale: 12,
          website_visit: 0,
        },
      }),
    byStep: z
      .object({
        signup: z.array(z.string()),
        meeting_booked: z.array(z.string()),
        meeting_attended: z.array(z.string()),
        form_submission: z.array(z.string()),
        sale: z.array(z.string()),
        website_visit: z.array(z.string()),
      })
      .openapi({
        description:
          "Per step, the canonical (primary) emails of those people — the SAME join key /converted-lead-emails returns, lowercased and DISTINCT, so a consumer intersects it with audience membership exactly as it already does for conversions. A lead with no email contact method has no join key and is absent here while still counted in `counts`.",
      }),
  })
  .extend({
    impliedCounts: StepCountsShape.optional().openapi({
      description:
        "Only with ?implied=true. Per step, how many DISTINCT people NOBODY stated that step for, whom a \"never\" EARLIER on their campaign's funnel makes never anyway: once a step is false, everything after it is false. Kept apart from `counts` so a reader can always tell what somebody stated from what the funnel concluded.",
    }),
    impliedByStep: StepEmailsShape.optional().openapi({
      description: "Only with ?implied=true. The same canonical-email join key, for the implied set.",
    }),
    effectiveCounts: StepCountsShape.optional().openapi({
      description:
        "Only with ?implied=true. Stated and implied together — the answer to \"is this lead dead at this step?\". A \"never\" contradicted by an outcome further down the funnel is absent here (the lead demonstrably got there) while remaining in `counts`, which is the record of what was said.",
    }),
    effectiveByStep: StepEmailsShape.optional().openapi({
      description: "Only with ?implied=true. The same canonical-email join key, for the effective set.",
    }),
  })
  .openapi("LeadStepDisqualificationsResponse", {
    description: "Per-brand, who is dead at which funnel step.",
  });

// --- What the CUSTOMER spent on the legs the platform does not automate ---

const StepCostRowSchema = z
  .object({
    leadId: z.string().nullable(),
    leadCampaignId: z.string().nullable().openapi({
      description: "The lead row the statement was made on — the id a list row already carries.",
    }),
    campaignId: z.string().nullable().openapi({
      description:
        "The campaign the cost is attributable to. Every hand statement carries one (it is made on a " +
        "lead row, which belongs to a campaign), so this read attributes at campaign grain and not " +
        "only at brand grain.",
    }),
    email: z.string().nullable().openapi({
      description:
        "The lead's canonical (primary) email, lowercased — the SAME join key the conversion reads " +
        "return. Null when the lead has no email contact method; the row is still returned.",
      example: "jane@acme.com",
    }),
    step: z.enum(STEP_ENUM),
    kind: z.enum(["outcome", "never"]).openapi({
      description:
        "outcome — the step happened; never — it will not, and the leg still cost. Both are real " +
        "spend: a meeting that was run and went nowhere cost exactly what it cost.",
    }),
    costCents: z.number().int().nullable().openapi({
      description:
        "What the customer stated this leg cost them, in cents. 0 is a STATED ZERO. Null means nobody " +
        "was ever asked — every statement made before the cost became mandatory. The two are " +
        "deliberately distinguishable; `statedCount` / `unstatedCount` say how much of a step's " +
        "population actually answered.",
      example: 12000,
    }),
    statedByUserId: z.string().nullable(),
    occurredAt: z.string().nullable().openapi({
      description:
        "When the outcome happened, or when the \"never\" was last stated, ISO-8601.",
      example: "2026-08-19T14:30:00.000Z",
    }),
  })
  .openapi("LeadStepCost");

const StepCostTotalsShape = z
  .object({
    costCents: z.number().int(),
    statedCount: z.number().int(),
    unstatedCount: z.number().int(),
  })
  .openapi("LeadStepCostTotals");

const StepCostsResponseSchema = z
  .object({
    brandId: z.string(),
    totalCostCents: z.number().int().openapi({
      description:
        "The sum of every STATED cost, in cents. Rows nobody answered contribute nothing rather than " +
        "a fabricated zero — `unstatedCount` is how a consumer knows how incomplete the sum is.",
    }),
    statedCount: z.number().int(),
    unstatedCount: z.number().int(),
    byStep: z.record(z.string(), StepCostTotalsShape).openapi({
      description:
        "The same three figures per step of the outcome vocabulary. With ?step= the map holds that " +
        "step alone.",
    }),
    costs: z.array(StepCostRowSchema).openapi({
      description: "One row per live hand statement for the brand.",
    }),
  })
  .openapi("LeadStepCostsResponse", {
    description: "Per-brand, what the customer says each funnel leg cost them.",
  });

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/step-costs",
  summary: "What the CUSTOMER spent on each funnel leg, per statement (internal, service-auth)",
  description:
    "INTERNAL (service-auth: x-api-key — the same tier as the conversion-count reads, NO Clerk). The " +
    "platform automates the first link of a sales funnel and bills for it; the customer performs the rest " +
    "— they run the meeting, they close the deal — so they are the only one who knows what those legs " +
    "cost. Without this read a funnel's cost of acquisition counts only the link the platform paid for and " +
    "every return computed for that funnel is too good. THIS IS NOT PLATFORM SPEND: nothing here was ever " +
    "charged to the organisation, no platform cost was declared for it, and none of it appears in their " +
    "billing. The set is every LIVE hand statement for the brand — outcomes and \"never\"s alike, since a " +
    "dead leg still cost — which is deliberately not the set /conversion-counts counts, and that is not a " +
    "contradiction because this is money and that is a population: a hand-stated website_visit whose click " +
    "the delivery layer already measured is suppressed from the COUNTS (so one visit is not counted twice) " +
    "but kept here (the money was spent either way), while a RETRACTED \"never\" is excluded exactly as it " +
    "is everywhere else, because the outcome that superseded it carries its own cost. Never 404 — a brand " +
    "nobody has stated a cost for answers zeros and an empty array.",
  request: {
    params: BrandIdPathParam,
    query: z.object({
      step: z.enum(STEP_ENUM).optional().openapi({
        param: { name: "step", in: "query" },
        description:
          "Narrow to one step of the outcome vocabulary (legacy \"purchase\" folds to \"sale\"). An " +
          "unrecognised value is a 400, never a silent \"all steps\".",
      }),
    }),
  },
  parameters: FeatureMembershipApiKeyHeader,
  responses: {
    200: {
      description: "Per-statement customer costs plus per-step totals",
      content: { "application/json": { schema: StepCostsResponseSchema } },
    },
    400: { description: "Unrecognised step" },
    401: { description: "Unauthorized" },
    500: { description: "Internal server error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/internal/brands/{brandId}/step-disqualifications",
  summary: "People stated to never reach a funnel step, per step, for a brand (internal, service-auth)",
  description:
    "INTERNAL (service-auth: x-api-key — the same tier as the conversion-count reads, NO Clerk). Nothing " +
    "here is an outcome and nothing counts it as one: this is what lets a consumer separate a lead that is " +
    "DEAD at a step from one still PENDING, so a cost-per-acquisition denominator stops waiting forever on " +
    "somebody who is never coming. Never 404 — a brand nobody has disqualified anyone for returns empty " +
    "sets and zero counts.",
  request: {
    params: BrandIdPathParam,
    query: z.object({
      implied: z.literal("true").optional().openapi({
        param: { name: "implied", in: "query" },
        description:
          "Apply each lead's campaign funnel FUNNEL as well: a lead that will never book has, by the same statement, never attended and never paid. Opt-in because it needs a campaign-service read per org; without it the response is byte-identical to what this endpoint has always answered.",
      }),
    }),
  },
  parameters: FeatureMembershipApiKeyHeader,
  responses: {
    200: {
      description: "Per-step counts and canonical emails of disqualified leads",
      content: { "application/json": { schema: StepDisqualificationsResponseSchema } },
    },
    401: { description: "Unauthorized" },
    409: {
      description:
        "Only with ?implied=true: some of these leads belong to campaigns that state no sales funnel, so no funnel can be applied (code funnel_unstated, with the offending campaignIds)",
    },
    502: {
      description:
        "Only with ?implied=true: campaign-service could not answer (code campaign_service_unavailable)",
    },
  },
});

// --- Follow-up queue ---
//
// Who is owed our next message, and when. Once a prospect shows a sales interest we owe them an
// answer now and, if they go quiet, further answers at growing intervals, indefinitely, until they
// book, opt out, or answer again. See src/lib/followup-queue.ts.

const FollowupOrgHeaders = [
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
    name: "x-run-id",
    required: false,
    schema: { type: "string" as const },
    description: "Run the claim belongs to, forwarded to the delivery layer for tracing.",
  },
];

const FollowupStateSchema = z
  .object({
    id: z.string().openapi({
      description:
        "The leads_campaigns row the debt belongs to — the same id a list row already carries.",
      example: "40000000-0000-0000-0000-000000000001",
    }),
    leadId: z.string().openapi({ description: "The person.", example: "50000000-0000-0000-0000-000000000002" }),
    campaignId: z.string().openapi({ description: "The campaign the debt was stated on.", example: "camp-1" }),
    dueAt: z.string().nullable().openapi({
      description:
        "When we next owe this person an action. NULL means we owe them nothing right now: never scheduled, answered and not yet re-scheduled, or stopped. This is the queue's ordering key — oldest due first, so a backlog cannot starve whoever has waited longest.",
      example: "2026-09-05T09:00:00.000Z",
    }),
    claimedAt: z.string().nullable().openapi({
      description:
        "When a worker took this row. The claim is what stops two workers answering the same prospect; it expires after an hour so a worker that dies mid-answer strands nobody.",
      example: null,
    }),
    followupCount: z.number().int().openapi({
      description:
        "How many follow-ups we have taken toward this person. Recorded, never a cap — there is deliberately no ceiling on the number of follow-ups; the growing intervals are the limit.",
      example: 3,
    }),
    lastActionAt: z.string().nullable().openapi({
      description: "When we last acted, so how long they have been quiet is readable.",
      example: "2026-08-29T09:00:00.000Z",
    }),
    stoppedReason: z.string().nullable().openapi({
      description:
        "Why the schedule is currently empty, when it is. Stated by whoever stopped it (\"opted_out\" is written by this service when the delivery layer reports an unsubscribe at claim time). NULL while a due date stands.",
      example: "answered_again",
    }),
  })
  .openapi("FollowupState", {
    description: "What we owe one person on one campaign, and when.",
    example: {
      id: "40000000-0000-0000-0000-000000000001",
      leadId: "50000000-0000-0000-0000-000000000002",
      campaignId: "camp-1",
      dueAt: "2026-09-05T09:00:00.000Z",
      claimedAt: null,
      followupCount: 3,
      lastActionAt: "2026-08-29T09:00:00.000Z",
      stoppedReason: null,
    },
  });

const FollowupClaimSchema = z
  .object({
    found: z.boolean().openapi({
      description: "Whether a person was claimed. At most one per call, and exactly once.",
      example: true,
    }),
    reason: z.enum(["nothing_due", "all_claimed"]).optional().openapi({
      description:
        "Why nobody came back, present only when found=false. nothing_due — no row of this campaign is due right now. all_claimed — every due row is held by another worker, or was stopped during this call (an opt-out). Named rather than a silent empty, so a caller never has to guess whether the queue is drained or contended.",
      example: "nothing_due",
    }),
    followup: z
      .object({
        id: z.string().openapi({ description: "The leads_campaigns row to answer for." }),
        leadId: z.string().openapi({ description: "The person." }),
        campaignId: z.string().openapi({ description: "The campaign." }),
        brandId: z.string().openapi({ description: "The brand the delivery evidence was read for." }),
        email: z.string().openapi({ description: "The person's canonical email." }),
        audienceId: z.string().nullable().openapi({ description: "The audience the row carries, if any." }),
        dueAt: z.string().nullable().openapi({ description: "When this action became owed." }),
        followupCount: z.number().int().openapi({ description: "Follow-ups taken so far." }),
        lastActionAt: z.string().nullable().openapi({ description: "When we last acted." }),
      })
      .optional()
      .openapi({ description: "The claimed person, present only when found=true." }),
  })
  .openapi("FollowupClaim", { description: "The next person due on a campaign, or nobody and why." });

registry.registerPath({
  method: "post",
  path: "/orgs/campaigns/{campaignId}/followups/claim-next",
  summary: "Claim the next person due for a follow-up on this campaign",
  description:
    "Returns AT MOST ONE person, EXACTLY ONCE. The claim is an atomic conditional UPDATE, so two " +
    "workers polling in the same instant receive different people or one receives nobody — never " +
    "the same person twice, which is the failure this queue exists to prevent (a double email to a " +
    "prospect cannot be taken back). The order is oldest-due-first, so a backlog cannot starve the " +
    "people who have waited longest. Three stops are honoured and none of them is guessed: a person " +
    "who OPTED OUT is never returned (read from the delivery layer at claim time and their schedule " +
    "cleared for good), a person with a BOOKED MEETING on record is never returned (a stated or " +
    "tracker-reported meeting_booked, meeting_attended or sale — the last two entail the booking), " +
    "and a person who ANSWERED AGAIN is never returned (whoever observes the reply stops their " +
    "schedule, and qualification re-decides what we owe). The claim expires after an hour, so a " +
    "worker that dies mid-answer strands nobody. The scope is the campaign id named, not its " +
    "identity family: this hands out a single row whose due date a worker wrote while naming that " +
    "exact campaign, rather than totalling a population.",
  request: {
    params: z.object({
      campaignId: z.string().openapi({
        param: { name: "campaignId", in: "path" },
        description: "The campaign whose queue is being drained.",
        example: "camp-1",
      }),
    }),
  },
  parameters: FollowupOrgHeaders,
  responses: {
    200: {
      description: "The claimed person, or nobody with a named reason",
      content: { "application/json": { schema: FollowupClaimSchema } },
    },
    400: { description: "Missing campaignId or x-org-id" },
    401: { description: "Unauthorized" },
    500: { description: "Internal server error" },
    502: {
      description:
        "The delivery layer could not say who opted out (code opt_out_lookup_unavailable). Nobody is claimed rather than somebody answered on a guess: a wasted poll is recoverable, an email to somebody who asked us to stop is not.",
    },
  },
});

const ScheduleFollowupByEmailRequestSchema = z
  .object({
    email: z.string().openapi({
      description:
        "The person's email address. Matched EXACTLY (case-folded equality against the registered contact method) and never fuzzily: writing the debt onto the wrong person's row makes us email somebody who never replied, which cannot be taken back.",
      example: "prospect@example.com",
    }),
    dueAt: z.string().openapi({
      description:
        "ISO-8601 timestamp: when the answer is owed. \"Now\" is the ordinary case (a reply just landed). Bounded, never clamped — a date in the past beyond a few minutes of clock skew, or further out than a year, is a 400 carrying the accepted range.",
      example: "2026-09-05T09:00:00.000Z",
    }),
  })
  .openapi("ScheduleFollowupByEmailRequest", {
    description: "An answer is owed to the person at this address, on this campaign, at this time.",
  });

registry.registerPath({
  method: "post",
  path: "/orgs/campaigns/{campaignId}/followups/schedule-by-email",
  summary: "State that an answer is owed to a person identified by email",
  description:
    "The door into the follow-up queue for a caller that does NOT hold this service's " +
    "leads_campaigns row id — the service that qualifies a reply holds the campaign and the " +
    "person's address, and nothing else. Identical in effect to POST /orgs/leads/{id}/followups " +
    "with kind=scheduled, differing only in how the row is identified. Identification is EXACT: a " +
    "case-folded equality match on the registered email contact method, scoped to this org and the " +
    "campaign named. There is no substring, fuzzy or best-guess path — an unknown address is a 404 " +
    "(code lead_not_found) and an address that matches more than one row is a 409 (code " +
    "ambiguous_lead, listing the matches), because a silent no-op would leave the caller believing " +
    "the debt was recorded and a guess would email the wrong human. The campaign scope is the id " +
    "NAMED, not its identity family, matching the claim's scope exactly: enqueueing onto a sibling " +
    "campaign would write a debt nothing ever claims. The queue's stop conditions (opted out, a " +
    "booked meeting on record) apply to a row enqueued this way exactly as to any other — they are " +
    "enforced at claim time, which is the only moment they can be read honestly.",
  request: {
    params: z.object({
      campaignId: z.string().openapi({
        param: { name: "campaignId", in: "path" },
        description: "The campaign the debt is owed on — the same campaign the claim will name.",
        example: "camp-1",
      }),
    }),
    body: { content: { "application/json": { schema: ScheduleFollowupByEmailRequestSchema } } },
  },
  parameters: FollowupOrgHeaders,
  responses: {
    200: {
      description: "The resulting follow-up state, plus the person the address resolved to",
      content: {
        "application/json": {
          schema: z.object({
            followup: FollowupStateSchema,
            leadId: z.string().openapi({ description: "The person the address resolved to." }),
            email: z.string().openapi({ description: "The registered address, as stored." }),
          }),
        },
      },
    },
    400: {
      description:
        "Missing campaignId or x-org-id, a missing/invalid email, an unparseable dueAt (code due_date_unparseable), or one outside the accepted range (code due_date_out_of_bounds, with the bounds)",
    },
    401: { description: "Unauthorized" },
    404: {
      description:
        "No lead on this campaign holds that email address (code lead_not_found). A named refusal, never a silent no-op.",
    },
    409: {
      description:
        "That address matches more than one lead row on this campaign (code ambiguous_lead, with the matches). Refused rather than resolved by picking one.",
    },
    500: { description: "Internal server error" },
  },
});

const FollowupStatementRequestSchema = z
  .object({
    kind: z.enum(["scheduled", "acted", "stopped"]).openapi({
      description:
        "scheduled — we owe this person an action at dueAt (the first enqueue after qualification, and the re-enqueue after a fresh reply has been re-qualified); it is not an action, so the count does not move. acted — a worker answered them, and nextDueAt says when the next answer is owed; this is the only kind that increments the count. stopped — nothing is owed right now, and reason says why; NOT a tombstone, a later scheduled re-enters the person, which is exactly how \"they answered again\" is expressed.",
      example: "acted",
    }),
    dueAt: z.string().optional().openapi({
      description:
        "ISO-8601 timestamp, REQUIRED on kind=scheduled. Bounded, never clamped: a date in the past or further out than a year is a 400 carrying the accepted range, because silently answering a request nobody made would leave the caller believing its date was honoured.",
      example: "2026-09-02T12:00:00.000Z",
    }),
    nextDueAt: z.string().optional().openapi({
      description:
        "ISO-8601 timestamp, REQUIRED on kind=acted: when the NEXT action is owed. This service does not compute it. The interval is chosen per lead by the worker — a prospect who writes \"recontact me in January\" must be honoured — so it is stored data, not a ladder, and the growing intervals are what limit the sequence rather than a cap on the number of follow-ups (there is none).",
      example: "2026-09-09T09:00:00.000Z",
    }),
    reason: z.string().optional().openapi({
      description:
        "REQUIRED on kind=stopped: why nothing is owed right now, stated by the caller and stored verbatim (\"answered_again\", \"meeting_booked\", \"not_interested\"). Absent is a 400, never an empty string.",
      example: "answered_again",
    }),
  })
  .openapi("FollowupStatementRequest", {
    description: "What we owe one person on one campaign next.",
  });

registry.registerPath({
  method: "post",
  path: "/orgs/leads/{id}/followups",
  summary: "Record what was done for this person and when the next action is due",
  description:
    "The lead is named by the `id` a list row already carries, so nothing about the person is " +
    "re-supplied. The write releases any claim, so recording is what returns a person to the queue " +
    "(or removes them from it) rather than waiting out the lease. The response IS the resulting " +
    "state, so a caller never has to ask what its write did.",
  request: {
    params: LeadRowIdPathParam,
    body: { content: { "application/json": { schema: FollowupStatementRequestSchema } } },
  },
  parameters: FollowupOrgHeaders,
  responses: {
    200: {
      description: "The resulting follow-up state",
      content: { "application/json": { schema: z.object({ followup: FollowupStateSchema }) } },
    },
    400: {
      description:
        "Invalid id or kind; a missing reason on kind=stopped (code reason_required); an unparseable due date (code due_date_unparseable); or one outside the accepted range (code due_date_out_of_bounds, with the bounds)",
    },
    401: { description: "Unauthorized" },
    404: { description: "No such lead row for this org" },
    500: { description: "Internal server error" },
  },
});

registry.registerPath({
  method: "get",
  path: "/orgs/leads/{id}/followups",
  summary: "Read one person's follow-up state",
  description: "What we owe this person, when, how many follow-ups have gone out, and why the schedule is empty when it is.",
  request: { params: LeadRowIdPathParam },
  parameters: FollowupOrgHeaders,
  responses: {
    200: {
      description: "The follow-up state",
      content: { "application/json": { schema: z.object({ followup: FollowupStateSchema }) } },
    },
    400: { description: "Invalid id" },
    401: { description: "Unauthorized" },
    404: { description: "No such lead row for this org" },
    500: { description: "Internal server error" },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// A LEAD'S HISTORY — GET /orgs/leads/{id}/history
//
// One read that answers what happened to a person, in order, with the words. Assembled here from
// the services that own each fact, so a consumer renders it without merging anything — which is
// what six services being merged in a browser had made impossible.
// ─────────────────────────────────────────────────────────────────────────────

const HistorySourceStateSchema = z
  .object({
    source: z.enum(["lead-service", "delivery", "outreach", "mailbox", "content"]).openapi({
      description:
        "Who owns this fact. lead-service: the lifecycle, the funnel statements, the conversions and the follow-up debt. delivery: email-gateway's measured evidence. outreach: the messages the outreach provider carried, plus the reply and opt-out statements a human recorded. mailbox: the customer's own Gmail mirror — for some prospects the ONLY copy of the exchange. content: the copy we generated and the cadence it planned.",
    }),
    status: z.enum(["ok", "unavailable", "not_asked"]).openapi({
      description:
        "ok: it answered. unavailable: it could NOT be read, and what it holds is therefore missing from `events` — never read that absence as nothing having happened. not_asked: there was nothing in scope to ask it about (an unserved lead, a person with no registered email).",
    }),
    reason: z.string().nullable().openapi({
      description: "Why it could not answer, or why it was not asked. Null when it answered.",
    }),
  })
  .openapi("LeadHistorySourceState");

const HistoryEventSchema = z
  .object({
    id: z.string().openapi({ description: "Stable within one response — key a rendered list on it." }),
    at: z.string().nullable().openapi({
      description:
        "ISO 8601 UTC when it happened, or null when the fact carries no date. Events are ordered oldest first and undated ones come LAST — never placed at the epoch.",
    }),
    type: z
      .enum([
        "generated_email",
        "message",
        "delivery",
        "lifecycle",
        "reply_statement",
        "opt_out_statement",
        "step_statement",
        "conversion",
        "followup",
      ])
      .openapi({
        description:
          "What kind of thing this is. A reply whose WORDS we hold is a `message`; a reply somebody wrote down because it never reached us is a `reply_statement` and carries no body — the two are different facts and a consumer renders them differently without having to guess. A `generated_email` is the copy we DRAFTED, and it is stated only while nothing has been sent yet: once we hold the message that went out, that message is the one event for that email.",
      }),
    evidence: z.enum(["observed", "asserted"]).openapi({
      description:
        "observed: a fact we hold — a message we can produce the words of, a milestone the delivery layer measured, an outcome the tracker reported. asserted: a fact somebody stated — a recorded reply, a recorded opt-out, a hand-stated funnel step.",
    }),
    source: z.enum(["lead-service", "delivery", "outreach", "mailbox", "content"]),
    campaignId: z.string().nullable().openapi({
      description:
        "The campaign this happened on, when the fact belongs to one. Null where the holder genuinely does not know: a mailbox knows an address, a website tracker knows a brand, an opt-out belongs to the person.",
    }),
    direction: z.enum(["inbound", "outbound"]).nullable(),
    milestone: z.string().optional().openapi({
      description:
        "On a `delivery` event: sent | delivered | opened | clicked | replied | bounced | unsubscribed. On a `lifecycle` event: served | handed_to_sending. A `sent` or `replied` milestone is OMITTED when the message carrying those words is already in the list — the de-duplication happens here, not in the consumer.",
    }),
    from: z.string().nullable().optional(),
    to: z.array(z.string()).optional(),
    subject: z.string().nullable().optional(),
    bodyText: z.string().nullable().optional().openapi({
      description:
        "The words, as readable text. Null when no body was handed over — `bodyStatus` says whether that is an empty message or one we could not read.",
    }),
    bodyStatus: z.enum(["ok", "empty", "unavailable"]).optional().openapi({
      description:
        "On a `message` and on a `generated_email`. ok: these are the words. empty: the holder handed over a body and it genuinely says nothing. unavailable: the thing exists and no body we could read came with it — deliberately NOT the same answer as empty, so a consumer can say out loud why an email it was told about has no words instead of rendering a date and nothing else.",
    }),
    threadId: z.string().nullable().optional(),
    heldBy: z.array(z.string()).optional().openapi({
      description:
        "Which copies hold this message. One message mirrored on both the outreach side and the customer's mailbox is ONE event naming both, never two.",
    }),
    copy: z.string().nullable().optional().openapi({
      description:
        "Which copy it was read from. `mirror` is the outreach provider's mailbox as we hold it — the copy that outlives the subscription being cancelled.",
    }),
    links: z
      .array(
        z.object({
          text: z.string().openapi({
            description:
              "The link's text, verbatim as it appears in the body the prospect read. The sending side strips our tracking parameters from it on purpose, so this is the clean URL the prospect saw.",
          }),
          href: z.string().nullable().openapi({
            description:
              "Where the link truly leads, carrying the tracking parameters we put on it — resolved against the copy we generated. Null when it cannot be resolved to a URL we wrote; never a guess, and NEVER the outreach provider's click-tracking redirect, which following from a dashboard would register a click the prospect never made.",
          }),
        }),
      )
      .optional()
      .openapi({
        description:
          "On a `message`: the links in it, so a consumer can render real links — what the prospect saw, and where each actually goes.",
      }),
    plannedSequence: z.unknown().optional().openapi({
      description:
        "On a `generated_email`: the cadence the sequence PLANNED, verbatim from its producer. It is a plan, not a promise — what is still owed is the `followup` event, read from live state.",
    }),
    model: z.string().nullable().optional(),
    replyKind: z.string().optional(),
    channel: z.string().optional(),
    step: z.string().optional(),
    kind: z.enum(["outcome", "never"]).optional(),
    event: z.string().optional(),
    valueCents: z.number().nullable().optional(),
    costCents: z.number().nullable().optional(),
    matchConfidence: z.string().nullable().optional(),
    attributionStatus: z.string().nullable().optional(),
    statedBy: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    state: z.enum(["scheduled", "stopped"]).optional(),
    dueAt: z.string().nullable().optional().openapi({
      description:
        "On a `followup`: when the next answer is owed. Always null on a stopped schedule — a stopped sequence never advertises a next follow-up.",
    }),
    followupCount: z.number().optional(),
    stoppedReason: z.string().nullable().optional(),
  })
  .openapi("LeadHistoryEvent");

const LeadHistoryResponseSchema = z
  .object({
    leadCampaignId: z.string(),
    leadId: z.string(),
    campaignId: z.string(),
    brandId: z.string(),
    email: z.string().nullable(),
    scope: z.enum(["campaign", "brand"]).openapi({
      description:
        "Which question was answered. campaign: what THIS campaign did, resolved to the campaign's whole identity. brand: the roll-up across every campaign of the brand this person is in. Both are legitimate and the answer always says which it gave.",
    }),
    campaignIds: z.array(z.string()).openapi({
      description: "The campaigns actually asked about.",
    }),
    campaignsTruncated: z.boolean().openapi({
      description:
        "True when this person is in more campaigns than one read fans out over. The answer is then bounded, and `complete` is false — a capped answer must never look like a whole one.",
    }),
    complete: z.boolean().openapi({
      description:
        "False when ANY source could not answer, or when the campaign fan-out was bounded. A consumer must never render this list as the whole story while it is false.",
    }),
    sources: z.array(HistorySourceStateSchema),
    events: z.array(HistoryEventSchema).openapi({
      description: "Oldest first, undated last. Already merged and de-duplicated.",
    }),
  })
  .openapi("LeadHistoryResponse");

registry.registerPath({
  method: "get",
  path: "/orgs/leads/{id}/history",
  summary: "Everything that happened to one person, in order, in one place",
  description:
    "Both directions of every exchange WITH THE MESSAGE BODIES, what we sent and when it was delivered, " +
    "what the person did, what somebody recorded by hand and who recorded it, and what it converted into — " +
    "one ordered list a consumer renders without merging anything. Every fact is asked of the service that " +
    "owns it and none is re-derived here; no funnel or outcome logic lives in this read. A fact we HOLD and " +
    "a fact somebody ASSERTED are distinguishable (`evidence`), and so are a reply we can produce the words " +
    "of (a `message`) and a reply somebody wrote down because it never reached us (a `reply_statement`). A " +
    "source that could not be read is stated as unreachable in `sources` and sets `complete: false`; it " +
    "degrades only itself and never empties the list, because \"we could not read this\" and \"this did not " +
    "happen\" are different facts.",
  request: { params: LeadRowIdPathParam },
  parameters: [
    ...FollowupOrgHeaders,
    {
      in: "query" as const,
      name: "scope",
      required: false,
      schema: { type: "string" as const, enum: ["campaign", "brand"] },
      description:
        "campaign (default): what this campaign did, resolved to the campaign's whole identity. brand: the roll-up across every campaign of the brand this person is in.",
    },
    {
      in: "query" as const,
      name: "brandId",
      required: false,
      schema: { type: "string" as const },
      description:
        "Which brand the history is about — the same scoping GET /orgs/leads/{id} takes. A brand this row is not part of answers 404, exactly as an absent row does.",
    },
  ],
  responses: {
    200: {
      description: "The person's history, ordered",
      content: { "application/json": { schema: LeadHistoryResponseSchema } },
    },
    400: { description: "id is not a uuid, or scope is not one of campaign | brand" },
    401: { description: "Unauthorized" },
    404: { description: "No such lead row for this org (or for the requested brand scope)" },
    500: { description: "Internal server error" },
  },
});
