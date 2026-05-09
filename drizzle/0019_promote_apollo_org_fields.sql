-- 0019: Promote Apollo organization fields from JSONB blob into structured columns.
--
-- Adds 14 new columns to organizations:
--   - 5 funding-family columns (latest_funding_stage, latest_funding_round_date,
--     total_funding, total_funding_printed, funding_events)
--   - 9 misc columns (retail_location_count, publicly_traded_symbol,
--     publicly_traded_exchange, primary_phone, seo_description, angellist_url,
--     num_suborganizations, alexa_ranking, keywords)
--
-- Existing rows get NULL until next TTL-driven re-enrichment.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "latest_funding_stage" text,
  ADD COLUMN IF NOT EXISTS "latest_funding_round_date" date,
  ADD COLUMN IF NOT EXISTS "total_funding" numeric,
  ADD COLUMN IF NOT EXISTS "total_funding_printed" text,
  ADD COLUMN IF NOT EXISTS "funding_events" jsonb,
  ADD COLUMN IF NOT EXISTS "retail_location_count" integer,
  ADD COLUMN IF NOT EXISTS "publicly_traded_symbol" text,
  ADD COLUMN IF NOT EXISTS "publicly_traded_exchange" text,
  ADD COLUMN IF NOT EXISTS "primary_phone" text,
  ADD COLUMN IF NOT EXISTS "seo_description" text,
  ADD COLUMN IF NOT EXISTS "angellist_url" text,
  ADD COLUMN IF NOT EXISTS "num_suborganizations" integer,
  ADD COLUMN IF NOT EXISTS "alexa_ranking" integer,
  ADD COLUMN IF NOT EXISTS "keywords" text[];
