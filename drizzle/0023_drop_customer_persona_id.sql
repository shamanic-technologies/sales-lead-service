-- 0023: Drop leads_campaigns.customer_persona_id.
--
-- customerPersonaId / x-customer-persona-id was a legacy pass-through attribution
-- dimension, fully superseded by audience_id (#302). It was threaded and stored
-- but aggregated nowhere in runs-service / features-service. Removed fleet-wide.
--
-- Dropping the column auto-drops idx_lc_persona_attribution (the column was a
-- member). We then recreate that index WITHOUT customer_persona_id to match the
-- schema. All steps are guarded so a partially-applied state is a no-op.
ALTER TABLE "leads_campaigns" DROP COLUMN IF EXISTS "customer_persona_id";

DROP INDEX IF EXISTS "idx_lc_persona_attribution";

CREATE INDEX IF NOT EXISTS "idx_lc_persona_attribution"
  ON "leads_campaigns" (
    "org_id",
    "feature_slug",
    "goal",
    "active_goal_id",
    "brand_profile_id",
    "audience_id",
    "status"
  );
