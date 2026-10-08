-- Silver: every FACT on a person's timeline, labelled, at the lead x offer x brand grain
-- (src/lib/timeline-labels.ts names the vocabulary, src/lib/timeline-facts.ts writes it).
--
-- Owner rule 2026-10-08: a label is a fact independent of the campaign and of the channel it came
-- by (our outreach, the customer's CRM, a person stating it), stored with whether it is
-- attributable to us. `campaign_id` is attribution only; `offer_id` NULL = a fact about the person
-- at the brand, true on every offer page of it. One row per source fact: `id` = source:source_ref,
-- so re-reading a source rewrites the same row. A fact its source takes back is kept with
-- `withdrawn_at`, never deleted.
CREATE TABLE IF NOT EXISTS lead_timeline_facts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  offer_id text,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id text,
  occurred_at timestamptz,
  label text NOT NULL,
  source text NOT NULL,
  source_ref text NOT NULL,
  attributable boolean,
  attribution_basis text,
  url text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  withdrawn_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ltf_brand_lead ON lead_timeline_facts (org_id, brand_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_ltf_brand_source ON lead_timeline_facts (org_id, brand_id, source);
