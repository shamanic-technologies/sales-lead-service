-- WHO a person is to a brand (RELATIONSHIP-TAGS-1014, owner 2026-10-14).
--
-- A Unibox row is a LEAD of the brand: a human (human-service, the org's view) at a company
-- (`company_key` = brand-service brand id of the employer, else the lead's local organization row,
-- '' = not known yet). Relationship tags sit at their level:
--   personal                       -> org x human        (brand_id = '', company_key = '')
--   customer, prospect, team, investor, advisor, supplier, partner, other_professional
--                                  -> org x brand x lead (brand_id, human_id, company_key)
-- Three bases, additive, read with precedence person > evidence > judgment (src/lib/relationship-tags.ts):
--   evidence  : a source stated a fact (signup -> prospect, payment / sale -> customer), rewritten by the sweep
--   judgment  : Jev read the person's WHOLE merged thread and gave each tag a yes-probability
--   person    : someone of the org said yes / no (review page, MCP); withdrawable
-- When a lead's company becomes known ('' -> X) every row of the lead MOVES to X (tags carried).

-- The persons of a brand's CRM feed (bronze crm_facts person_key) and the human each one is.
CREATE TABLE IF NOT EXISTS relationship_person_humans (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  person_key text NOT NULL,
  atomic_human_id uuid,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, person_key)
);
--> statement-breakpoint
-- A human seen by an org through ITS judgment links (human-service org-scoped `same` links): the
-- canonical id that org sees. Fleet merges stay in human_aliases.
CREATE TABLE IF NOT EXISTS org_human_aliases (
  org_id text NOT NULL,
  atomic_human_id uuid NOT NULL,
  human_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, atomic_human_id)
);
--> statement-breakpoint
-- One row per lead of a brand the relationship sweep knows (the Unibox row grain).
CREATE TABLE IF NOT EXISTS relationship_subjects (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  company_key text NOT NULL DEFAULT '',
  name text,
  emails text[] NOT NULL DEFAULT '{}',
  phones text[] NOT NULL DEFAULT '{}',
  channels text[] NOT NULL DEFAULT '{}',
  person_keys text[] NOT NULL DEFAULT '{}',
  thread_seq bigint NOT NULL DEFAULT 0,
  has_messages boolean NOT NULL DEFAULT false,
  -- May a pipe stating `relationships: business_only` hand this lead out? Fail-closed (false) until decided:
  -- recomputed by the sweep and on every person's word (relationship-read.ts `recomputePolicy`).
  business_only_ok boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, human_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS relationship_evidence (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  company_key text NOT NULL DEFAULT '',
  tag text NOT NULL,
  evidence text NOT NULL,
  at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, human_id, company_key, tag)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS relationship_judgments (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  company_key text NOT NULL DEFAULT '',
  probabilities jsonb NOT NULL,
  thread_seq bigint NOT NULL,
  model text NOT NULL,
  run_id text NOT NULL,
  judged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, human_id, company_key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS relationship_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  company_key text NOT NULL DEFAULT '',
  tag text NOT NULL,
  state text NOT NULL CHECK (state IN ('yes', 'no')),
  stated_by_user_id text NOT NULL,
  stated_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  withdrawn_by_user_id text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_statements_live
  ON relationship_statements (org_id, brand_id, human_id, company_key, tag) WHERE withdrawn_at IS NULL;
--> statement-breakpoint
-- "Are these two the same person?" Jev's answer, frozen; unsure ones wait for the owner.
CREATE TABLE IF NOT EXISTS relationship_merge_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_a uuid NOT NULL,
  human_b uuid NOT NULL,
  probability double precision NOT NULL,
  reason text,
  model text NOT NULL,
  run_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'linked', 'distinct', 'rejected')),
  link_id text,
  answered_by text,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (human_a < human_b)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_merge_questions_pair
  ON relationship_merge_questions (org_id, human_a, human_b);
--> statement-breakpoint
-- The company a human works at, as this org learned it (free first, then treg). One row per org x human.
CREATE TABLE IF NOT EXISTS relationship_companies (
  org_id text NOT NULL,
  human_id uuid NOT NULL,
  company_id text,
  name text,
  domain text,
  source text,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflict boolean NOT NULL DEFAULT false,
  treg_micro bigint NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL DEFAULT now(),
  stated_by_user_id text,
  PRIMARY KEY (org_id, human_id)
);
--> statement-breakpoint
-- The relationship sweep reads a person's whole thread by its person key at the brand.
CREATE INDEX IF NOT EXISTS idx_crm_facts_brand_person ON crm_facts (org_id, brand_id, person_key);
