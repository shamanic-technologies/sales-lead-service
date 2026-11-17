-- UNMATCHED-MEETINGS-1117: a conversion the brand's site tag reported for a person we never contacted is still the brand's
-- conversion. The intake sweep (src/lib/conversion-intake.ts) files that person, by the address the event itself carries,
-- as a lead of the brand and attributes the row to them. Kept beside the row: WHEN the intake attributed it, and the
-- name-only candidate a held (needs_review) row pointed at before (never evidence, kept for the record).
ALTER TABLE conversion_events ADD COLUMN IF NOT EXISTS attributed_by_intake_at timestamptz;
ALTER TABLE conversion_events ADD COLUMN IF NOT EXISTS review_candidate_lead_id uuid;
