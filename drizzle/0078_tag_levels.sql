-- Every tag at its level (owner 2026-10-13, LEAD-REFONTE-1013 step 4).
--
-- company_disqualification_marks  "Disqualified" at COMPANY level ("not our target"): ONE mark covers
--   every lead of that company for the brand (and offer: offer_key '' = every offer), beside the
--   lead-level marks (lead_disqualification_marks: "not the right contact", "left the role"), which
--   stay the lead's own and never follow a person to another company. company_key = the brand-service
--   company id, else 'org:<organizations.id>' for a name-only employer (moved to the brand id by the
--   identity sweep once the employer gets one). A buyer fact about the company: it lives HERE, never in
--   brand-service. Removing = withdrawn_at.
CREATE TABLE IF NOT EXISTS company_disqualification_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  company_key text NOT NULL,
  offer_key text NOT NULL,
  source text NOT NULL,
  note text,
  -- The lead and list row it was stated from: attribution only, never a read key.
  stated_from_lead_id uuid,
  lead_campaign_id uuid,
  stated_by_user_id text,
  stated_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by_user_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_cdm_key
  ON company_disqualification_marks (org_id, brand_id, company_key, offer_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cdm_company ON company_disqualification_marks (company_key);
--> statement-breakpoint
-- What this service stated on a human in human-service (an opt-out it observed), one row per source
-- fact, so a fact is stated once and never again.
CREATE TABLE IF NOT EXISTS human_fact_statements (
  source_ref text PRIMARY KEY,
  human_id uuid NOT NULL,
  kind text NOT NULL,
  fact_id uuid,
  stated_at timestamptz NOT NULL DEFAULT now(),
  -- The source fact was taken back (a verdict changed): the human fact was withdrawn too.
  withdrawn_at timestamptz
);
--> statement-breakpoint
-- A lead with NO employer (a signup, a named person) is at the company its WORK address names: the
-- identity sweep asks brand-service for the address's domain (a free-mail domain names no company)
-- once, and records when it asked here.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_company_checked_at timestamptz;
