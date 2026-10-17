-- PREVIEW-CHECKS-1017 (2026-10-17): an offer's enabled qualification checks run on sample companies that are NOT
-- leads yet (the signed-out onboarding shows ~10 companies of the audience preview, then writes sample emails).
-- One row per preview run: which companies were asked about, which checks were enabled at the start (frozen), the
-- spend run, and where it stands. The verdicts themselves live where every verdict lives (qualification_verdicts,
-- keyed on question+probe and company DOMAIN), so a company that later becomes a lead is not paid for twice.
CREATE TABLE IF NOT EXISTS qualification_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  offer_id text NOT NULL,
  companies jsonb NOT NULL,
  criterion_ids text[] NOT NULL,
  run_id text,
  status text NOT NULL,
  error text,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qp_org_brand_offer ON qualification_previews (org_id, brand_id, offer_id, created_at);
