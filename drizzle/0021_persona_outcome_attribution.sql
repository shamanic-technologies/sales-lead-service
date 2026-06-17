-- 0021: Preserve real persona/profile attribution for served leads.
--
-- These columns are nullable on purpose. Rows without explicit upstream tags
-- stay unattributed; stats must not infer persona/profile assignments.
ALTER TABLE "leads_campaigns"
  ADD COLUMN IF NOT EXISTS "goal" text,
  ADD COLUMN IF NOT EXISTS "active_goal_id" text,
  ADD COLUMN IF NOT EXISTS "brand_profile_id" text,
  ADD COLUMN IF NOT EXISTS "customer_persona_id" text,
  ADD COLUMN IF NOT EXISTS "customer_profile_id" text;

CREATE INDEX IF NOT EXISTS "idx_lc_persona_attribution"
  ON "leads_campaigns" (
    "org_id",
    "feature_slug",
    "goal",
    "active_goal_id",
    "brand_profile_id",
    "customer_persona_id",
    "customer_profile_id",
    "status"
  );
