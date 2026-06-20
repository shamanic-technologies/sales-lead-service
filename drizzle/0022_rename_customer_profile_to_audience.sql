-- 0022: Rename leads_campaigns.customer_profile_id -> audience_id.
--
-- The column always stored the human-service audience.id (the resolved audience
-- for the serve). "customerProfileId" was the old fleet-wide name; runs-service,
-- workflow-service and features-service now all speak "audienceId". This renames
-- the stored column to match. The idx_lc_persona_attribution index follows the
-- column rename automatically (Postgres updates dependent index definitions).
-- Guarded so a partially-applied state is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'leads_campaigns' AND column_name = 'customer_profile_id'
  ) THEN
    ALTER TABLE "leads_campaigns" RENAME COLUMN "customer_profile_id" TO "audience_id";
  END IF;
END $$;
