-- FACTORY-P2-CONTENT-OUTCOMES (owner 2026-10-28): a visit that came from one of our published posts (its link carries
-- `dy_post=<subjectService>:<subjectId>`) is declared ONCE per (org, brand, lead, post) on a spend-free run of its own,
-- producing `website_visit` (the lead) and consuming the post's `post_published` (src/lib/post-touch.ts).
-- The row is the claim: `claimed` (run not opened or declaration not taken yet: asked again next pass), `delivered`,
-- `queued` (runs-service did not take it now, run_outcome_outbox redelivers), `refused` (kept, loud, never re-sent).
CREATE TABLE IF NOT EXISTS post_touch_declarations (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL,
  post_subject_service text NOT NULL,
  post_subject_id text NOT NULL,
  visit_fact_id text NOT NULL,
  visited_at timestamptz,
  run_id uuid,
  status text NOT NULL DEFAULT 'claimed',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, lead_id, post_subject_service, post_subject_id)
);
--> statement-breakpoint
-- Our first touch (first-touch.ts) and the signup's evidence (outcome-fact-declarations.ts) read a lead's declared
-- post touches by (org, brand, lead).
CREATE INDEX IF NOT EXISTS idx_ptd_lead ON post_touch_declarations (org_id, brand_id, lead_id, visited_at)
  WHERE status IN ('delivered', 'queued');
--> statement-breakpoint
-- A post visit we could not credit to ONE lead (several leads of the brand hold its emails): why, kept per visit fact.
CREATE TABLE IF NOT EXISTS post_touch_skips (
  visit_fact_id text PRIMARY KEY,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  reason text NOT NULL,
  lead_ids text[] NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
