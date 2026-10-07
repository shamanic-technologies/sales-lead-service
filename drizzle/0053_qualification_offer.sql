-- Qualification criteria belong to the OFFER (owner 2026-10-07): a criterion says why a company
-- NEEDS this offer, and applies to every audience of that offer. The brand-level rows written
-- before this (two test rows, one org) are RETIRED, not guessed onto an offer: verdicts are keyed
-- on question+probe, so re-creating the same check on an offer reuses every stored answer free.
ALTER TABLE qualification_criteria ADD COLUMN IF NOT EXISTS offer_id text;
--> statement-breakpoint
-- On/off is the client's switch; archive is "gone". A suggestion is written OFF.
ALTER TABLE qualification_criteria ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE qualification_criteria ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'custom';
--> statement-breakpoint
ALTER TABLE qualification_criteria ADD COLUMN IF NOT EXISTS why text;
--> statement-breakpoint
-- Set when a person changes the row (on/off, mode): a suggestion nobody touched is replaced by the next list.
ALTER TABLE qualification_criteria ADD COLUMN IF NOT EXISTS updated_at timestamptz;
--> statement-breakpoint
UPDATE qualification_criteria SET archived_at = now() WHERE offer_id IS NULL AND archived_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_qc_org_brand;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qc_org_brand_offer ON qualification_criteria (org_id, brand_id, offer_id) WHERE archived_at IS NULL;
--> statement-breakpoint
-- Suggestions are now criteria rows written off (origin 'suggested'): one list, one switch.
DROP TABLE IF EXISTS qualification_suggestions;
--> statement-breakpoint
-- Every time a criterion was applied to a person (a sample on a lead, a must-pass on a serve
-- candidate): the PASS RATE is counted here, the verdict read through verdict_id (never copied).
-- verdict_id NULL = nothing could be judged (no company domain), counted unavailable with reason.
CREATE TABLE IF NOT EXISTS qualification_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_id uuid NOT NULL,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  offer_id text NOT NULL,
  -- 'lead:<leadId>' or 'candidate:<audienceId>:<providerPersonId>'
  subject text NOT NULL,
  domain text,
  verdict_id uuid REFERENCES qualification_verdicts(id),
  reason text,
  run_id text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_qck_criterion_subject ON qualification_checks (criterion_id, subject);
