-- A serve that NAMES its person (LEAD-NAMED-SERVE-1015, src/lib/named-lead-serve.ts): a trigger occurrence names a lead
-- of the campaign, the cold workflow's serve hands out exactly that person.
--   named_lead_serves: one row per (campaign, lead, occurrence) handed out, with what the sender held for the person at
--     the FIRST hand-out (baseline). A redelivered run of the same occurrence is refused once the sender holds more
--     than the baseline (an email went out or is queued for it), served again otherwise (the run failed before sending).
--   named_lead_enrichments: the ONE paid enrichment of a lead known only by an email (treg people.enrich), per lead ever.
CREATE TABLE IF NOT EXISTS named_lead_serves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  campaign_id text NOT NULL,
  lead_id uuid NOT NULL,
  lead_campaign_id uuid NOT NULL,
  trigger_event_id text NOT NULL,
  first_served_at timestamptz NOT NULL DEFAULT now(),
  last_served_at timestamptz NOT NULL DEFAULT now(),
  serve_count integer NOT NULL DEFAULT 1,
  last_run_id text,
  baseline_sent_count integer,
  baseline_contacted boolean,
  refused_code text,
  refused_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nls_occurrence ON named_lead_serves (campaign_id, lead_id, trigger_event_id);
CREATE INDEX IF NOT EXISTS idx_nls_org_brand ON named_lead_serves (org_id, brand_id);

CREATE TABLE IF NOT EXISTS named_lead_enrichments (
  lead_id uuid PRIMARY KEY,
  paid_by_org_id text NOT NULL,
  run_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  found boolean NOT NULL,
  charged_micro integer NOT NULL,
  served_by text,
  output jsonb
);
