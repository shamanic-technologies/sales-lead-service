-- A person the BRAND itself names through a trigger occurrence is made due for THAT occurrence, even on a
-- row handed to a person (PUSHED-TRUTH-1015; prod 2026-10-15, row 035a85fe: a client pushed a new email
-- to a person whose earlier reply had been handed to its team; schedule-by-email left the due date NULL,
-- the run claimed nobody, the occurrence was redelivered 6 times and never sent).
--
-- The hand-over keeps guarding what it was made for (no responder answers that person's replies on its
-- own initiative); the brand's explicit act is not a responder deciding to answer. See
-- src/lib/followup-queue.ts `writeFollowupStatement` / `claimFollowup`.
--
-- followup_stated_event_id   — the occurrence (campaign-service trigger event id) that last made the row due
-- followup_stated_trigger_id — its trigger type, as stated
-- followup_stated_at         — when that statement was written
-- followup_stated_closed_at  — when the grant was used up (a claim consumed it, or a later hand-over closed
--                              it); NULL with an event id = the grant is still open.
--                              On a handed row ONLY an open grant makes the row claimable, by the holding
--                              campaign only, exactly once per statement.
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_stated_event_id text;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_stated_trigger_id text;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_stated_at timestamptz;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_stated_closed_at timestamptz;
