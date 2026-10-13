-- A hand-over to a person can be WITHDRAWN by the observer that stated it, when the verdict behind it
-- turns out wrong (2026-10-13, DefiniteJobs row 80f744e2: a positive reply was judged off topic and
-- handed over; the classifier was fixed, the reply re-judged positive, and the row stayed handed for
-- good). See src/lib/followup-queue.ts `withdrawHandover`.
--
-- followup_handed_reasons — every hand-over's reason, in order (followup_handed_reason keeps only the
--                           FIRST). A withdrawal lifts the row only when EVERY hand-over on it named the
--                           withdrawn reason: a person's hand-over, or any other reason, is never lifted
--                           by it (the Shockwavecenters guarantee holds).
-- followup_handover_withdrawn_*  — the trace of the last lifted hand-over: when it was withdrawn, why,
--                           and the hand-over it lifted (its time and reasons).
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handed_reasons text[];
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handover_withdrawn_at timestamptz;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handover_withdrawn_reason text;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handover_withdrawn_handed_at timestamptz;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handover_withdrawn_handed_reasons text[];

-- Backfill the hand-overs already on record. A handed row's stop reason is the LATEST hand-over's
-- reason (every hand-over rewrites it, nothing else does), so a row whose first and latest reasons
-- differ carries both: it can never be lifted by naming only one of them.
UPDATE leads_campaigns
   SET followup_handed_reasons = CASE
         WHEN followup_stopped_reason IS NOT NULL
          AND followup_stopped_reason IS DISTINCT FROM followup_handed_reason
           THEN ARRAY[followup_handed_reason, followup_stopped_reason]
         ELSE ARRAY[followup_handed_reason]
       END
 WHERE followup_handed_at IS NOT NULL
   AND followup_handed_reasons IS NULL;
