-- A person the brand's OWN organization names to us (PUSHED-PERSON-KNOWN-1014, owner 2026-10-14).
--
-- The named-person door (`POST /orgs/campaigns/:id/leads/by-email`) files only people the brand
-- KNOWS: a live fact of its CRM copy, or a lead already filed under the brand. A client that
-- reports a trigger occurrence about a person (by identity) for its own brand, authenticated with
-- its own key, STATES that it knows them: that statement is the evidence, recorded here, append-only.
-- One row per (org, brand, address, source, source_ref): a retried filing of the same occurrence
-- writes nothing new. Once stated, the person reads as known to the brand for every later filing.
-- src/lib/named-person.ts.
CREATE TABLE IF NOT EXISTS brand_person_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  -- Canonical (trimmed, lowercased).
  email text NOT NULL,
  -- What carried the statement: 'trigger_event' (campaign-service's trigger door).
  source text NOT NULL,
  -- The caller's own id for it (the trigger event id), never interpreted.
  source_ref text NOT NULL,
  trigger_id text,
  -- The campaign the filing was for: attribution only, never a read key.
  campaign_id text NOT NULL,
  full_name text,
  stated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_bps_key
  ON brand_person_statements (org_id, brand_id, email, source, source_ref);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bps_brand_email ON brand_person_statements (org_id, brand_id, email);
