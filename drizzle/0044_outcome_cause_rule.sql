-- WHOSE WIN an outcome was, for every outcome nobody answered — not only the CRM-evidenced ones.
--
-- `caused_by_outreach` becomes the EFFECTIVE answer on every row (it already was on `source = 'crm'`
-- rows): a person's statement when there is one, else the owner's date rule. So the person's own
-- answer needs a home of its own, or a restatement could not tell "the author said ours" from "the
-- rule said ours" — that is `stated_caused_by_outreach`. And the rule's answer, with the inputs it
-- was computed from and the REASON it gave, is `cause_rule` (see src/lib/outcome-cause.ts), exactly
-- as `crm_evidence.rule` keeps it for CRM rows.
ALTER TABLE conversion_events ADD COLUMN IF NOT EXISTS stated_caused_by_outreach boolean;
--> statement-breakpoint
ALTER TABLE conversion_events ADD COLUMN IF NOT EXISTS cause_rule jsonb;
--> statement-breakpoint
-- Every cause stored on a hand-stated row until now was a PERSON's answer (nothing else wrote one),
-- so it is their statement. Tracker rows never carried one, and a CRM row's override lives in
-- lead_step_cause_statements, so neither has anything to carry over.
UPDATE conversion_events
SET stated_caused_by_outreach = caused_by_outreach
WHERE source = 'manual'
  AND caused_by_outreach IS NOT NULL
  AND stated_caused_by_outreach IS NULL;
--> statement-breakpoint
-- The worker's work list: outcomes nobody answered whose rule answer can still move.
CREATE INDEX IF NOT EXISTS idx_ce_cause_pending ON conversion_events (brand_id)
  WHERE source <> 'crm' AND withdrawn_at IS NULL AND stated_caused_by_outreach IS NULL;
