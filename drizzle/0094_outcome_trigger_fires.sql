-- EVERY OUTCOME A PERSON REACHES FIRES ITS OUTCOME TRIGGER (EVERY-OUTCOME-FIRES-1015, owner 2026-10-15).
-- One row per outcome reach this service recorded for a person (lead x brand x offer) and what happened to
-- its trigger at campaign-service's door. src/lib/outcome-triggers.ts.
--   - ONCE per person: a live fire (pending / delivered / refused) holds (org, brand, offer, step, person);
--     a later reach of the same person is recorded `already_fired`, nothing sent.
--   - `source_ref` names the record the reach was read off (ce:<conversion event>, crm:<fact>, fa:<act>,
--     serve:<campaign>:<lead>): one row per record and offer, so a re-sync never reads it twice.
--   - `outcome_trigger_sweep` is the detector's state: armed once at deploy (no back-fill), the crm fact cursor.
CREATE TABLE IF NOT EXISTS outcome_trigger_fires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ref text NOT NULL,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  offer_id text NOT NULL,
  step text NOT NULL,
  person_key text NOT NULL,
  lead_id uuid,
  email text,
  name text,
  phone text,
  occurred_at timestamptz,
  source text NOT NULL,
  status text NOT NULL,
  trigger_id text,
  skip_reason text,
  campaign_event_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_otf_source_offer ON outcome_trigger_fires (source_ref, offer_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_otf_person_once
  ON outcome_trigger_fires (org_id, brand_id, offer_id, step, person_key)
  WHERE status IN ('pending', 'delivered', 'refused');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_otf_due ON outcome_trigger_fires (next_attempt_at) WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS outcome_trigger_sweep (
  id text PRIMARY KEY,
  armed_at timestamptz NOT NULL,
  crm_fact_seq bigint NOT NULL,
  acts_created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
