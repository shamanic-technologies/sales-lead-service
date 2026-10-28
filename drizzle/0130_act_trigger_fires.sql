-- LEAD-EVENT-REFUSAL-NO-REACT-1028: every act of theirs rings Lead event (src/lib/outcome-trigger-rules.ts isTheirNewAct).
-- An act (a refused payment, a product / onboarding event...) is ONE fire per FACT, kept in outcome_trigger_fires under
-- step `act:<crm fact type>`: the once-per-person index now holds outcome steps only, and `item` is what the workflow
-- reads of the act (`trigger.item`).
ALTER TABLE outcome_trigger_fires ADD COLUMN IF NOT EXISTS item jsonb;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_otf_person_once;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_otf_person_once_outcomes
  ON outcome_trigger_fires (org_id, brand_id, offer_id, step, person_key)
  WHERE status IN ('pending', 'delivered', 'refused') AND step NOT LIKE 'act:%';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_otf_act_recent
  ON outcome_trigger_fires (org_id, brand_id, offer_id, step, person_key, occurred_at)
  WHERE step LIKE 'act:%';
