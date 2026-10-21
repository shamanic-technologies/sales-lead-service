-- LEADS-JUDGE-BRAND-1021: who becomes and stays a brand's lead, and what counts as an action of theirs.
-- 1. A relationship judgment remembers the brand card (name, domain, every offer's name + what it offers) it read,
--    so a lead judged on the name alone is asked again with the offers.
ALTER TABLE relationship_judgments ADD COLUMN IF NOT EXISTS context_hash text;
--> statement-breakpoint
-- 2. Every act of theirs read off crm-service's fact copy, per lead it names (their-acts.ts). Which ones COUNT is
--    re-derived on every pass (crm-service's verdict on the conversation, "a person or a machine?").
CREATE TABLE IF NOT EXISTS lead_crm_acts (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL,
  fact_id text NOT NULL,
  type text NOT NULL,
  contact_point text,
  at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, lead_id, fact_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_crm_acts_fact ON lead_crm_acts (fact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_crm_acts_point ON lead_crm_acts (org_id, brand_id, contact_point);
--> statement-breakpoint
-- 3. Jev's answer per inbound message: did a person write it, or a machine (an out-of-office...)? Frozen per fact.
CREATE TABLE IF NOT EXISTS crm_act_judgments (
  fact_id text PRIMARY KEY,
  automated boolean NOT NULL,
  probability double precision NOT NULL,
  model text NOT NULL,
  judged_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- 4. Walk crm-service's copy again for acts of theirs, so every act ever recorded lands in lead_crm_acts. Until a
--    pass re-derives it, last_action_at is unknown: nobody counts as having acted (fail closed for a re-serve).
DELETE FROM lead_followup_date_cursors WHERE feed = 'crm_facts:theirs';
--> statement-breakpoint
UPDATE lead_followup_dates SET last_action_at = NULL WHERE last_action_at IS NOT NULL;
