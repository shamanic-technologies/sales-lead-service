-- "Disqualified" is its OWN mark on a person, beside the step tags (owner 2026-10-13): marking a lead
-- disqualified never erases what happened with them (contacted, delivered, positive reply, website
-- visit...) and moves no step standing or step count. A yes/no mark + an OPTIONAL free note (no closed
-- reason list), who and when, at the conversation grain lead x offer x brand (offer_key '' = every
-- offer of the brand, like a timeline fact with no offer).
--
-- ONE row per (org, brand, lead, offer_key). Two writers:
--   source 'manual' = a person (staff, customer, agent through the API) set or removed it;
--   source 'reply'  = the timeline sync read a reply judged "not the right contact / left the role" and
--                     filled the note itself. It only ever writes rows still source 'reply', so a
--                     person's word (setting OR removing the mark) outranks the reply for good.
-- Removing = withdrawn_at (the row stays, the record of what was stated); setting again clears it.
-- src/lib/lead-disqualification.ts.
CREATE TABLE IF NOT EXISTS lead_disqualification_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  offer_key text NOT NULL,
  source text NOT NULL,
  source_ref text,
  note text,
  -- The lifecycle row it was stated from: attribution only, never a read key.
  lead_campaign_id uuid,
  stated_by_user_id text,
  stated_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by_user_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_ldm_key
  ON lead_disqualification_marks (org_id, brand_id, lead_id, offer_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ldm_brand_live
  ON lead_disqualification_marks (org_id, brand_id, stated_at DESC) WHERE withdrawn_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ldm_lead ON lead_disqualification_marks (lead_id);
