-- Qualification criteria: whether a lead's COMPANY meets a business condition the client cares
-- about (site slow on mobile, hiring support staff, active on LinkedIn...). One criterion = one
-- probe from a fixed catalogue + one yes/no question (src/lib/qualification-probes.ts).
CREATE TABLE IF NOT EXISTS qualification_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  question text NOT NULL,
  probe jsonb NOT NULL,
  -- mention = the evidence is offered to the email writer, nobody is dropped;
  -- must_pass = a company failing it is not worth its reveal.
  mode text NOT NULL,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qc_org_brand ON qualification_criteria (org_id, brand_id) WHERE archived_at IS NULL;
--> statement-breakpoint
-- What a probe SAW on a company domain. Keyed on the probe and the domain, never the lead, org or
-- brand: one paid observation serves every lead at that company, for every client, while fresh.
CREATE TABLE IF NOT EXISTS qualification_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_key text NOT NULL,
  domain text NOT NULL,
  status text NOT NULL,
  reason text,
  endpoint_id text,
  -- What the judge reads: page text, a provider answer, or a vision description of a screenshot.
  content text,
  image_url text,
  vendor_cost_micro integer NOT NULL DEFAULT 0,
  run_id text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qo_probe_domain ON qualification_observations (probe_key, domain, observed_at DESC);
--> statement-breakpoint
-- The judgment of ONE question on ONE observation, frozen with the model release that made it
-- (same doctrine as crm_pairing_judgments). Keyed on the question+probe identity and the domain.
CREATE TABLE IF NOT EXISTS qualification_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  criterion_key text NOT NULL,
  domain text NOT NULL,
  observation_id uuid NOT NULL REFERENCES qualification_observations(id) ON DELETE CASCADE,
  verdict text NOT NULL,
  yes_probability double precision,
  reason text,
  evidence text,
  judgment_model text,
  run_id text,
  judged_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_qv_key_observation ON qualification_verdicts (criterion_key, observation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qv_key_domain ON qualification_verdicts (criterion_key, domain, judged_at DESC);
--> statement-breakpoint
-- The last suggested list for a brand, so reading it again is not paid again.
CREATE TABLE IF NOT EXISTS qualification_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  suggestions jsonb NOT NULL,
  run_id text,
  generated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qs_org_brand ON qualification_suggestions (org_id, brand_id, generated_at DESC);
