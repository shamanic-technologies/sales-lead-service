-- Bronze copy of crm-service's people fact feed (GET /internal/people/facts, crm-service#61).
--
-- crm-service says WHAT HAPPENED in the customer's own accounts (their CRM, mailbox, Stripe,
-- PostHog); this service says what it MEANS. Every fact lands here verbatim (`raw`), append-only:
-- a fact is never mutated after crm emits it, and a correction arrives as a NEW fact (`withdrawn`,
-- `person_merged`, `person_split`). The columns beside `raw` are the fields every read keys on.
-- `crm_feed_cursors` holds where the pull stopped, written in the SAME transaction as the page
-- it read, so a crash replays a page at worst (and `fact_id` makes that a no-op).
CREATE TABLE IF NOT EXISTS crm_facts (
  fact_id text PRIMARY KEY,
  seq bigint NOT NULL,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  person_key text NOT NULL,
  source_contact_id text,
  full_name text,
  emails text[] NOT NULL,
  phones text[] NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz,
  date_basis text NOT NULL,
  source text NOT NULL,
  source_ref text NOT NULL,
  payload jsonb NOT NULL,
  withdrawn_of text,
  raw jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_facts_seq ON crm_facts (seq);
CREATE INDEX IF NOT EXISTS idx_crm_facts_brand_contact ON crm_facts (org_id, brand_id, source_contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_facts_withdrawn_of ON crm_facts (withdrawn_of) WHERE withdrawn_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_feed_cursors (
  feed text PRIMARY KEY,
  cursor text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
