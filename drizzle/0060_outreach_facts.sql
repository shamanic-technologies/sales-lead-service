-- Bronze copy of instantly-service's outreach fact feed (GET /internal/outreach-facts,
-- instantly-service#1022): every email we sent, every open, click, bounce, unsubscribe and reply
-- with its verdict, one fact per thing, append-only. A correction is a NEW fact naming the one it
-- supersedes (`supersedes_seq`); readers keep the latest fact per `subject_key`. Copied verbatim
-- (`raw`); the columns beside it are the fields every read keys on. The cursor lives in
-- crm_feed_cursors under feed 'outreach_facts', written in the same transaction as its page.
CREATE TABLE IF NOT EXISTS outreach_facts (
  seq bigint PRIMARY KEY,
  subject_key text NOT NULL,
  supersedes_seq bigint,
  type text NOT NULL,
  occurred_at timestamptz,
  lead_email text NOT NULL,
  org_id text NOT NULL,
  campaign_id text,
  brand_ids text[] NOT NULL,
  raw jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outreach_facts_subject ON outreach_facts (subject_key, seq DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_facts_org_brands ON outreach_facts USING gin (brand_ids);
CREATE INDEX IF NOT EXISTS idx_outreach_facts_org_email ON outreach_facts (org_id, lead_email);
