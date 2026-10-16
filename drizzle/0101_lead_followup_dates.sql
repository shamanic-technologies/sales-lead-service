-- LEAD-FOLLOWUP-DATE-1016 (owner 2026-10-16: "il faut que 100% des leads aient par design une followup date. Default
-- can be now() if any."). ONE next follow-up date per (org, brand, lead): who the brand follows up next, and when.
-- Written only by src/lib/lead-followup-date.ts: a default (now) for every lead of the brand, moved by every send we
-- observe (outreach_facts email sends, crm_facts message_out on any Unibox channel), stated by a writer, pushed out by
-- the "Lead follow-up due" serve's verdict. `next_followup_at` is NULL only when a person's word stopped the follow-ups.
CREATE TABLE IF NOT EXISTS lead_followup_dates (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  next_followup_at timestamptz,
  basis text NOT NULL CHECK (basis IN ('default', 'send', 'stated', 'served', 'not_yet', 'stop_recheck', 'stopped')),
  reason text,
  stated_by_campaign_id text,
  stated_at timestamptz,
  stated_run_id text,
  stopped_at timestamptz,
  last_sent_at timestamptz,
  last_sent_channel text,
  sent_count integer NOT NULL DEFAULT 0,
  last_served_at timestamptz,
  served_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, lead_id),
  CHECK ((next_followup_at IS NULL) = (basis = 'stopped'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lfd_due ON lead_followup_dates (org_id, brand_id, next_followup_at) WHERE next_followup_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lfd_lead ON lead_followup_dates (lead_id);
--> statement-breakpoint
-- Every hand-out of the "Lead follow-up due" population: one row per serve (repeatable, never once-ever). Open (not
-- handed, not set aside) = the person sits in the source's stock; `handed_at` = the follow-up pipe took them.
CREATE TABLE IF NOT EXISTS lead_followup_due_serves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_campaign_id text NOT NULL,
  lead_campaign_id uuid NOT NULL REFERENCES leads_campaigns(id) ON DELETE CASCADE,
  due_at timestamptz,
  served_at timestamptz NOT NULL DEFAULT now(),
  handed_at timestamptz,
  handed_to_campaign_id text,
  handed_lead_campaign_id uuid,
  set_aside_at timestamptz,
  set_aside_reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lfds_row ON lead_followup_due_serves (lead_campaign_id);
--> statement-breakpoint
-- The outreach row a round was handed on: never re-served by the paid-pool retry (the next round comes from the date).
CREATE INDEX IF NOT EXISTS idx_lfds_handed_row ON lead_followup_due_serves (handed_lead_campaign_id) WHERE handed_lead_campaign_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lfds_open ON lead_followup_due_serves (org_id, brand_id, lead_id) WHERE handed_at IS NULL AND set_aside_at IS NULL;
--> statement-breakpoint
-- Which send feeds the dates have read (own cursors: never the crm_feed_cursors the copies themselves keep).
CREATE TABLE IF NOT EXISTS lead_followup_date_cursors (
  feed text PRIMARY KEY,
  cursor bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A due serve re-opens a source row and an outreach row for the next round: the run now holding them is recorded.
ALTER TABLE lead_campaign_run_repoints DROP CONSTRAINT IF EXISTS lead_campaign_run_repoints_cause_check;
--> statement-breakpoint
ALTER TABLE lead_campaign_run_repoints ADD CONSTRAINT lead_campaign_run_repoints_cause_check CHECK (cause IN ('retry_claim', 'named_serve', 'followup_due'));
