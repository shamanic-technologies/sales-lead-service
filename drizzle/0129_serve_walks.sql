-- FACTORY-RECORD-SERVE-1028: the WALK of every buffer/next serve (who was looked at, in order, and what decided each:
-- served, or skipped with the check that skipped them and its inputs), stored with the serve so anyone can replay it
-- (src/lib/serve-walk-rules.ts) and get the served person. Read-only for staff (GET /internal/serve-walks), ids only,
-- kept SERVE_WALK_RETENTION_DAYS (90) then deleted by the background sweep. A record of what happened under the org
-- that served: not moved by a brand transfer.
CREATE TABLE IF NOT EXISTS serve_walks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  campaign_id text NOT NULL,
  caller_run_id text,
  serve_run_id text,
  mode text NOT NULL,
  found boolean,
  reason text,
  served_lead_id uuid,
  error text,
  context jsonb NOT NULL,
  steps jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_serve_walks_campaign ON serve_walks (campaign_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_serve_walks_serve_run ON serve_walks (serve_run_id);
CREATE INDEX IF NOT EXISTS idx_serve_walks_caller_run ON serve_walks (caller_run_id);
CREATE INDEX IF NOT EXISTS idx_serve_walks_created ON serve_walks (created_at);
