-- 0020: Add apify_offset to campaigns_apollo_strategies.
--
-- People sourcing now goes through the human-service people gateway, which can
-- route to apollo (server-managed cursor) OR apify (client-managed offset).
-- apify pagination must persist across buffer/next calls, so we store the offset
-- for the current strategy here. apollo ignores it (its cursor lives in the
-- gateway, keyed on org + campaign). Existing rows default to 0.
ALTER TABLE "campaigns_apollo_strategies"
  ADD COLUMN IF NOT EXISTS "apify_offset" integer NOT NULL DEFAULT 0;
