-- SCRIPT-VALUE-RATING-1113-LEAD: a due follow-up served to a campaign's proactive tick FOR ITS OWN CLAIM (buffer/next
-- `dueFollowupOnly`) is held for that campaign until it claims the person (claim-next consumes the hold) or the hold
-- ends; no other due serve hands the person meanwhile. NULL = every other kind of due serve (unchanged).
ALTER TABLE lead_followup_due_serves ADD COLUMN IF NOT EXISTS held_for_claim_until timestamptz;
