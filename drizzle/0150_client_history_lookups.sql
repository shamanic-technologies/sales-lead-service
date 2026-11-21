-- BRAND-PROOF-LOGOS-1121: a paying client's career looked up once (treg people.enrich -> linkedin.user.profile), keyed on
-- the LEAD (a person's career is the person's, not the org's). One row per lead; a non-finding lookup is asked again after
-- 90 days (client-past-employers-read.ts). The roles found are written to leads_organizations, never here.
CREATE TABLE IF NOT EXISTS client_history_lookups (
  lead_id uuid PRIMARY KEY,
  paid_by_org_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('history_found', 'no_linkedin', 'no_experience', 'profile_unreadable')),
  linkedin_url text,
  roles_found integer NOT NULL DEFAULT 0,
  charged_micro bigint NOT NULL DEFAULT 0,
  served_by text,
  looked_up_at timestamptz NOT NULL DEFAULT now()
);
