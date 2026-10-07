-- The pre-pay audience screen, now decided here (owner 2026-10-07: qualification is lead-service's).
-- One verdict per (audience, person, target text, prompt version): a candidate offered again after a
-- crash is not judged or billed twice. Every decision on a candidate (screen, must-pass check) is
-- recorded, so why a person was declined or revealed is readable later.
CREATE TABLE IF NOT EXISTS candidate_screenings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  audience_id text NOT NULL,
  provider_person_id text NOT NULL,
  candidate_id text NOT NULL,
  target_hash text NOT NULL,
  target_text text,
  prompt_version text NOT NULL,
  verdict text NOT NULL,
  yes_probability double precision,
  reason text,
  model text,
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_audience_person_target ON candidate_screenings (audience_id, provider_person_id, target_hash, prompt_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cs_org_brand ON candidate_screenings (org_id, brand_id, created_at DESC);
