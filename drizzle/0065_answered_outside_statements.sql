-- "I answered this person outside the platform" (owner 2026-10-11, dashboard "Needs your call").
-- A person on the customer's side answered a prospect by hand from a mailbox none of our systems
-- read (their own Gmail), so nothing in the fleet can observe the answer. They state it; the
-- statement is a fact about the PERSON at the brand (who stated it, when), append-only.
-- src/lib/awaiting-reply.ts reads it as an answer of ours dated `stated_at`: a NEW inbound message
-- from the person dated after it puts them back among the people waiting on us.
CREATE TABLE IF NOT EXISTS answered_outside_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL,
  -- The lifecycle row the statement was made from: attribution only, never a read key.
  lead_campaign_id uuid,
  stated_by_user_id text,
  stated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_answered_outside_brand_lead
  ON answered_outside_statements (org_id, brand_id, lead_id, stated_at DESC);
