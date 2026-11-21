-- BRAND-PROOF-LOGOS-1121 follow-up 3: a paying client with nothing to look them up by (no email, no LinkedIn profile,
-- no phone) is ATTEMPTED and recorded `no_identifier` (nothing spent), instead of sitting `not_looked_up` forever.
ALTER TABLE client_history_lookups DROP CONSTRAINT IF EXISTS client_history_lookups_status_check;
ALTER TABLE client_history_lookups ADD CONSTRAINT client_history_lookups_status_check
  CHECK (status IN ('history_found', 'no_linkedin', 'no_experience', 'profile_unreadable', 'no_identifier'));
