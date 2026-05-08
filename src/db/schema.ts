import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  integer,
  numeric,
  boolean,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Leads — global identity registry ---
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apolloPersonId: text("apollo_person_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    name: text("name"),
    linkedinUrl: text("linkedin_url"),
    photoUrl: text("photo_url"),
    headline: text("headline"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    seniority: text("seniority"),
    departments: text("departments").array(),
    subdepartments: text("subdepartments").array(),
    functions: text("functions").array(),
    twitterUrl: text("twitter_url"),
    githubUrl: text("github_url"),
    facebookUrl: text("facebook_url"),
    metadata: jsonb("metadata"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_leads_apollo_person_id").on(table.apolloPersonId)],
);

// --- Lead contact methods — polymorphic (email, phone, twitter, etc.) ---
export const leadContactMethods = pgTable(
  "lead_contact_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    value: text("value").notNull(),
    status: text("status"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lcm_lead_channel_value").on(table.leadId, table.channel, table.value),
    uniqueIndex("idx_lcm_channel_value").on(table.channel, table.value),
    index("idx_lcm_value").on(table.value),
  ],
);

// --- Organizations — global org registry ---
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apolloOrganizationId: text("apollo_organization_id"),
    name: text("name"),
    primaryDomain: text("primary_domain"),
    websiteUrl: text("website_url"),
    industry: text("industry"),
    estimatedNumEmployees: integer("estimated_num_employees"),
    annualRevenue: numeric("annual_revenue"),
    logoUrl: text("logo_url"),
    shortDescription: text("short_description"),
    linkedinUrl: text("linkedin_url"),
    twitterUrl: text("twitter_url"),
    facebookUrl: text("facebook_url"),
    blogUrl: text("blog_url"),
    crunchbaseUrl: text("crunchbase_url"),
    foundedYear: integer("founded_year"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    streetAddress: text("street_address"),
    postalCode: text("postal_code"),
    technologyNames: text("technology_names").array(),
    industries: text("industries").array(),
    secondaryIndustries: text("secondary_industries").array(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_organizations_apollo_organization_id").on(table.apolloOrganizationId),
  ],
);

// --- Lead employment history (M:N leads <-> organizations) ---
export const leadsOrganizations = pgTable(
  "leads_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    current: boolean("current").notNull().default(false),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lo_lead_org_start").on(table.leadId, table.organizationId, table.startDate),
    index("idx_lo_lead_current").on(table.leadId, table.current),
  ],
);

// --- Leads ↔ campaigns: per-campaign lifecycle ---
export const leadsCampaigns = pgTable(
  "leads_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id),
    campaignId: text("campaign_id").notNull(),
    orgId: text("org_id").notNull(),
    brandIds: text("brand_ids").array().notNull(),
    status: text("status").notNull().default("buffered"),
    statusReason: text("status_reason"),
    statusDetails: text("status_details"),
    pushRunId: text("push_run_id"),
    parentRunId: text("parent_run_id"),
    runId: text("run_id"),
    userId: text("user_id"),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    servedAt: timestamp("served_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lc_lead_campaign").on(table.leadId, table.campaignId),
    index("idx_lc_org_campaign_status").on(table.orgId, table.campaignId, table.status),
    index("idx_lc_brand_ids").using("gin", table.brandIds),
    index("idx_lc_org").on(table.orgId),
    index("idx_lc_campaign").on(table.campaignId),
    index("idx_lc_user").on(table.userId),
  ],
);

// --- Apollo strategies per campaign (multi-strategy cursor) ---
export const campaignsApolloStrategies = pgTable(
  "campaigns_apollo_strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    strategies: jsonb("strategies").notNull().default(sql`'[]'::jsonb`),
    currentIndex: integer("current_index").notNull().default(0),
    exhausted: boolean("exhausted").notNull().default(false),
    exhaustionReason: text("exhaustion_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cas_org_campaign").on(table.orgId, table.campaignId),
  ],
);

// --- Idempotency cache (kept) ---
export const idempotencyCache = pgTable(
  "idempotency_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    orgId: text("org_id").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_idempotency_key").on(table.idempotencyKey)],
);

// --- Type exports ---
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadContactMethod = typeof leadContactMethods.$inferSelect;
export type NewLeadContactMethod = typeof leadContactMethods.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type LeadOrganization = typeof leadsOrganizations.$inferSelect;
export type NewLeadOrganization = typeof leadsOrganizations.$inferInsert;
export type LeadCampaign = typeof leadsCampaigns.$inferSelect;
export type NewLeadCampaign = typeof leadsCampaigns.$inferInsert;
export type CampaignApolloStrategies = typeof campaignsApolloStrategies.$inferSelect;
export type NewCampaignApolloStrategies = typeof campaignsApolloStrategies.$inferInsert;
export type IdempotencyCacheRow = typeof idempotencyCache.$inferSelect;
export type NewIdempotencyCacheRow = typeof idempotencyCache.$inferInsert;
