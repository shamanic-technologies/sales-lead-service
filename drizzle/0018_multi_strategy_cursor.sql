-- 0018: Normalize lead schema + multi-strategy Apollo cursor.
--
-- Drops:
--   - lead_buffer        (replaced by leads_campaigns)
--   - served_leads       (replaced by leads_campaigns)
--   - enrichments        (data folded into leads + organizations + lead_contact_methods)
--   - cursors            (no consumers — dead code)
--   - lead_emails        (replaced by lead_contact_methods)
--
-- Reshapes:
--   - leads (drop metadata-only shape, add structured columns + enrichedAt)
--
-- Creates:
--   - lead_contact_methods           (polymorphic: email/phone/social)
--   - organizations                  (global org registry)
--   - leads_organizations            (employment history M:N)
--   - leads_campaigns                (per-campaign lifecycle)
--   - campaigns_apollo_strategies    (LLM-generated strategy stack + cursor)
--
-- idempotency_cache is unchanged.

-- ---------------------------------------------------------------------------
-- DROP legacy tables
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS "lead_buffer" CASCADE;
DROP TABLE IF EXISTS "served_leads" CASCADE;
DROP TABLE IF EXISTS "enrichments" CASCADE;
DROP TABLE IF EXISTS "cursors" CASCADE;
DROP TABLE IF EXISTS "lead_emails" CASCADE;

-- ---------------------------------------------------------------------------
-- Reshape leads
-- ---------------------------------------------------------------------------
ALTER TABLE "leads" DROP COLUMN IF EXISTS "metadata";

ALTER TABLE "leads"
  ADD COLUMN "first_name" text,
  ADD COLUMN "last_name" text,
  ADD COLUMN "name" text,
  ADD COLUMN "linkedin_url" text,
  ADD COLUMN "photo_url" text,
  ADD COLUMN "headline" text,
  ADD COLUMN "city" text,
  ADD COLUMN "state" text,
  ADD COLUMN "country" text,
  ADD COLUMN "seniority" text,
  ADD COLUMN "departments" text[],
  ADD COLUMN "subdepartments" text[],
  ADD COLUMN "functions" text[],
  ADD COLUMN "twitter_url" text,
  ADD COLUMN "github_url" text,
  ADD COLUMN "facebook_url" text,
  ADD COLUMN "metadata" jsonb,
  ADD COLUMN "enriched_at" timestamptz;

-- ---------------------------------------------------------------------------
-- lead_contact_methods (polymorphic)
-- ---------------------------------------------------------------------------
CREATE TABLE "lead_contact_methods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "value" text NOT NULL,
  "status" text,
  "source" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "idx_lcm_lead_channel_value"
  ON "lead_contact_methods" ("lead_id", "channel", "value");
CREATE UNIQUE INDEX "idx_lcm_channel_value"
  ON "lead_contact_methods" ("channel", "value");
CREATE INDEX "idx_lcm_value"
  ON "lead_contact_methods" ("value");

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "apollo_organization_id" text,
  "name" text,
  "primary_domain" text,
  "website_url" text,
  "industry" text,
  "estimated_num_employees" integer,
  "annual_revenue" numeric,
  "logo_url" text,
  "short_description" text,
  "linkedin_url" text,
  "twitter_url" text,
  "facebook_url" text,
  "blog_url" text,
  "crunchbase_url" text,
  "founded_year" integer,
  "city" text,
  "state" text,
  "country" text,
  "street_address" text,
  "postal_code" text,
  "technology_names" text[],
  "industries" text[],
  "secondary_industries" text[],
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "idx_organizations_apollo_organization_id"
  ON "organizations" ("apollo_organization_id");

-- ---------------------------------------------------------------------------
-- leads_organizations (employment history)
-- ---------------------------------------------------------------------------
CREATE TABLE "leads_organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "title" text,
  "start_date" date,
  "end_date" date,
  "current" boolean NOT NULL DEFAULT false,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "idx_lo_lead_org_start"
  ON "leads_organizations" ("lead_id", "organization_id", "start_date");
CREATE INDEX "idx_lo_lead_current"
  ON "leads_organizations" ("lead_id", "current");

-- ---------------------------------------------------------------------------
-- leads_campaigns (replaces lead_buffer + served_leads)
-- ---------------------------------------------------------------------------
CREATE TABLE "leads_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "lead_id" uuid NOT NULL REFERENCES "leads"("id"),
  "campaign_id" text NOT NULL,
  "org_id" text NOT NULL,
  "brand_ids" text[] NOT NULL,
  "status" text NOT NULL DEFAULT 'buffered',
  "status_reason" text,
  "status_details" text,
  "push_run_id" text,
  "parent_run_id" text,
  "run_id" text,
  "user_id" text,
  "workflow_slug" text,
  "feature_slug" text,
  "served_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "idx_lc_lead_campaign"
  ON "leads_campaigns" ("lead_id", "campaign_id");
CREATE INDEX "idx_lc_org_campaign_status"
  ON "leads_campaigns" ("org_id", "campaign_id", "status");
CREATE INDEX "idx_lc_brand_ids"
  ON "leads_campaigns" USING gin ("brand_ids");
CREATE INDEX "idx_lc_org"
  ON "leads_campaigns" ("org_id");
CREATE INDEX "idx_lc_campaign"
  ON "leads_campaigns" ("campaign_id");
CREATE INDEX "idx_lc_user"
  ON "leads_campaigns" ("user_id");

-- ---------------------------------------------------------------------------
-- campaigns_apollo_strategies
-- ---------------------------------------------------------------------------
CREATE TABLE "campaigns_apollo_strategies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "strategies" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "current_index" integer NOT NULL DEFAULT 0,
  "exhausted" boolean NOT NULL DEFAULT false,
  "exhaustion_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "idx_cas_org_campaign"
  ON "campaigns_apollo_strategies" ("org_id", "campaign_id");
