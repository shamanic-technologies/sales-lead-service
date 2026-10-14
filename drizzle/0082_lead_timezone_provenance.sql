-- WHERE a lead's timezone came from (PUSHED-PERSON-TZ-1014, owner 2026-10-14).
--
-- A person a client PUSHES (email / name / phone) has no enrichment, so `leads.timezone` stayed NULL and
-- every sender fell back to America/Chicago. The zone is now STATED by the client, carried from the
-- ENRICHMENT, or INFERRED here from what we hold about the person (phone country, location, company
-- country, email country domain). Precedence, enforced by every writer (src/lib/lead-timezone.ts):
-- stated > enrichment > inferred. An inferred zone never overwrites the other two; enrichment never
-- overwrites a stated one.
--
--   timezone_source       'stated' | 'enrichment' | 'inferred'; NULL only while timezone is NULL.
--   timezone_basis        what an inferred zone was read off (phone_country, lead_location,
--                         company_location, email_domain); NULL for stated / enrichment.
--   timezone_checked_at   when the inference last looked at a lead with no zone (the sweep visits each
--                         lead once; a filing re-infers on its own).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timezone_source text;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timezone_basis text;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS timezone_checked_at timestamptz;
--> statement-breakpoint
-- Every zone stored before this migration came from the enrichment (human-service / apollo-service, and
-- the one-time backfill of the enrichment we had already bought).
UPDATE leads SET timezone_source = 'enrichment' WHERE timezone IS NOT NULL AND timezone_source IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_timezone_unchecked ON leads (created_at, id)
  WHERE timezone IS NULL AND timezone_checked_at IS NULL;
