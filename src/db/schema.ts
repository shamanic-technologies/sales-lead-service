import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";

// Leads — global identity registry (no org/brand/campaign scoping)
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apolloPersonId: text("apollo_person_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_leads_apollo_person_id").on(table.apolloPersonId),
  ]
);

// Lead emails — email addresses belonging to a lead (1:N)
export const leadEmails = pgTable(
  "lead_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lead_emails_lead_email").on(table.leadId, table.email),
    uniqueIndex("idx_lead_emails_email").on(table.email),
  ]
);

// Served leads — audit log of leads pulled from buffer (dedup now via email-gateway)
export const servedLeads = pgTable(
  "served_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id").references(() => leads.id),
    namespace: text("namespace").notNull(),
    email: text("email").notNull(),
    apolloPersonId: text("apollo_person_id"),
    metadata: jsonb("metadata"),
    parentRunId: text("parent_run_id"),
    runId: text("run_id"),
    brandIds: text("brand_ids").array().notNull(),
    campaignId: text("campaign_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_served_org_campaign_email").on(table.orgId, table.campaignId, table.email),
    index("idx_served_brand_ids").using("gin", table.brandIds),
    index("idx_served_campaign").on(table.campaignId),
    index("idx_served_org_id").on(table.orgId),
    index("idx_served_user_id").on(table.userId),
  ]
);

// Lead buffer — temporary staging for leads not yet served
export const leadBuffer = pgTable(
  "lead_buffer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: text("namespace").notNull(),
    campaignId: text("campaign_id").notNull(),
    email: text("email").notNull(),
    apolloPersonId: text("apollo_person_id"),
    data: jsonb("data"),
    status: text("status").notNull().default("buffered"),
    pushRunId: text("push_run_id"),
    brandIds: text("brand_ids").array(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    statusReason: text("status_reason"),
    statusDetails: text("status_details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_buffer_org_campaign_ns_status").on(table.orgId, table.campaignId, table.namespace, table.status),
    index("idx_buffer_org_campaign_extid").on(table.orgId, table.campaignId, table.apolloPersonId),
  ]
);

// Enrichments — global cache for Apollo enrichment data (no orgId)
export const enrichments = pgTable(
  "enrichments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email"),
    emailStatus: text("email_status"),
    apolloPersonId: text("apollo_person_id"),
    name: text("name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    title: text("title"),
    linkedinUrl: text("linkedin_url"),
    personalEmails: jsonb("personal_emails"),
    mobilePhone: text("mobile_phone"),
    phoneNumbers: jsonb("phone_numbers"),
    organizationId: text("organization_id"),
    organizationName: text("organization_name"),
    organizationDomain: text("organization_domain"),
    organizationIndustry: text("organization_industry"),
    organizationSize: text("organization_size"),
    organizationRawAddress: text("organization_raw_address"),
    responseRaw: jsonb("response_raw"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_enrichments_email").on(table.email),
    uniqueIndex("idx_enrichments_apollo_person_id").on(table.apolloPersonId),
  ]
);

// Idempotency cache — prevents duplicate lead consumption on retries
export const idempotencyCache = pgTable(
  "idempotency_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    orgId: text("org_id").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_idempotency_key").on(table.idempotencyKey),
  ]
);

// Cursors — pagination state per org+namespace
export const cursors = pgTable(
  "cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    namespace: text("namespace").notNull(),
    state: jsonb("state"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cursors_org_ns").on(table.orgId, table.namespace),
  ]
);

// Type exports
export type ServedLead = typeof servedLeads.$inferSelect;
export type NewServedLead = typeof servedLeads.$inferInsert;
export type LeadBufferRow = typeof leadBuffer.$inferSelect;
export type NewLeadBufferRow = typeof leadBuffer.$inferInsert;
export type Cursor = typeof cursors.$inferSelect;
export type NewCursor = typeof cursors.$inferInsert;
export type Enrichment = typeof enrichments.$inferSelect;
export type NewEnrichment = typeof enrichments.$inferInsert;
export type IdempotencyCacheRow = typeof idempotencyCache.$inferSelect;
export type NewIdempotencyCacheRow = typeof idempotencyCache.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadEmail = typeof leadEmails.$inferSelect;
export type NewLeadEmail = typeof leadEmails.$inferInsert;
