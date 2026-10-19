-- HOT-LEAD-PROPOSAL-1019 (owner 2026-10-19): each time a person NEWLY becomes a hot lead of a brand (lead yes AND
-- wants business yes, relationship-intent.ts), lead-service reports it ONCE through campaign-service's trigger door.
-- `hot_lead_states`: the last hot answer seen per relation (the Unibox grain: human x company); `episode` counts the
-- times the person BECAME hot (hot -> not -> hot = a new fact, a new episode).
CREATE TABLE IF NOT EXISTS hot_lead_states (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  company_key text NOT NULL DEFAULT '',
  hot boolean NOT NULL,
  episode integer NOT NULL DEFAULT 0,
  hot_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, human_id, company_key)
);
--> statement-breakpoint
-- A brand's first pass only records who is hot already (no history back-fill): `armed_at` = from when a change fires.
CREATE TABLE IF NOT EXISTS hot_lead_brands (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  armed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id)
);
--> statement-breakpoint
-- What each new fact did: one row per (relation, episode, offer) the door is rung for, or one `skipped` row (offer '')
-- naming why nothing was sent (own_team, staff, offer_unknown). Written BEFORE anything is sent.
CREATE TABLE IF NOT EXISTS hot_lead_fires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  company_key text NOT NULL DEFAULT '',
  episode integer NOT NULL,
  offer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'refused', 'skipped')),
  skip_reason text,
  idempotency_key text,
  payload jsonb NOT NULL,
  trigger_id text,
  campaign_event_id text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (org_id, brand_id, human_id, company_key, episode, offer_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hot_lead_fires_pending ON hot_lead_fires (org_id, brand_id, next_attempt_at) WHERE status = 'pending';
