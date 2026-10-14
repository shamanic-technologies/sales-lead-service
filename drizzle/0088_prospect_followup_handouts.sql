-- NEVER-NO-FOLLOWUP-1014 (owner 2026-10-14): every pure prospect a brand contacted always has a next follow-up.
-- The "contacted pure prospects" source pipe hands each person to that population AT MOST ONCE per brand, ever:
-- after the first follow-up the reactive pipe (campaign-service's dated occurrence per person) carries them, so a
-- second series of follow-ups for one person is never started. One row per (org, brand, lead), written in the SAME transaction as
-- the source's find row (`lead_campaign_id`), never deleted. src/lib/prospect-followup.ts.
CREATE TABLE IF NOT EXISTS prospect_followup_handouts (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_campaign_id text NOT NULL,
  lead_campaign_id uuid NOT NULL,
  handed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, lead_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_pfh_lead_campaign ON prospect_followup_handouts (lead_campaign_id);
--> statement-breakpoint
-- The contacted-population walk reads live sends per (org, brand) newest-label first.
CREATE INDEX IF NOT EXISTS idx_ltf_brand_label_live ON lead_timeline_facts (org_id, brand_id, label) WHERE withdrawn_at IS NULL;
